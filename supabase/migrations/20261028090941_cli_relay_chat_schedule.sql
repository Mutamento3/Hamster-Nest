-- Reuse the existing service-only tool for a running Claude direct-chat task.
-- No new queue or client write permission: one future relay reservation remains.
create or replace function public.cli_relay_set_next(
 p_user uuid,p_task uuid,p_at timestamptz default null,p_note text default ''
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 t public.agent_tasks;
 w public.cli_wake_schedule;
 d date := (now() at time zone 'Asia/Shanghai')::date;
 in_relay boolean;
 next_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||d::text,0));
 select * into t from public.agent_tasks
 where id=p_task and user_id=p_user and status='running' and completed_at is null
   and payload_json->>'target_role'='claude_code_cli_syzygy' for share;
 if not found then raise exception 'current running relay or Claude private-chat task required'; end if;

 select * into w from public.cli_wake_schedule
 where user_id=p_user and task_id=p_task and role='claude_code_cli_syzygy'
   and kind='relay' and status='running' and local_date=d for update;
 in_relay := found;
 if not in_relay then
  if t.executor is distinct from 'claude_code_cli'
    or t.payload_json->>'source' is distinct from 'conversation_dispatch'
    or t.payload_json->>'task_type' is distinct from 'conversation_message'
    or not exists(select 1 from public.sessions s
      where s.id::text=t.payload_json->>'session_id' and s.user_id=p_user
        and s.session_key='syzygy_claude_cli' and s.conversation_profile_key='claude_cli'
        and s.conversation_kind='direct' and s.handler='cli' and not s.is_archived)
  then raise exception 'current running relay or Claude private-chat task required'; end if;
  if not exists(select 1 from public.cli_activity_settings where user_id=p_user
    and role='claude_code_cli_syzygy' and mode='relay')
  then return jsonb_build_object('ok',false,'reason','relay_disabled'); end if;
  select * into w from public.cli_wake_schedule where user_id=p_user
    and role='claude_code_cli_syzygy' and kind='relay' and status in ('planned','queued','running') for update;
  if w.status='running' then return jsonb_build_object('ok',false,'reason','relay_running'); end if;
  if w.id is not null and w.local_date<>d then
   return jsonb_build_object('ok',false,'reason','schedule_refresh_required');
  end if;
 end if;

 if exists(select 1 from public.cli_wake_schedule where user_id=p_user
   and role='claude_code_cli_syzygy' and local_date=d and close_day)
 then return jsonb_build_object('ok',p_at is null,'reason','day_closed','day_closed',true); end if;
 if p_at is not null and ((p_at at time zone 'Asia/Shanghai')::date<>d
   or p_at<now()+interval '10 minutes'
   or not public.cli_wake_slot_available(p_user,'claude_code_cli_syzygy',p_at,'relay',w.id))
 then return jsonb_build_object('ok',false,'reason','time_conflict','minimum',now()+interval '10 minutes'); end if;

 if in_relay then
  update public.cli_wake_schedule set next_wake_at=p_at,next_note=left(coalesce(p_note,''),2000),close_day=p_at is null where id=w.id;
  return jsonb_build_object('ok',true,'next_wake_at',p_at,'day_closed',p_at is null);
 end if;
 if p_at is not null and (select count(*) from public.cli_wake_schedule where user_id=p_user
   and role='claude_code_cli_syzygy' and local_date=d and kind='relay' and started_at is not null)>=30
 then return jsonb_build_object('ok',false,'reason','daily_cap'); end if;

 if p_at is null then
  -- Keep closure on a real schedule record, including before today's first wake.
  if w.id is null then
   insert into public.cli_wake_schedule(user_id,role,local_date,kind,wake_at,status,skip_reason,
     close_day,next_note,created_by_task_id,completed_at,decision_source)
   values(p_user,'claude_code_cli_syzygy',d,'relay',now(),'cancelled','day_closed',
     true,left(coalesce(p_note,''),2000),p_task,now(),'model');
  else
   update public.cli_wake_schedule set status='cancelled',skip_reason='day_closed',completed_at=now(),
     close_day=true,next_note=left(coalesce(p_note,''),2000),created_by_task_id=p_task,decision_source='model' where id=w.id;
   update public.syzygy_commands set status='failed',completed_at=now(),error_message='relay day closed in private chat'
     where id=w.command_id and user_id=p_user and status in ('pending','running');
  end if;
  return jsonb_build_object('ok',true,'next_wake_at',null,'day_closed',true);
 end if;

 if w.status='planned' then
  update public.cli_wake_schedule set wake_at=p_at,note=left(coalesce(p_note,''),2000),
    decision_source='model',created_by_task_id=p_task where id=w.id;
  next_id:=w.id;
 else
  -- A queued wake already has an immutable command idempotency key. Retire it
  -- and use a new wake ID so a later tick cannot revive/reuse its old command.
  if w.id is not null then
   update public.cli_wake_schedule set status='cancelled',skip_reason='rescheduled_in_chat',completed_at=now() where id=w.id;
   update public.syzygy_commands set status='failed',completed_at=now(),error_message='relay rescheduled in private chat'
     where id=w.command_id and user_id=p_user and status in ('pending','running');
  end if;
  insert into public.cli_wake_schedule(user_id,role,local_date,kind,wake_at,note,created_by_task_id,predecessor_id,decision_source)
  values(p_user,'claude_code_cli_syzygy',d,'relay',p_at,left(coalesce(p_note,''),2000),p_task,w.id,'model') returning id into next_id;
 end if;
 return jsonb_build_object('ok',true,'wake_id',next_id,'next_wake_at',p_at,'day_closed',false);
end; $$;

revoke all on function public.cli_relay_set_next(uuid,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.cli_relay_set_next(uuid,uuid,timestamptz,text) to service_role;
