-- 攻略点与打卡挂的旅行必须同属一个业主（外键只管存在，不管归属）。
create or replace function public.guard_travel_trip_owner()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  trip_owner uuid;
begin
  select user_id into trip_owner from public.travel_trips where id = new.trip_id;
  if trip_owner is null then
    raise exception '旅行不存在: %', new.trip_id using errcode = 'foreign_key_violation';
  end if;
  if trip_owner <> new.user_id then
    raise exception '旅行不属于同一业主' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_travel_trip_owner() from public, anon, authenticated;

drop trigger if exists trg_travel_plan_stops_owner_guard on public.travel_plan_stops;
create trigger trg_travel_plan_stops_owner_guard
  before insert or update of trip_id, user_id on public.travel_plan_stops
  for each row execute function public.guard_travel_trip_owner();

drop trigger if exists trg_travel_checkins_owner_guard on public.travel_checkins;
create trigger trg_travel_checkins_owner_guard
  before insert or update of trip_id, user_id on public.travel_checkins
  for each row execute function public.guard_travel_trip_owner();
