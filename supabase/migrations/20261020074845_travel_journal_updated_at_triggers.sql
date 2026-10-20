-- 游记：四张表的 updated_at 触发器。

drop trigger if exists trg_travel_trips_updated_at on public.travel_trips;
create trigger trg_travel_trips_updated_at
  before update on public.travel_trips
  for each row execute function public.set_updated_at();

drop trigger if exists trg_travel_plan_stops_updated_at on public.travel_plan_stops;
create trigger trg_travel_plan_stops_updated_at
  before update on public.travel_plan_stops
  for each row execute function public.set_updated_at();

drop trigger if exists trg_travel_checkins_updated_at on public.travel_checkins;
create trigger trg_travel_checkins_updated_at
  before update on public.travel_checkins
  for each row execute function public.set_updated_at();

drop trigger if exists trg_travel_checkin_comments_updated_at on public.travel_checkin_comments;
create trigger trg_travel_checkin_comments_updated_at
  before update on public.travel_checkin_comments
  for each row execute function public.set_updated_at();
