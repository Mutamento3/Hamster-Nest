import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

// 生产库分 8 次应用，仓库里也是 8 份按版本号排列的文件；按顺序全部跑一遍。
const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url)
const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((name) => /^20261020\d+_travel_journal.*\.sql$/.test(name)).sort()
const migrations = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, MIGRATIONS_DIR), 'utf8')))
const owner = '11111111-1111-4111-8111-111111111111'
const stranger = '22222222-2222-4222-8222-222222222222'

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
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

test('travel migrations are split into the eight production versions', () => {
  assert.equal(migrationFiles.length, 8)
})

test('travel tables: owner-only RLS, cascade delete and idempotent offline check-ins', async () => {
  const db = await setup()
  try {
    await as(db, owner)
    const trip = (await db.query(`insert into public.travel_trips (user_id, title, start_date) values ($1, '贡嘎自驾', '2026-10-22') returning id`, [owner])).rows[0].id
    const stop = (await db.query(`insert into public.travel_plan_stops (user_id, trip_id, day_index, name, lng, lat) values ($1, $2, 2, '子梅垭口', 101.8466, 29.6327) returning id`, [owner, trip])).rows[0].id
    assert.ok(stop)

    const upload = `insert into public.travel_checkins (user_id, trip_id, client_id, checked_at, wgs_lng, wgs_lat, gcj_lng, gcj_lat)
      values ($1, $2, 'client-0001', '2026-10-23T03:00:00Z', 101.844, 29.635, 101.847, 29.633)
      on conflict (user_id, client_id) do nothing`
    await db.query(upload, [owner, trip])
    await db.query(upload, [owner, trip])
    assert.equal((await db.query('select count(*)::int as n from public.travel_checkins')).rows[0].n, 1)
    const checkin = (await db.query('select id from public.travel_checkins')).rows[0].id
    await db.query(`insert into public.travel_checkin_comments (user_id, checkin_id, content) values ($1, $2, '看到金山了！')`, [owner, checkin])

    await assert.rejects(
      db.query(`insert into public.travel_checkins (user_id, trip_id, client_id, checked_at, wgs_lng) values ($1, $2, 'client-0002', now(), 101.8)`, [owner, trip]),
      /travel_checkins_wgs_paired/,
    )
    await assert.rejects(
      db.query(`insert into public.travel_trips (user_id, title, start_date, end_date) values ($1, 'x', '2026-10-22', '2026-10-21')`, [owner]),
      /travel_trips_dates_order/,
    )

    await as(db, stranger)
    assert.equal((await db.query('select * from public.travel_trips')).rows.length, 0)
    assert.equal((await db.query('select * from public.travel_checkins')).rows.length, 0)
    // 外键只管存在：陌生人拿着别人的 trip_id 也写不进去。
    await assert.rejects(
      db.query(`insert into public.travel_plan_stops (user_id, trip_id, name) values ($1, $2, '偷偷加一站')`, [stranger, trip]),
      /不存在|不属于同一业主/,
    )
    await assert.rejects(
      db.query(`insert into public.travel_checkin_comments (user_id, checkin_id, content) values ($1, $2, 'hi')`, [stranger, checkin]),
      /不存在|不属于同一业主/,
    )

    await as(db, owner)
    await db.query('delete from public.travel_trips where id = $1', [trip])
    for (const table of ['travel_plan_stops', 'travel_checkins', 'travel_checkin_comments']) {
      assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, table)
    }
    assert.equal((await db.query("select has_table_privilege('anon', 'public.travel_checkins', 'select') as allowed")).rows[0].allowed, false)
  } finally {
    await db.close()
  }
})
