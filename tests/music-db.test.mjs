import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

// 朔的点歌台：四张表的业主隔离、Mini 才能写回地址、请求地址的重排规则。
const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url)
const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d+_music_.*\.sql$/.test(name)).sort()
const migrations = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, MIGRATIONS_DIR), 'utf8')))
const owner = '11111111-1111-4111-8111-111111111111'
const stranger = '22222222-2222-4222-8222-222222222222'

async function setup() {
  const db = new PGlite()
  await db.exec(`
    -- 和 Supabase 一样，service_role（Mini / MCP）绕过 RLS。
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    insert into auth.users values ('${owner}'), ('${stranger}');
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;
  `)
  for (const sql of migrations) await db.exec(sql)
  return db
}

const as = (db, userId) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false)`)
const asMini = (db) => db.exec(`reset role; set role service_role; select set_config('request.jwt.claim.sub', '', false)`)

test('music migration exists', () => {
  assert.ok(migrationFiles.length >= 1)
})

test('song picks: owner-only, one row per song, hiding sends the song back to playlist sync', async () => {
  const db = await setup()
  try {
    await asMini(db)
    const pick = (await db.query(
      `insert into public.music_song_picks (user_id, song_id, title, artists, note, picked_by)
       values ($1, 1859245776, '晴天', '周杰伦', '下雨天给你的', 'claude') returning id, playlist_sync_status`,
      [owner],
    )).rows[0]
    assert.equal(pick.playlist_sync_status, 'pending')
    await assert.rejects(
      db.query(`insert into public.music_song_picks (user_id, song_id, title, picked_by) values ($1, 1859245776, '晴天', 'gpt')`, [owner]),
      /music_song_picks_user_song_unique/,
    )
    await assert.rejects(
      db.query(`insert into public.music_song_picks (user_id, song_id, title, picked_by) values ($1, 2, 'x', 'someone')`, [owner]),
      /music_song_picks_picked_by_check/,
    )
    await assert.rejects(
      db.query(`insert into public.music_song_picks (user_id, song_id, title, encrypted_id) values ($1, 3, 'x', 'not-hex')`, [owner]),
      /music_song_picks_encrypted_id_format/,
    )
    await db.query(`update public.music_song_picks set playlist_sync_status = 'synced', playlist_synced_at = now() where id = $1`, [pick.id])

    await as(db, owner)
    assert.equal((await db.query('select count(*)::int as n from public.music_song_picks')).rows[0].n, 1)
    await db.query(`update public.music_song_picks set status = 'hidden' where id = $1`, [pick.id])
    assert.equal((await db.query('select playlist_sync_status from public.music_song_picks where id = $1', [pick.id])).rows[0].playlist_sync_status, 'pending')

    await as(db, stranger)
    assert.equal((await db.query('select * from public.music_song_picks')).rows.length, 0)
    await assert.rejects(
      db.query(`insert into public.music_song_picks (user_id, song_id, title) values ($1, 5, '冒名点歌')`, [owner]),
      /row-level security/,
    )
    assert.equal((await db.query("select has_table_privilege('anon', 'public.music_song_picks', 'select') as allowed")).rows[0].allowed, false)
  } finally {
    await db.close()
  }
})

test('tracks: owner requests through the RPC, only Mini writes urls, stale rows go back to pending', async () => {
  const db = await setup()
  try {
    const functions = (await db.query(`select n.nspname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='music_request_tracks' order by n.nspname`)).rows
    assert.deepEqual(functions, [{ nspname: 'music_private', prosecdef: true }, { nspname: 'public', prosecdef: false }])
    assert.equal((await db.query("select has_schema_privilege('anon', 'music_private', 'usage') as allowed")).rows[0].allowed, false)
    await as(db, owner)
    const first = (await db.query('select song_id, status from public.music_request_tracks($1)', [[101, 102, 102, null]])).rows
    assert.deepEqual(first.map((r) => [Number(r.song_id), r.status]).sort(), [[101, 'pending'], [102, 'pending']])
    await assert.rejects(db.query(`update public.music_tracks set status = 'failed' where song_id = 101`), /permission denied/)
    await assert.rejects(db.query('select * from public.music_request_tracks($1)', [Array.from({ length: 21 }, (_, i) => i + 1)]), /at most 20/)
    await assert.rejects(db.query('select * from public.music_request_tracks($1)', [[-1]]), /positive/)

    await asMini(db)
    await db.query(`update public.music_tracks set status = 'ready', play_url = 'https://m.example/101.mp3', url_expires_at = now() + interval '20 minutes', resolved_at = now() where song_id = 101`)
    await db.query(`update public.music_tracks set status = 'ready', play_url = 'https://m.example/102.mp3', url_expires_at = now() + interval '1 minute', resolved_at = now() where song_id = 102`)
    await assert.rejects(
      db.query(`update public.music_tracks set status = 'ready', play_url = null where song_id = 101`),
      /music_tracks_ready_has_url/,
    )

    await as(db, owner)
    const again = Object.fromEntries((await db.query('select song_id, status, play_url from public.music_request_tracks($1)', [[101, 102]])).rows.map((r) => [Number(r.song_id), r]))
    // 101 还有 20 分钟有效期，原样返回；102 只剩 1 分钟，重新排队并清掉旧地址。
    assert.equal(again[101].status, 'ready')
    assert.equal(again[101].play_url, 'https://m.example/101.mp3')
    assert.equal(again[102].status, 'pending')
    assert.equal(again[102].play_url, null)

    await as(db, stranger)
    assert.equal((await db.query('select * from public.music_tracks')).rows.length, 0)
    assert.equal((await db.query('select * from public.music_request_tracks($1)', [[101]])).rows.length, 1)
    assert.equal((await db.query('select count(*)::int as n from public.music_tracks')).rows[0].n, 1)

    await db.exec('reset role; set role anon')
    await assert.rejects(db.query('select * from public.music_request_tracks($1)', [[101]]), /permission denied/)
  } finally {
    await db.close()
  }
})

test('search requests: owner can only file a pending request, Mini writes results', async () => {
  const db = await setup()
  try {
    await as(db, owner)
    const id = (await db.query(`insert into public.music_search_requests (user_id, query) values ($1, '晴天') returning id`, [owner])).rows[0].id
    await assert.rejects(
      db.query(`insert into public.music_search_requests (user_id, query, status, results) values ($1, 'x', 'done', '[]')`, [owner]),
      /row-level security/,
    )
    await assert.rejects(db.query(`update public.music_search_requests set status = 'done' where id = $1`, [id]), /permission denied/)

    await asMini(db)
    await db.query(`update public.music_search_requests set status = 'done', results = $2, resolved_at = now() where id = $1`, [id, JSON.stringify([{ song_id: 186016, title: '晴天', artists: '周杰伦' }])])
    await assert.rejects(
      db.query(`update public.music_search_requests set results = '{"not":"array"}' where id = $1`, [id]),
      /music_search_requests_results_shape/,
    )

    await as(db, owner)
    assert.equal((await db.query('select status from public.music_search_requests where id = $1', [id])).rows[0].status, 'done')
    await as(db, stranger)
    assert.equal((await db.query('select * from public.music_search_requests')).rows.length, 0)
  } finally {
    await db.close()
  }
})

test('now playing: one row per owner, pick must be the owner\'s own and is cleared when deleted', async () => {
  const db = await setup()
  try {
    await asMini(db)
    const mine = (await db.query(`insert into public.music_song_picks (user_id, song_id, title) values ($1, 7, '七里香') returning id`, [owner])).rows[0].id
    const theirs = (await db.query(`insert into public.music_song_picks (user_id, song_id, title) values ($1, 8, '别人的歌') returning id`, [stranger])).rows[0].id

    await as(db, owner)
    const upsert = `insert into public.music_now_playing (user_id, song_id, pick_id, title, state, position_ms, position_at)
      values ($1, $2, $3, '七里香', 'playing', 30000, now())
      on conflict (user_id) do update set song_id = excluded.song_id, pick_id = excluded.pick_id, state = excluded.state,
        position_ms = excluded.position_ms, position_at = excluded.position_at`
    await db.query(upsert, [owner, 7, mine])
    await db.query(upsert, [owner, 7, mine])
    assert.equal((await db.query('select count(*)::int as n from public.music_now_playing')).rows[0].n, 1)
    await assert.rejects(db.query(upsert, [owner, 8, theirs]), /music_now_playing_pick_fk/)
    await assert.rejects(
      db.query(`update public.music_now_playing set state = 'playing', song_id = null where user_id = $1`, [owner]),
      /music_now_playing_song_when_active/,
    )

    await db.query('delete from public.music_song_picks where id = $1', [mine])
    const row = (await db.query('select user_id, pick_id, song_id from public.music_now_playing')).rows[0]
    assert.equal(row.user_id, owner)
    assert.equal(row.pick_id, null)
    assert.equal(Number(row.song_id), 7)

    await as(db, stranger)
    assert.equal((await db.query('select * from public.music_now_playing')).rows.length, 0)
  } finally {
    await db.close()
  }
})
