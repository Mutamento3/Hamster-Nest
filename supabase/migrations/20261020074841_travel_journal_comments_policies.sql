-- 游记：travel_checkin_comments 的业主本人读写策略。

drop policy if exists travel_checkin_comments_select_own on public.travel_checkin_comments;
create policy travel_checkin_comments_select_own on public.travel_checkin_comments for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists travel_checkin_comments_insert_own on public.travel_checkin_comments;
create policy travel_checkin_comments_insert_own on public.travel_checkin_comments for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_checkin_comments_update_own on public.travel_checkin_comments;
create policy travel_checkin_comments_update_own on public.travel_checkin_comments for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists travel_checkin_comments_delete_own on public.travel_checkin_comments;
create policy travel_checkin_comments_delete_own on public.travel_checkin_comments for delete to authenticated
  using ((select auth.uid()) = user_id);
