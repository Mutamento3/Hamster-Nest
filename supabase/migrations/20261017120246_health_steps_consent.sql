-- HealthKit aggregates are isolated from legacy device_status and never readable via direct client grants.
create table public.health_steps_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'local' check (mode in ('local','cloud','ai','paused')),
  consent_version integer not null default 0,
  data_version integer not null default 0,
  sample_id uuid,
  collected_at timestamptz,
  payload_digest text,
  received_at timestamptz
);
create table public.health_daily_steps (
  user_id uuid not null references public.health_steps_access(user_id) on delete cascade,
  day date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  steps integer check (steps between 0 and 1000000),
  availability text not null check (availability in ('available','unavailable')),
  primary key (user_id, day),
  check ((availability='available' and steps is not null) or (availability='unavailable' and steps is null))
);
alter table public.health_steps_access enable row level security;
alter table public.health_daily_steps enable row level security;
revoke all on public.health_steps_access, public.health_daily_steps from anon, authenticated;
grant select, insert, update, delete on public.health_steps_access, public.health_daily_steps to service_role;

-- Only authenticated Edge/MCP adapters may call this service-only invoker. One owner-row lock serializes
-- uploads and revocation, and a consent generation fences delayed requests after reauthorization.
create function public.health_steps_gateway(
  p_owner uuid, p_action text, p_revision integer default null,
  p_mode text default null, p_snapshot jsonb default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  s public.health_steps_access%rowtype;
  d jsonb; days jsonb; snap jsonb; captured timestamptz; sample uuid;
  sample_day date; day_value date; count_days integer; digest text;
begin
  if p_owner is null or p_action not in ('read','ai_read','consent','upload') then
    raise exception 'invalid request';
  end if;
  insert into public.health_steps_access(user_id) values(p_owner) on conflict do nothing;
  select * into s from public.health_steps_access where user_id=p_owner for update;
  if p_action='consent' then
    if p_revision is distinct from s.consent_version then raise exception 'consent changed'; end if;
    if p_mode is null or p_mode not in ('local','cloud','ai','paused') then raise exception 'invalid mode'; end if;
    update public.health_steps_access set mode=p_mode,consent_version=consent_version+1
      where user_id=p_owner returning * into s;
    if p_mode='local' then
      delete from public.health_daily_steps where user_id=p_owner;
      update public.health_steps_access set sample_id=null,collected_at=null,payload_digest=null,received_at=null,data_version=data_version+1
        where user_id=p_owner returning * into s;
    end if;
  elsif p_action='upload' then
    if s.mode not in ('cloud','ai') or p_revision is distinct from s.consent_version then raise exception 'consent changed'; end if;
    if p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
      or (p_snapshot->>'version') is distinct from '1'
      or (p_snapshot->>'owner') is distinct from p_owner::text
      or (p_snapshot->>'source') is distinct from 'healthkit'
      or (p_snapshot->>'timezone') is distinct from 'Asia/Shanghai'
      or jsonb_typeof(p_snapshot->'days') is distinct from 'array'
      or jsonb_array_length(p_snapshot->'days')<>7 then raise exception 'invalid snapshot'; end if;
    if exists(select 1 from jsonb_object_keys(p_snapshot) k where k not in ('version','owner','source','timezone','sampleId','collectedAt','days')) then raise exception 'invalid fields'; end if;
    captured := (p_snapshot->>'collectedAt')::timestamptz;
    sample := (p_snapshot->>'sampleId')::uuid;
    if captured is null or sample is null or captured>now()+interval '5 minutes' or captured<now()-interval '8 days' then raise exception 'invalid time'; end if;
    sample_day := (captured at time zone 'Asia/Shanghai')::date;
    select count(distinct value->>'date') into count_days from jsonb_array_elements(p_snapshot->'days');
    if count_days<>7 then raise exception 'invalid days'; end if;
    for d in select value from jsonb_array_elements(p_snapshot->'days') loop
      day_value := (d->>'date')::date;
      if day_value is null or day_value<sample_day-6 or day_value>sample_day
        or (d->>'date')<>to_char(day_value,'YYYY-MM-DD')
        or (d->>'startAt')::timestamptz is distinct from (day_value::timestamp at time zone 'Asia/Shanghai')
        or (d->>'endAt')::timestamptz is distinct from ((day_value+1)::timestamp at time zone 'Asia/Shanghai')
        or d->>'availability' is null or d->>'availability' not in ('available','unavailable')
        or not (d ? 'steps') then raise exception 'invalid day'; end if;
      if exists(select 1 from jsonb_object_keys(d) k where k not in ('date','startAt','endAt','steps','availability')) then raise exception 'invalid day fields'; end if;
      if d->>'availability'='available' then
        if jsonb_typeof(d->'steps') is distinct from 'number' or (d->>'steps')::numeric<>trunc((d->>'steps')::numeric)
          or (d->>'steps')::numeric not between 0 and 1000000 then raise exception 'invalid steps'; end if;
      elsif d->'steps' is distinct from 'null'::jsonb then raise exception 'invalid unavailable'; end if;
    end loop;
    digest := md5(p_snapshot::text);
    if sample=s.sample_id and digest is distinct from s.payload_digest then raise exception 'sample conflict'; end if;
    if s.collected_at is null or captured>s.collected_at then
      delete from public.health_daily_steps where user_id=p_owner;
      insert into public.health_daily_steps(user_id,day,start_at,end_at,steps,availability)
        select p_owner,(v->>'date')::date,(v->>'startAt')::timestamptz,(v->>'endAt')::timestamptz,(v->>'steps')::integer,v->>'availability'
        from jsonb_array_elements(p_snapshot->'days') v;
      update public.health_steps_access set sample_id=sample,collected_at=captured,payload_digest=digest,
        data_version=data_version+1,received_at=now() where user_id=p_owner returning * into s;
    elsif captured=s.collected_at and digest is distinct from s.payload_digest then raise exception 'sample conflict';
    end if;
  end if;
  if p_action='ai_read' and s.mode<>'ai' then
    return jsonb_build_object('version',1,'owner',p_owner,'access','not_authorized','snapshot',null);
  end if;
  -- Retain the complete most recent seven-day capture so App and CLI receive identical intervals,
  -- including visibly stale captures. An eight-day expiry prevents indefinite retention/reading.
  if s.collected_at<now()-interval '8 days' then
    delete from public.health_daily_steps where user_id=p_owner;
    update public.health_steps_access set sample_id=null,collected_at=null,payload_digest=null,received_at=null
      where user_id=p_owner returning * into s;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('date',day,'startAt',start_at,'endAt',end_at,'steps',steps,'availability',availability) order by day desc),'[]'::jsonb)
    into days from public.health_daily_steps where user_id=p_owner;
  if s.sample_id is not null then
    snap := jsonb_build_object('version',1,'owner',p_owner,'source','healthkit','timezone','Asia/Shanghai',
      'sampleId',s.sample_id,'collectedAt',s.collected_at,'days',days,'dataVersion',s.data_version,'receivedAt',s.received_at);
  end if;
  return jsonb_build_object('version',1,'owner',p_owner,'mode',s.mode,'consentVersion',s.consent_version,'snapshot',snap);
end;
$$;
revoke all on function public.health_steps_gateway(uuid,text,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.health_steps_gateway(uuid,text,integer,text,jsonb) to service_role;
