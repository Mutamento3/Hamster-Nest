-- Claude-only relay. Default daily: deployment alone cannot enable scheduling.
alter table public.cli_wake_schedule drop constraint cli_wake_schedule_kind_check;
alter table public.cli_wake_schedule add constraint cli_wake_schedule_kind_check check (kind in ('random','alarm','relay'));
alter table public.cli_wake_schedule add constraint cli_wake_relay_role check(kind<>'relay' or role='claude_code_cli_syzygy');
alter table public.cli_wake_schedule drop constraint cli_wake_schedule_user_id_role_local_date_kind_key;
create unique index cli_wake_daily_once on public.cli_wake_schedule(user_id,role,local_date,kind) where kind in ('random','alarm');
create unique index cli_wake_relay_active_once on public.cli_wake_schedule(user_id,role) where kind='relay' and status in ('planned','queued','running');
alter table public.cli_wake_schedule add column next_wake_at timestamptz, add column next_note text not null default '', add column close_day boolean not null default false,
 add column predecessor_id uuid references public.cli_wake_schedule(id), add column decision_source text not null default 'random' check(decision_source in ('random','model')),
 add column share_message_id uuid references public.messages(id), add column summary_missing boolean;
create unique index cli_wake_relay_successor_once on public.cli_wake_schedule(predecessor_id) where predecessor_id is not null;
create table public.cli_activity_settings (
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role='claude_code_cli_syzygy'),
 mode text not null default 'daily' check(mode in ('daily','relay')),
 updated_at timestamptz not null default now(), primary key(user_id,role)
);
alter table public.cli_activity_settings enable row level security;
revoke all on public.cli_activity_settings from public,anon,authenticated;
grant select on public.cli_activity_settings to authenticated;
grant all on public.cli_activity_settings to service_role;
create policy cli_activity_settings_read_own on public.cli_activity_settings for select to authenticated using ((select auth.uid())=user_id);

-- Operational switch, machine-only. Running work finishes; queued commands are retired atomically.
create function public.cli_activity_set_mode(p_user uuid,p_mode text) returns jsonb language plpgsql set search_path='' as $$
declare d date := (now() at time zone 'Asia/Shanghai')::date;
begin
 if p_mode not in ('daily','relay') then raise exception 'invalid activity mode'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||d::text,0));
 insert into public.cli_activity_settings(user_id,role,mode) values(p_user,'claude_code_cli_syzygy',p_mode)
 on conflict(user_id,role) do update set mode=excluded.mode,updated_at=now();
 with cancelled as (
  update public.cli_wake_schedule set status='cancelled',skip_reason='mode_changed',completed_at=now()
  where user_id=p_user and role='claude_code_cli_syzygy' and status in ('planned','queued')
    and ((p_mode='daily' and kind='relay') or (p_mode='relay' and kind in ('random','alarm')))
  returning command_id
 ) update public.syzygy_commands set status='failed',error_message='activity mode changed',completed_at=now()
   where user_id=p_user and id in(select command_id from cancelled) and status in ('pending','running');
 return jsonb_build_object('mode',p_mode);
end; $$;
create or replace function public.cli_wake_slot_available(p_user uuid,p_role text,p_at timestamptz,p_kind text,p_exclude uuid default null)
returns boolean language sql stable set search_path='' as $$
 select (p_kind<>'relay' or not exists(select 1 from public.cli_wake_schedule busy where busy.user_id=p_user and busy.role=p_role and busy.status='running' and busy.id is distinct from p_exclude))
 and (p_kind<>'relay' or (p_at at time zone 'Asia/Shanghai')::time between time '09:00' and time '21:00')
 and date_trunc('minute',p_at at time zone 'Asia/Shanghai')::time between
   case when p_kind='random' then time '13:00' else time '09:00' end and
   case when p_kind='random' then time '19:00' else time '21:00' end
 and not exists(select 1 from public.cli_wake_schedule w
   left join public.cli_wake_schedule current_wake on current_wake.id=p_exclude
     and current_wake.user_id=p_user and current_wake.role=p_role
     and current_wake.status in ('planned','queued')
   where w.user_id=p_user
   and w.local_date=(p_at at time zone 'Asia/Shanghai')::date and w.id is distinct from p_exclude
   and (w.status not in ('skipped','cancelled') or w.started_at is not null)
   and abs(extract(epoch from (coalesce(case when p_kind='relay' and w.role=p_role then w.completed_at end,w.started_at,w.wake_at)-case
     -- Only dispatch rechecks within the existing two-minute start window use
     -- the reserved spacing against a later, unstarted plan. Actual starts
     -- always retain strict spacing; the later plan waits in dispatch below.
     when w.started_at is null and w.wake_at>current_wake.wake_at
       and p_at between current_wake.wake_at and current_wake.wake_at+interval '2 minutes'
     then current_wake.wake_at else p_at end))) < case when w.role=p_role then case when p_kind='relay' then 600 else 3600 end else 1800 end)
 and not exists(select 1 from public.prompt_templates t
   where t.user_id=p_user and t.active and t.name like 'machine_job_%'
   and t.content::jsonb->>'targetRole'=p_role
   and (t.content::jsonb->'daysOfWeek'='null'::jsonb or t.content::jsonb->'daysOfWeek' @> to_jsonb(extract(dow from p_at at time zone 'Asia/Shanghai')::int))
   and abs(extract(epoch from (p_at-(((p_at at time zone 'Asia/Shanghai')::date + make_time((t.content::jsonb->>'hour')::int,coalesce((t.content::jsonb->>'minute')::int,0),0)) at time zone 'Asia/Shanghai'))))<3600);
$$;

create or replace function public.cli_wake_plan_day(p_user uuid,p_date date)
returns void language plpgsql set search_path='' as $$
declare r text; candidate timestamptz; offset_min integer; i integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||p_date::text,0));
 foreach r in array array['codex_cli_syzygy','claude_code_cli_syzygy'] loop
  if exists(select 1 from public.cli_activity_settings where user_id=p_user and role=r and mode='relay') then continue; end if;
  if exists(select 1 from public.cli_wake_schedule where user_id=p_user and role=r and local_date=p_date and kind='random') then continue; end if;
  offset_min := (('x'||substr(md5(p_user::text||r||p_date::text),1,8))::bit(32)::bigint % 361)::int;
  for i in 0..360 loop
   candidate := (p_date+time '13:00'+make_interval(mins=>(offset_min+i)%361)) at time zone 'Asia/Shanghai';
   if public.cli_wake_slot_available(p_user,r,candidate,'random') then
    insert into public.cli_wake_schedule(user_id,role,local_date,kind,wake_at) values(p_user,r,p_date,'random',candidate);
    exit;
   end if;
  end loop;
 end loop;
end; $$;


-- Tick owns continuation, including after skips and runtime recovery. No next-day reservation.
create function public.cli_relay_plan(p_user uuid,p_roles jsonb,p_paused boolean) returns void language plpgsql set search_path='' as $$
declare d date := (now() at time zone 'Asia/Shanghai')::date; last_w public.cli_wake_schedule; candidate timestamptz; base timestamptz; chosen text:='random'; i integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||d::text,0));
 if p_paused or not coalesce((p_roles->'claude_code_cli_syzygy'->>'enabled')::boolean,false)
 or not exists(select 1 from public.cli_activity_settings where user_id=p_user and mode='relay')
 or (now() at time zone 'Asia/Shanghai')::time not between time '09:00' and time '21:00'
 or exists(select 1 from public.cli_wake_schedule where user_id=p_user and role='claude_code_cli_syzygy' and status in ('planned','queued','running'))
 or exists(select 1 from public.cli_wake_schedule where user_id=p_user and role='claude_code_cli_syzygy' and local_date=d and close_day)
 or (select count(*) from public.cli_wake_schedule where user_id=p_user and role='claude_code_cli_syzygy' and local_date=d and kind='relay' and started_at is not null)>=30 then return; end if;
 select * into last_w from public.cli_wake_schedule where user_id=p_user and role='claude_code_cli_syzygy' and local_date=d order by coalesce(completed_at,wake_at) desc,created_at desc limit 1;
 base:=greatest(now(),coalesce(last_w.completed_at,now()));
 if last_w.next_wake_at>=base+interval '10 minutes' and public.cli_wake_slot_available(p_user,'claude_code_cli_syzygy',last_w.next_wake_at,'relay') then
  candidate:=last_w.next_wake_at; chosen:='model';
 else
  candidate:=base+make_interval(mins=>10+floor(random()*51)::int);
  -- A fixed-job exclusion can occupy the whole random range. Find the first safe minute after it.
  for i in 0..720 loop
   exit when (candidate at time zone 'Asia/Shanghai')::date<>d or (candidate at time zone 'Asia/Shanghai')::time>time '21:00';
   exit when public.cli_wake_slot_available(p_user,'claude_code_cli_syzygy',candidate,'relay');
   candidate:=candidate+interval '1 minute';
  end loop;
 end if;
 if (candidate at time zone 'Asia/Shanghai')::date=d and public.cli_wake_slot_available(p_user,'claude_code_cli_syzygy',candidate,'relay') then
  insert into public.cli_wake_schedule(user_id,role,local_date,kind,wake_at,note,predecessor_id,decision_source)
  values(p_user,'claude_code_cli_syzygy',d,'relay',candidate,coalesce(last_w.next_note,''),last_w.id,chosen);
 end if;
end; $$;

-- Null time means close today. A later direct conversation cannot reopen a closed day.
create function public.cli_relay_set_next(p_user uuid,p_task uuid,p_at timestamptz default null,p_note text default '') returns jsonb language plpgsql set search_path='' as $$
declare w public.cli_wake_schedule; d date := (now() at time zone 'Asia/Shanghai')::date;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||d::text,0));
 select w0.* into w from public.cli_wake_schedule w0 join public.agent_tasks t on t.id=w0.task_id and t.user_id=w0.user_id
 where w0.user_id=p_user and w0.task_id=p_task and w0.role='claude_code_cli_syzygy' and w0.kind='relay' and w0.status='running'
 and t.status='running' and t.payload_json->>'target_role'=w0.role for update of w0;
 if not found then raise exception 'current running relay task required'; end if;
 if w.close_day then return jsonb_build_object('ok',true,'day_closed',true); end if;
 if p_at is not null and ((p_at at time zone 'Asia/Shanghai')::date<>d or p_at<now()+interval '10 minutes' or not public.cli_wake_slot_available(p_user,w.role,p_at,'relay',w.id)) then
  return jsonb_build_object('ok',false,'reason','time_conflict','minimum',now()+interval '10 minutes');
 end if;
 update public.cli_wake_schedule set next_wake_at=p_at,next_note=left(coalesce(p_note,''),2000),close_day=p_at is null where id=w.id;
 return jsonb_build_object('ok',true,'next_wake_at',p_at,'day_closed',p_at is null);
end; $$;
create or replace function public.cli_wake_dispatch(p_user uuid,p_roles jsonb,p_paused boolean default false,p_wake uuid default null,p_command uuid default null,p_task uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare d date := (now() at time zone 'Asia/Shanghai')::date; w public.cli_wake_schedule; why text; chatting boolean; n integer:=0; cid uuid; key text; next_at timestamptz;
begin
 perform public.cli_wake_plan_day(p_user,d);
 for w in select * from public.cli_wake_schedule where user_id=p_user and
   ((p_wake is null and ((status='planned' and wake_at<=now()) or (status='queued' and wake_at<now()-interval '2 minutes'))) or (id=p_wake and status='queued' and command_id=p_command))
   order by wake_at for update loop
  why := null;
  if w.local_date<>d or now()>w.wake_at+interval '2 minutes' then why:='missed_window';
  elsif w.kind='relay' and not exists(select 1 from public.cli_activity_settings where user_id=p_user and mode='relay') then why:='mode_changed';
  elsif p_paused then why:='paused';
  elsif coalesce((p_roles->w.role->>'enabled')::boolean,false)=false then why:='runtime_offline';
  elsif not public.cli_wake_slot_available(p_user,w.role,now(),w.kind,w.id) then
   -- A preceding activity can start a few seconds after its reservation.
   -- Keep this plan pending until the next tick only if the real separation
   -- fits inside its original start window. Do not move wake_at or consume
   -- the separate 30-minute chat postponement, and never replay expired work.
   select max(other.started_at+case when other.role=w.role then case when w.kind='relay' then interval '10 minutes' else interval '1 hour' end else interval '30 minutes' end)
     into next_at from public.cli_wake_schedule other
     where other.user_id=p_user and other.local_date=d and other.id<>w.id
       and other.started_at is not null and other.started_at<=now();
   if p_wake is null and w.status='planned' and next_at>now()
     and next_at<=w.wake_at+interval '2 minutes'
     and public.cli_wake_slot_available(p_user,w.role,next_at,w.kind,w.id) then
    continue;
   end if;
   why:='time_conflict';
  end if;
  select exists(
   select 1 from public.messages m join public.sessions s on s.id=m.session_id and s.user_id=m.user_id
   where m.user_id=p_user and m.role='user' and m.created_at>now()-interval '20 minutes'
   and (
    (s.conversation_kind='direct' and s.conversation_profile_key=case when w.role='codex_cli_syzygy' then 'codex_cli' else 'claude_cli' end)
    or (s.conversation_kind='group' and s.handler='router' and m.sender_key='chuanchuan'
      and m.target_sender_keys @> array[case when w.role='codex_cli_syzygy' then 'codex_cli' else 'claude_cli' end])
   )
  ) into chatting;
  if why is null and chatting then
   next_at:=w.wake_at+interval '30 minutes';
   if w.kind<>'relay' and not w.delayed and public.cli_wake_slot_available(p_user,w.role,next_at,w.kind,w.id) then
    update public.cli_wake_schedule set wake_at=next_at,delayed=true,status='planned',command_id=null where id=w.id;
    continue;
   end if;
   why := case when w.kind='relay' then 'chatting' when w.delayed then 'chatting_after_delay' else 'delay_conflict' end;
  end if;
  if why is not null then
   update public.cli_wake_schedule set status='skipped',skip_reason=why,completed_at=now() where id=w.id;
   update public.syzygy_commands set status='failed',completed_at=now(),error_message=why where id=w.command_id and user_id=p_user and status in ('pending','running');
   continue;
  end if;
  if p_wake is not null then
   if not exists(select 1 from public.agent_tasks where id=p_task and user_id=p_user and status='running' and payload_json->>'target_role'=w.role) then raise exception 'matching running task required'; end if;
   update public.cli_wake_schedule set status='running',task_id=p_task,started_at=now(),deadline=least(now()+case when w.kind='relay' then interval '30 minutes' else interval '1 hour' end,(d+case when w.kind='relay' then time '21:30' when w.kind='random' then time '20:00' else time '22:00' end) at time zone 'Asia/Shanghai') where id=w.id returning * into w;
   return to_jsonb(w);
  end if;
  key := 'free-activity:'||w.id::text||':'||w.delayed::text;
  insert into public.syzygy_commands(user_id,command_type,status,idempotency_key,payload)
  values(p_user,'run_task','pending',key,jsonb_build_object('target_role',w.role,'source','free_activity','task_type','free_activity','wake_id',w.id,'wake_kind',w.kind,'auto_wake',false,'task_content',case when w.kind='relay' then '接力自由活动：按指南自主选择；有事做就分享进私聊，每轮留一句执行摘要。' else '自由活动：按云端指南和菜单自主选择，结束前写日记。' end,'idempotency_key',key))
  on conflict(user_id,idempotency_key) where idempotency_key is not null do update set idempotency_key=excluded.idempotency_key returning id into cid;
  update public.cli_wake_schedule set status='queued',command_id=cid where id=w.id;
  n:=n+1;
 end loop;
 if p_wake is null then perform public.cli_relay_plan(p_user,p_roles,p_paused); end if;
 return case when p_wake is null then jsonb_build_object('scheduled',n) else null end;
end; $$;

create or replace function public.cli_wake_finish(p_user uuid,p_wake uuid,p_task uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql set search_path='' as $$
declare w public.cli_wake_schedule; missing boolean;
begin
 if p_status not in ('completed','failed','cancelled') then raise exception 'invalid finish status'; end if;
 select * into w from public.cli_wake_schedule where user_id=p_user and id=p_wake and task_id=p_task for update;
 if not found then return null; end if;
 if w.status<>'running' then return jsonb_build_object('source',w.kind,'wake_id',w.id,'diary_missing',w.diary_missing); end if;
 select not exists(select 1 from public.diary_entries where user_id=p_user and author=replace(w.role,'_syzygy','') and case when w.kind='relay' then entry_date=w.local_date and activity_type='free_activity' else metadata->>'task_id'=p_task::text end) into missing;
 update public.cli_wake_schedule set status=p_status,skip_reason=p_reason,diary_missing=missing,summary_missing=not exists(select 1 from public.agent_tasks where id=p_task and nullif(btrim(result_summary),'') is not null and result_summary not like '% started'),completed_at=now() where id=w.id;
 return jsonb_build_object('source',w.kind,'wake_id',w.id,'started_at',w.started_at,'deadline',w.deadline,'ended_at',now(),'duration_seconds',extract(epoch from now()-w.started_at),'end_reason',coalesce(p_reason,p_status),'diary_missing',missing);
end; $$;


-- One real assistant message and one ordinary push event for each wake.
create function public.cli_relay_share(p_user uuid,p_task uuid,p_wake uuid,p_content text) returns jsonb language plpgsql set search_path='' as $$
declare w public.cli_wake_schedule; sid uuid; mid uuid;
begin
 select * into w from public.cli_wake_schedule where user_id=p_user and id=p_wake and task_id=p_task and kind='relay' and role='claude_code_cli_syzygy' for update;
 if not found then raise exception 'matching relay task required'; end if;
 if w.share_message_id is not null then return jsonb_build_object('message_id',w.share_message_id,'replayed',true); end if;
 if w.status<>'running' or not exists(select 1 from public.agent_tasks where id=p_task and user_id=p_user and status='running' and payload_json->>'target_role'=w.role) then raise exception 'running relay required'; end if;
 if nullif(btrim(p_content),'') is null or length(p_content)>4000 then raise exception 'share must contain 1 to 4000 characters'; end if;
 select id into strict sid from public.sessions where user_id=p_user and session_key='syzygy_claude_cli' and conversation_profile_key='claude_cli' and conversation_kind='direct' and handler='cli' and not is_archived;
 insert into public.messages(user_id,session_id,role,sender_key,content,client_id,client_created_at,meta)
 values(p_user,sid,'assistant','claude_cli',p_content,w.id,now(),jsonb_build_object('schema_version',1,'source','cli_relay','delivery_state','completed','wake_id',w.id,'task_id',p_task)) returning id into mid;
 insert into public.agent_events(user_id,actor,event_type,entity_type,entity_id,title,payload,importance)
 values(p_user,'claude_cli','cli_relay_shared','conversation_message',mid,'Syzygy 来找你啦',jsonb_build_object('schema_version',1,'screen','conversation_detail','params',jsonb_build_object('id',sid),'url','/#/chat?session='||sid,'session_id',sid,'message_id',mid,'sender_key','claude_cli','wake_id',w.id,'task_id',p_task),'high');
 update public.cli_wake_schedule set share_message_id=mid where id=w.id;
 return jsonb_build_object('message_id',mid,'session_id',sid,'replayed',false);
end; $$;

create unique index diary_relay_day_once on public.diary_entries(user_id,author,entry_date) where activity_type='free_activity' and metadata->>'relay'='true';
create function public.cli_relay_append_diary(p_user uuid,p_task uuid,p_content text,p_title text default null,p_allow_shared boolean default false) returns jsonb language plpgsql set search_path='' as $$
declare w public.cli_wake_schedule; page public.diary_entries; segment jsonb;
begin
 select * into w from public.cli_wake_schedule where user_id=p_user and task_id=p_task and kind='relay' and role='claude_code_cli_syzygy';
 if not found then raise exception 'matching relay task required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||w.local_date::text,0));
 select * into page from public.diary_entries where user_id=p_user and author='claude_code_cli' and entry_date=w.local_date and activity_type='free_activity' order by id limit 1 for update;
 if page.metadata->'segments' @> jsonb_build_array(jsonb_build_object('task_id',p_task)) then
  return jsonb_build_object('id',page.id,'replayed',true);
 end if;
 if w.status<>'running' or not exists(select 1 from public.agent_tasks where id=p_task and user_id=p_user and status='running' and payload_json->>'target_role'=w.role) then raise exception 'running relay required'; end if;
 if page.visibility='shared' and not p_allow_shared then raise exception 'today diary is shared; allow_shared is required to append publicly'; end if;
 if nullif(btrim(p_content),'') is null or length(p_content)>12000 then raise exception 'segment must contain 1 to 12000 characters'; end if;
 segment:=jsonb_build_object('task_id',p_task,'wake_id',w.id,'at',now());
 if page.id is null then
  insert into public.diary_entries(user_id,author,entry_date,activity_type,title,content,metadata)
  values(p_user,'claude_code_cli',w.local_date,'free_activity',left(p_title,120),p_content,jsonb_build_object('task_id',p_task,'wake_id',w.id,'relay',true,'segments',jsonb_build_array(segment))) returning * into page;
 else
  update public.diary_entries set content=content||E'\n\n---\n\n'||p_content,
   metadata=metadata||jsonb_build_object('relay',true,'segments',coalesce(metadata->'segments','[]'::jsonb)||jsonb_build_array(segment)) where id=page.id returning * into page;
 end if;
 -- Daily diary state and per-round execution summaries are independent receipts.
 update public.cli_wake_schedule set diary_missing=false where user_id=p_user and role=w.role and local_date=w.local_date and kind='relay' and diary_missing;
 update public.agent_tasks t set payload_json=jsonb_set(t.payload_json,'{free_activity,diary_missing}','false'::jsonb)
 where t.user_id=p_user and t.payload_json ? 'free_activity' and t.id in(select task_id from public.cli_wake_schedule where user_id=p_user and role=w.role and local_date=w.local_date and kind='relay');
 return jsonb_build_object('id',page.id,'entry_date',page.entry_date,'segments',jsonb_array_length(page.metadata->'segments'),'replayed',false);
end; $$;

revoke all on function public.cli_activity_set_mode(uuid,text),public.cli_relay_plan(uuid,jsonb,boolean),public.cli_relay_set_next(uuid,uuid,timestamptz,text),public.cli_relay_share(uuid,uuid,uuid,text),public.cli_relay_append_diary(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.cli_activity_set_mode(uuid,text),public.cli_relay_plan(uuid,jsonb,boolean),public.cli_relay_set_next(uuid,uuid,timestamptz,text),public.cli_relay_share(uuid,uuid,uuid,text),public.cli_relay_append_diary(uuid,uuid,text,text,boolean) to service_role;

create or replace function public.cli_set_self_alarm(p_user uuid,p_task uuid,p_at timestamptz,p_note text default '')
returns jsonb language plpgsql set search_path='' as $$
declare r text; d date := (now() at time zone 'Asia/Shanghai')::date; w public.cli_wake_schedule; nearby jsonb;
begin
 select payload_json->>'target_role' into r from public.agent_tasks where id=p_task and user_id=p_user and status='running';
 if r is null or r not in ('codex_cli_syzygy','claude_code_cli_syzygy') then raise exception 'current running CLI task required'; end if;
 if exists(select 1 from public.cli_activity_settings where user_id=p_user and role=r and mode='relay') then return public.cli_relay_set_next(p_user,p_task,p_at,p_note); end if;
 if p_at is null then raise exception 'daily mode requires wake_at'; end if;
 perform public.cli_wake_plan_day(p_user,d);
 select * into w from public.cli_wake_schedule where user_id=p_user and role=r and local_date=d and kind='alarm';
 if found then return jsonb_build_object('ok',w.created_by_task_id=p_task and w.wake_at=p_at,'reason','daily_alarm_exists','alarm',to_jsonb(w)); end if;
 if (p_at at time zone 'Asia/Shanghai')::date<>d or p_at<=now() or not public.cli_wake_slot_available(p_user,r,p_at,'alarm') then
  select coalesce(jsonb_agg(s),'[]'::jsonb) into nearby from (
   select s from generate_series((d+time '09:00') at time zone 'Asia/Shanghai',(d+time '21:00') at time zone 'Asia/Shanghai',interval '5 minutes') s
   where s>now() and public.cli_wake_slot_available(p_user,r,s,'alarm') order by abs(extract(epoch from s-p_at)) limit 3
  ) choices;
  return jsonb_build_object('ok',false,'reason','time_conflict','available_times',nearby);
 end if;
 insert into public.cli_wake_schedule(user_id,role,local_date,kind,wake_at,note,created_by_task_id)
 values(p_user,r,d,'alarm',p_at,left(p_note,2000),p_task) returning * into w;
 return jsonb_build_object('ok',true,'alarm',to_jsonb(w));
end; $$;


create or replace function public.cli_diary_receipt_guard() returns trigger language plpgsql set search_path='' as $$
declare w public.cli_wake_schedule;
begin
 if new.activity_type<>'free_activity' or new.author not in ('codex_cli','claude_code_cli') then return new; end if;
 if new.metadata->>'task_id' is null then raise exception 'free activity receipt requires original task_id'; end if;
 select * into w from public.cli_wake_schedule where user_id=new.user_id and task_id=(new.metadata->>'task_id')::uuid and role=new.author||'_syzygy';
 if not found then raise exception 'receipt must link to original activity task and author'; end if;
 if w.kind='relay' and (new.metadata->>'relay' is distinct from 'true' or jsonb_typeof(new.metadata->'segments') is distinct from 'array') then raise exception 'relay diary requires append_relay_diary'; end if;
 new.metadata:=new.metadata||jsonb_build_object('wake_id',w.id);
 return new;
end; $$;
