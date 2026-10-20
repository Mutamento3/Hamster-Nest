-- 打卡留言挂的打卡必须同属一个业主。
create or replace function public.guard_travel_comment_owner()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  checkin_owner uuid;
begin
  select user_id into checkin_owner from public.travel_checkins where id = new.checkin_id;
  if checkin_owner is null then
    raise exception '打卡不存在: %', new.checkin_id using errcode = 'foreign_key_violation';
  end if;
  if checkin_owner <> new.user_id then
    raise exception '打卡不属于同一业主' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_travel_comment_owner() from public, anon, authenticated;

drop trigger if exists trg_travel_checkin_comments_owner_guard on public.travel_checkin_comments;
create trigger trg_travel_checkin_comments_owner_guard
  before insert or update of checkin_id, user_id on public.travel_checkin_comments
  for each row execute function public.guard_travel_comment_owner();
