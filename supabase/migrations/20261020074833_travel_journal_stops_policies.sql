-- 游记：travel_plan_stops 的业主本人读写策略。

drop policy if exists travel_plan_stops_select_own on public.travel_plan_stops;
create policy travel_plan_stops_select_own on public.travel_plan_stops for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists travel_plan_stops_insert_own on public.travel_plan_stops;
create policy travel_plan_stops_insert_own on public.travel_plan_stops for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_plan_stops_update_own on public.travel_plan_stops;
create policy travel_plan_stops_update_own on public.travel_plan_stops for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_plan_stops_delete_own on public.travel_plan_stops;
create policy travel_plan_stops_delete_own on public.travel_plan_stops for delete to authenticated
  using ((select auth.uid()) = user_id);
