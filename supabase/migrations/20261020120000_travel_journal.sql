-- 游记（Travel Journal）：Syzygy 写的攻略 × 串串的打卡路线
--
-- 背景：议事厅提案 31637f86（2026-10-14 发散提案「游记板块」），2026-10-20 串串要在贡嘎自驾出发前先落进 PWA，
-- 之后由 GPT 端落进 App。「让 AI 知道我在哪」从追踪改成仪式：不轮询位置，只在串串按下打卡时记一次。
--
-- 四张表：
--   travel_trips             一次旅行：标题、目的地、起止日期、状态（planning 计划中 → ongoing 进行中 → done 已完成）、复盘。
--   travel_plan_stops        攻略区（Syzygy 写）：第几天、大致时间、地点与坐标、为什么去、注意事项、路痴导航提示。
--                            坐标是 GCJ-02（高德 POI 原样），与打卡的转换后坐标同一坐标系，才能直接算距离。
--   travel_checkins          路线区（串串打卡）：按下打卡的时刻、原始 WGS-84、转换后 GCJ-02、地名、一句话、心情。
--                            离线优先：川西路段没信号，打卡先存在手机本地，有信号再补传；client_id 是手机端生成的
--                            幂等键，同一次打卡补传几遍都只落一条，时间以 checked_at（按下的时刻）为准。
--   travel_checkin_comments  打卡点下的留言，结构照抄 stash_comments。
--
-- 对比地图（按计划 / 改道 / 新发现 / 跳过）是读时计算，不落库；规则在 hamster-mcp/travel_contract.ts（前端与 MCP 共用）。
-- 明确不做：不做后台定位追踪、不存照片（以后再加）、不在库里做逆地理编码。

set lock_timeout = '5s';
set statement_timeout = '2min';

-- ── 旅行 ─────────────────────────────────────────────────────────────────────

create table if not exists public.travel_trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  destination text,
  start_date date,
  end_date date,
  status text not null default 'planning',
  -- 旅行结束后的复盘（Markdown），通常由 Syzygy 对照攻略与打卡来写。
  summary text,
  created_by text not null default 'chuanchuan',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint travel_trips_title_not_blank check (btrim(title) <> ''),
  constraint travel_trips_title_length check (char_length(title) <= 80),
  constraint travel_trips_destination_length check (destination is null or char_length(destination) <= 120),
  constraint travel_trips_dates_order check (start_date is null or end_date is null or end_date >= start_date),
  constraint travel_trips_status_check check (status = any (array['planning'::text, 'ongoing'::text, 'done'::text])),
  constraint travel_trips_summary_length check (summary is null or char_length(summary) <= 20000),
  constraint travel_trips_created_by_check check (created_by = any (array[
    'chuanchuan'::text, 'claude'::text, 'gpt'::text, 'gemini'::text, 'codex_cli'::text, 'claude_code_cli'::text
  ]))
);

comment on table public.travel_trips is '游记·旅行：一次出行。status：planning 计划中 / ongoing 进行中 / done 已完成。';
comment on column public.travel_trips.summary is '旅行复盘（Markdown），对照攻略与实际打卡写。';

create index if not exists idx_travel_trips_user_start
  on public.travel_trips using btree (user_id, start_date desc nulls first, created_at desc);

-- ── 攻略点 ───────────────────────────────────────────────────────────────────

create table if not exists public.travel_plan_stops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trip_id uuid not null references public.travel_trips(id) on delete cascade,
  day_index integer not null default 1,
  sort_order integer not null default 0,
  -- 大致时间，自由文本：「09:30」「上午」「日落前」都行。
  planned_time text,
  name text not null,
  address text,
  -- GCJ-02（高德坐标系），与打卡的 gcj_* 同一坐标系。
  lng double precision,
  lat double precision,
  reason text,
  notes text,
  nav_hint text,
  written_by text not null default 'claude',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint travel_plan_stops_day_range check (day_index between 1 and 60),
  constraint travel_plan_stops_name_not_blank check (btrim(name) <> ''),
  constraint travel_plan_stops_name_length check (char_length(name) <= 120),
  constraint travel_plan_stops_planned_time_length check (planned_time is null or char_length(planned_time) <= 40),
  constraint travel_plan_stops_address_length check (address is null or char_length(address) <= 200),
  constraint travel_plan_stops_coords_paired check ((lng is null) = (lat is null)),
  constraint travel_plan_stops_coords_range check (lng is null or (lng between -180 and 180 and lat between -90 and 90)),
  constraint travel_plan_stops_reason_length check (reason is null or char_length(reason) <= 2000),
  constraint travel_plan_stops_notes_length check (notes is null or char_length(notes) <= 4000),
  constraint travel_plan_stops_nav_hint_length check (nav_hint is null or char_length(nav_hint) <= 2000),
  constraint travel_plan_stops_written_by_check check (written_by = any (array[
    'chuanchuan'::text, 'claude'::text, 'gpt'::text, 'gemini'::text, 'codex_cli'::text, 'claude_code_cli'::text
  ]))
);

comment on table public.travel_plan_stops is '游记·攻略点：Syzygy 写的计划停留点（第几天 / 大致时间 / 地点 / 为什么去 / 注意事项 / 导航提示）。坐标为 GCJ-02。';
comment on column public.travel_plan_stops.nav_hint is '路痴友好的导航提示：从上一站怎么过来、在哪下车、认哪个标志物。';

create index if not exists idx_travel_plan_stops_trip_order
  on public.travel_plan_stops using btree (trip_id, day_index, sort_order, created_at);
create index if not exists idx_travel_plan_stops_user_id
  on public.travel_plan_stops using btree (user_id);

-- ── 打卡 ─────────────────────────────────────────────────────────────────────

create table if not exists public.travel_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trip_id uuid not null references public.travel_trips(id) on delete cascade,
  -- 手机端生成的幂等键：离线排队的打卡补传多少遍都只落一条。
  client_id text not null,
  -- 按下打卡的时刻（不是补传的时刻）。
  checked_at timestamptz not null,
  wgs_lng double precision,
  wgs_lat double precision,
  accuracy_m double precision,
  gcj_lng double precision,
  gcj_lat double precision,
  place_name text,
  note text,
  mood text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint travel_checkins_client_id_length check (char_length(client_id) between 8 and 64),
  constraint travel_checkins_wgs_paired check ((wgs_lng is null) = (wgs_lat is null)),
  constraint travel_checkins_gcj_paired check ((gcj_lng is null) = (gcj_lat is null)),
  constraint travel_checkins_wgs_range check (wgs_lng is null or (wgs_lng between -180 and 180 and wgs_lat between -90 and 90)),
  constraint travel_checkins_gcj_range check (gcj_lng is null or (gcj_lng between -180 and 180 and gcj_lat between -90 and 90)),
  constraint travel_checkins_accuracy_check check (accuracy_m is null or accuracy_m >= 0),
  constraint travel_checkins_place_name_length check (place_name is null or char_length(place_name) <= 120),
  constraint travel_checkins_note_length check (note is null or char_length(note) <= 2000),
  constraint travel_checkins_mood_length check (mood is null or (btrim(mood) <> '' and char_length(mood) <= 8))
);

comment on table public.travel_checkins is '游记·打卡：串串主动按下的一次「看，我在这里」。离线优先，client_id 幂等；checked_at 是按下的时刻。';
comment on column public.travel_checkins.client_id is '手机端生成的幂等键，(user_id, client_id) 唯一；补传重复时原样保留第一条。';
comment on column public.travel_checkins.gcj_lng is 'WGS-84 → GCJ-02 转换后的经度（境外与原始坐标相同），用于和攻略点算距离、在高德里打开。';

create unique index if not exists uq_travel_checkins_user_client
  on public.travel_checkins using btree (user_id, client_id);
create index if not exists idx_travel_checkins_trip_checked
  on public.travel_checkins using btree (trip_id, checked_at);

-- ── 打卡留言 ─────────────────────────────────────────────────────────────────

create table if not exists public.travel_checkin_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  checkin_id uuid not null references public.travel_checkins(id) on delete cascade,
  author text not null default 'chuanchuan',
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint travel_checkin_comments_content_not_blank check (btrim(content) <> ''),
  constraint travel_checkin_comments_content_length check (char_length(content) <= 2000),
  constraint travel_checkin_comments_author_check check (author = any (array[
    'chuanchuan'::text, 'claude'::text, 'gpt'::text, 'gemini'::text, 'codex_cli'::text, 'claude_code_cli'::text
  ]))
);

comment on table public.travel_checkin_comments is '游记·打卡留言：串串（chuanchuan）与各端口在打卡点下的留言。';

create index if not exists idx_travel_checkin_comments_checkin_created
  on public.travel_checkin_comments using btree (checkin_id, created_at);
create index if not exists idx_travel_checkin_comments_user_id
  on public.travel_checkin_comments using btree (user_id);

-- ── 触发器 ───────────────────────────────────────────────────────────────────

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

-- ── RLS：业主本人读写；service_role（MCP）绕过 RLS ─────────────────────────────

alter table public.travel_trips enable row level security;
alter table public.travel_plan_stops enable row level security;
alter table public.travel_checkins enable row level security;
alter table public.travel_checkin_comments enable row level security;

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

revoke all on table public.travel_trips from anon;
revoke all on table public.travel_plan_stops from anon;
revoke all on table public.travel_checkins from anon;
revoke all on table public.travel_checkin_comments from anon;
grant select, insert, update, delete on table public.travel_trips to authenticated, service_role;
grant select, insert, update, delete on table public.travel_plan_stops to authenticated, service_role;
grant select, insert, update, delete on table public.travel_checkins to authenticated, service_role;
grant select, insert, update, delete on table public.travel_checkin_comments to authenticated, service_role;
