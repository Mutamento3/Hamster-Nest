-- 游记：travel_checkins 的业主本人读写策略。

drop policy if exists travel_checkins_select_own on public.travel_checkins;
create policy travel_checkins_select_own on public.travel_checkins for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists travel_checkins_insert_own on public.travel_checkins;
create policy travel_checkins_insert_own on public.travel_checkins for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_checkins_update_own on public.travel_checkins;
create policy travel_checkins_update_own on public.travel_checkins for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_checkins_delete_own on public.travel_checkins;
create policy travel_checkins_delete_own on public.travel_checkins for delete to authenticated
  using ((select auth.uid()) = user_id);
