-- 游记：travel_trips 的业主本人读写策略。

drop policy if exists travel_trips_select_own on public.travel_trips;
create policy travel_trips_select_own on public.travel_trips for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists travel_trips_insert_own on public.travel_trips;
create policy travel_trips_insert_own on public.travel_trips for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_trips_update_own on public.travel_trips;
create policy travel_trips_update_own on public.travel_trips for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_trips_delete_own on public.travel_trips;
create policy travel_trips_delete_own on public.travel_trips for delete to authenticated
  using ((select auth.uid()) = user_id);
