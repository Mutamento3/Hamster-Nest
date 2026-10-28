-- 朔的点歌台：各端给串串点歌，鼠窝 App 内直接播放，Mac mini 负责和网易云打交道
--
-- 背景：议事厅提案 37651c62（2026-10-28 串串拍板）。网易云只开给 Syzygy 用（串串主力用 QQ 音乐），
-- 一个号：官方 ncm-cli 凭证和取播放地址的 Cookie 都在这个号上，且只放在 Mac mini 本机。
-- 云端（MCP / Edge Function）和 App 只读写下面四张表，碰不到任何网易云凭证。
--
-- 四张表，按“谁写”分工：
--   music_song_picks       点歌表。各端经 MCP（service_role）点歌，串串在 App 里也能点、能隐藏。
--                          Mini 把 active 的歌同步进网易云歌单「朔」，hidden 的从歌单里移除，回写 playlist_sync_*。
--   music_tracks           单曲的播放地址与歌词缓存。App 用 music_request_tracks() 请求（置 pending），
--                          Mini 取到后写回 ready / unavailable / failed。地址有时效，过期后 App 再请求一次即可。
--   music_search_requests  搜歌请求。各端要拿到真实的歌曲 ID 才能点歌，搜索只能由 Mini 去做：
--                          写一行 pending，Mini 搜完把结果写进 results。
--   music_now_playing      每个业主一行：App 正在放哪首、放到哪儿。只在播放 / 暂停 / 拖动 / 切歌时写，
--                          不按秒刷新；当前进度 = position_ms + (now() - position_at)（state = playing 时）。
--
-- 歌曲 ID 一律用网易云的原始数字 ID（song_id）；ncm-cli 的 API 请求要用 32 位 hex 的加密 ID，
-- 点歌时知道就一并存进 encrypted_id，不知道留空由 Mini 补。
-- 明确不做：不存音频文件、不留播放历史（以后需要再加 music_listen_events）。

set lock_timeout = '5s';
set statement_timeout = '2min';

-- ── 点歌表 ───────────────────────────────────────────────────────────────────

create table if not exists public.music_song_picks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id bigint not null,
  encrypted_id text,
  title text not null,
  artists text,
  album text,
  cover_url text,
  duration_ms integer,
  -- 为什么挑这首：播放器里显示在封面下面。
  note text,
  picked_by text not null default 'chuanchuan',
  status text not null default 'active',
  playlist_sync_status text not null default 'pending',
  playlist_synced_at timestamptz,
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint music_song_picks_user_song_unique unique (user_id, song_id),
  -- 供 music_now_playing 做同业主外键。
  constraint music_song_picks_user_id_unique unique (user_id, id),
  constraint music_song_picks_song_id_positive check (song_id > 0),
  constraint music_song_picks_encrypted_id_format check (encrypted_id is null or encrypted_id ~ '^[0-9a-fA-F]{32}$'),
  constraint music_song_picks_title_not_blank check (btrim(title) <> ''),
  constraint music_song_picks_title_length check (char_length(title) <= 200),
  constraint music_song_picks_artists_length check (artists is null or char_length(artists) <= 300),
  constraint music_song_picks_album_length check (album is null or char_length(album) <= 200),
  constraint music_song_picks_cover_url_length check (cover_url is null or char_length(cover_url) <= 1000),
  constraint music_song_picks_duration_range check (duration_ms is null or duration_ms between 0 and 86400000),
  constraint music_song_picks_note_length check (note is null or char_length(note) <= 2000),
  constraint music_song_picks_picked_by_check check (picked_by = any (array[
    'chuanchuan'::text, 'claude'::text, 'gpt'::text, 'gemini'::text, 'codex_cli'::text, 'claude_code_cli'::text
  ])),
  constraint music_song_picks_status_check check (status = any (array['active'::text, 'hidden'::text])),
  constraint music_song_picks_sync_status_check check (playlist_sync_status = any (array['pending'::text, 'synced'::text, 'failed'::text])),
  constraint music_song_picks_sync_error_length check (sync_error is null or char_length(sync_error) <= 1000)
);

comment on table public.music_song_picks is '朔的点歌台·点歌表：各端给串串点的歌和理由。Mini 负责同步进网易云歌单「朔」。';
comment on column public.music_song_picks.song_id is '网易云原始数字 ID（music.163.com/#/song?id=<song_id>）。';
comment on column public.music_song_picks.encrypted_id is 'ncm-cli 用的 32 位 hex 加密 ID；不知道就留空，由 Mini 补。';
comment on column public.music_song_picks.note is '为什么挑这首，播放器里显示在封面下面。';
comment on column public.music_song_picks.status is 'active 在歌单里 / hidden 串串隐藏了（Mini 会从网易云歌单里移除）。';
comment on column public.music_song_picks.playlist_sync_status is 'Mini 同步网易云歌单的状态；status 一变就回到 pending。';

create index if not exists idx_music_song_picks_user_created
  on public.music_song_picks using btree (user_id, created_at desc)
  where status = 'active';
create index if not exists idx_music_song_picks_sync_pending
  on public.music_song_picks using btree (user_id, created_at)
  where playlist_sync_status = 'pending';

-- ── 播放地址与歌词缓存 ───────────────────────────────────────────────────────

create table if not exists public.music_tracks (
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id bigint not null,
  status text not null default 'pending',
  play_url text,
  url_expires_at timestamptz,
  -- 音质档位（如 standard / exhigh / lossless），按 Mini 实际取到的写。
  quality text,
  lyric text,
  translated_lyric text,
  error text,
  attempts integer not null default 0,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, song_id),
  constraint music_tracks_song_id_positive check (song_id > 0),
  constraint music_tracks_status_check check (status = any (array['pending'::text, 'ready'::text, 'unavailable'::text, 'failed'::text])),
  -- ready 必须带地址；其余状态不留地址，免得 App 拿过期或失败的地址去播。
  constraint music_tracks_ready_has_url check ((status = 'ready') = (play_url is not null)),
  constraint music_tracks_play_url_length check (play_url is null or char_length(play_url) <= 2000),
  constraint music_tracks_quality_length check (quality is null or char_length(quality) <= 40),
  constraint music_tracks_lyric_length check (lyric is null or char_length(lyric) <= 50000),
  constraint music_tracks_translated_lyric_length check (translated_lyric is null or char_length(translated_lyric) <= 50000),
  constraint music_tracks_error_length check (error is null or char_length(error) <= 1000),
  constraint music_tracks_attempts_range check (attempts between 0 and 1000)
);

comment on table public.music_tracks is '朔的点歌台·单曲缓存：播放地址（有时效）和歌词。App 经 music_request_tracks() 请求，Mini 写回。';
comment on column public.music_tracks.status is 'pending 等 Mini 取 / ready 可播 / unavailable 下架或无版权（visible=false）/ failed 取失败。';
comment on column public.music_tracks.url_expires_at is '播放地址的过期时间；过期后 App 再调一次 music_request_tracks() 就会重新排队。';

create index if not exists idx_music_tracks_pending
  on public.music_tracks using btree (requested_at)
  where status = 'pending';

-- ── 搜歌请求 ─────────────────────────────────────────────────────────────────

create table if not exists public.music_search_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null,
  requested_by text not null default 'chuanchuan',
  status text not null default 'pending',
  -- 结果数组，每项至少有 song_id / title / artists；visible=false 的歌由 Mini 标出或直接过滤。
  results jsonb,
  error text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint music_search_requests_query_not_blank check (btrim(query) <> ''),
  constraint music_search_requests_query_length check (char_length(query) <= 100),
  constraint music_search_requests_requested_by_check check (requested_by = any (array[
    'chuanchuan'::text, 'claude'::text, 'gpt'::text, 'gemini'::text, 'codex_cli'::text, 'claude_code_cli'::text
  ])),
  constraint music_search_requests_status_check check (status = any (array['pending'::text, 'done'::text, 'failed'::text])),
  constraint music_search_requests_results_shape check (
    results is null or (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 50)
  ),
  constraint music_search_requests_error_length check (error is null or char_length(error) <= 1000)
);

comment on table public.music_search_requests is '朔的点歌台·搜歌请求：写一行 pending，Mini 用网易云搜完把结果写进 results。旧请求可由 Mini 定期清理。';

create index if not exists idx_music_search_requests_pending
  on public.music_search_requests using btree (created_at)
  where status = 'pending';
create index if not exists idx_music_search_requests_user_created
  on public.music_search_requests using btree (user_id, created_at desc);

-- ── 正在播放 ─────────────────────────────────────────────────────────────────

create table if not exists public.music_now_playing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  song_id bigint,
  pick_id uuid,
  title text,
  artists text,
  state text not null default 'stopped',
  position_ms integer not null default 0,
  -- position_ms 是在 position_at 这一刻量到的；playing 时往后外推。
  position_at timestamptz not null default now(),
  duration_ms integer,
  device text,
  updated_at timestamptz not null default now(),
  -- 同业主外键：只能指向自己的点歌；点歌被删时只清空 pick_id。
  constraint music_now_playing_pick_fk foreign key (user_id, pick_id)
    references public.music_song_picks (user_id, id) on delete set null (pick_id),
  constraint music_now_playing_song_id_positive check (song_id is null or song_id > 0),
  constraint music_now_playing_state_check check (state = any (array['playing'::text, 'paused'::text, 'stopped'::text])),
  constraint music_now_playing_song_when_active check (state = 'stopped' or song_id is not null),
  constraint music_now_playing_title_length check (title is null or char_length(title) <= 200),
  constraint music_now_playing_artists_length check (artists is null or char_length(artists) <= 300),
  constraint music_now_playing_position_range check (position_ms between 0 and 86400000),
  constraint music_now_playing_duration_range check (duration_ms is null or duration_ms between 0 and 86400000),
  constraint music_now_playing_device_length check (device is null or char_length(device) <= 60)
);

comment on table public.music_now_playing is '朔的点歌台·正在播放：每个业主一行。只在播放 / 暂停 / 拖动 / 切歌时写，Syzygy 读它来接着这首歌聊。';
comment on column public.music_now_playing.position_at is 'position_ms 的测量时刻；state = playing 时当前进度 = position_ms + (now() - position_at)。';

-- ── RLS 与授权 ───────────────────────────────────────────────────────────────

alter table public.music_song_picks enable row level security;
alter table public.music_tracks enable row level security;
alter table public.music_search_requests enable row level security;
alter table public.music_now_playing enable row level security;

revoke all on table public.music_song_picks from anon;
revoke all on table public.music_tracks from anon;
revoke all on table public.music_search_requests from anon;
revoke all on table public.music_now_playing from anon;

-- 点歌表、正在播放：业主本人完整读写。
grant select, insert, update, delete on table public.music_song_picks to authenticated, service_role;
grant select, insert, update, delete on table public.music_now_playing to authenticated, service_role;
-- 单曲缓存：业主只读，请求走 music_request_tracks()；写回地址只有 Mini（service_role）。
grant select on table public.music_tracks to authenticated;
grant select, insert, update, delete on table public.music_tracks to service_role;
-- 搜歌请求：业主可读、可发起；结果只由 Mini 写回。
grant select, insert on table public.music_search_requests to authenticated;
grant select, insert, update, delete on table public.music_search_requests to service_role;

drop policy if exists music_song_picks_select_own on public.music_song_picks;
create policy music_song_picks_select_own on public.music_song_picks for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists music_song_picks_insert_own on public.music_song_picks;
create policy music_song_picks_insert_own on public.music_song_picks for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists music_song_picks_update_own on public.music_song_picks;
create policy music_song_picks_update_own on public.music_song_picks for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists music_song_picks_delete_own on public.music_song_picks;
create policy music_song_picks_delete_own on public.music_song_picks for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists music_tracks_select_own on public.music_tracks;
create policy music_tracks_select_own on public.music_tracks for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists music_search_requests_select_own on public.music_search_requests;
create policy music_search_requests_select_own on public.music_search_requests for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists music_search_requests_insert_own on public.music_search_requests;
create policy music_search_requests_insert_own on public.music_search_requests for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'pending' and results is null and resolved_at is null);

drop policy if exists music_now_playing_select_own on public.music_now_playing;
create policy music_now_playing_select_own on public.music_now_playing for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists music_now_playing_insert_own on public.music_now_playing;
create policy music_now_playing_insert_own on public.music_now_playing for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists music_now_playing_update_own on public.music_now_playing;
create policy music_now_playing_update_own on public.music_now_playing for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists music_now_playing_delete_own on public.music_now_playing;
create policy music_now_playing_delete_own on public.music_now_playing for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ── 触发器 ───────────────────────────────────────────────────────────────────

drop trigger if exists trg_music_song_picks_updated_at on public.music_song_picks;
create trigger trg_music_song_picks_updated_at
  before update on public.music_song_picks
  for each row execute function public.set_updated_at();

drop trigger if exists trg_music_tracks_updated_at on public.music_tracks;
create trigger trg_music_tracks_updated_at
  before update on public.music_tracks
  for each row execute function public.set_updated_at();

drop trigger if exists trg_music_now_playing_updated_at on public.music_now_playing;
create trigger trg_music_now_playing_updated_at
  before update on public.music_now_playing
  for each row execute function public.set_updated_at();

-- 隐藏 / 恢复一首歌时，让 Mini 重新同步网易云歌单。
create or replace function public.music_song_picks_resync_on_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.playlist_sync_status := 'pending';
    new.sync_error := null;
  end if;
  return new;
end;
$$;

revoke all on function public.music_song_picks_resync_on_status() from public, anon, authenticated;

drop trigger if exists trg_music_song_picks_resync on public.music_song_picks;
create trigger trg_music_song_picks_resync
  before update of status on public.music_song_picks
  for each row execute function public.music_song_picks_resync_on_status();

-- ── App 请求播放地址 ─────────────────────────────────────────────────────────

-- 一次最多 20 首（当前这首 + 预取的后几首）。已经 ready 且地址还有 2 分钟以上有效期的不动；
-- 过期、失败、卡在 pending 超过 2 分钟、或 unavailable 超过一天的，重新排队。返回这几首的当前行。
create or replace function public.music_request_tracks(p_song_ids bigint[])
returns setof public.music_tracks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_ids bigint[];
begin
  if v_user is null then
    raise exception 'music_request_tracks requires a signed-in user';
  end if;

  select coalesce(array_agg(distinct id), '{}') into v_ids
  from unnest(coalesce(p_song_ids, '{}')) as id
  where id is not null;

  if cardinality(v_ids) > 20 then
    raise exception 'music_request_tracks accepts at most 20 songs at a time';
  end if;
  if exists (select 1 from unnest(v_ids) as id where id <= 0) then
    raise exception 'song ids must be positive';
  end if;

  insert into public.music_tracks as t (user_id, song_id)
  select v_user, id from unnest(v_ids) as id
  on conflict (user_id, song_id) do update
    set status = 'pending',
        play_url = null,
        url_expires_at = null,
        error = null,
        requested_at = now()
    where t.status = 'failed'
       or (t.status = 'ready' and (t.url_expires_at is null or t.url_expires_at < now() + interval '2 minutes'))
       or (t.status = 'pending' and t.requested_at < now() - interval '2 minutes')
       or (t.status = 'unavailable' and coalesce(t.resolved_at, t.requested_at) < now() - interval '1 day');

  return query
    select t.* from public.music_tracks t
    where t.user_id = v_user and t.song_id = any (v_ids);
end;
$$;

revoke all on function public.music_request_tracks(bigint[]) from public, anon;
grant execute on function public.music_request_tracks(bigint[]) to authenticated, service_role;

comment on function public.music_request_tracks(bigint[]) is
  '朔的点歌台：App 请求播放地址（最多 20 首）。需要重取的置 pending 交给 Mini，返回这几首的当前状态。';

-- ── Realtime ─────────────────────────────────────────────────────────────────

-- App 订阅 music_tracks 拿到 Mini 写回的地址；Mini 订阅点歌、搜歌和取地址请求；Syzygy 可订阅正在播放。
-- 没有 supabase_realtime（本地 PGlite 测试）就跳过。
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['music_song_picks', 'music_tracks', 'music_search_requests', 'music_now_playing'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
