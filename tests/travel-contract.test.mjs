import assert from 'node:assert/strict'
import test from 'node:test'

const {
  TRAVEL_MATCH_RADIUS_M,
  buildAmapMarkerUrl,
  compareTravel,
  distanceMeters,
  normalizeTravelStopInput,
  normalizeTravelTripPatch,
  shanghaiDateOf,
  travelDateOfDay,
  travelDayIndexOf,
  wgs84ToGcj02,
} = await import('../supabase/functions/hamster-mcp/travel_contract.ts')

test('wgs84 → gcj02 shifts mainland points by a few hundred metres and leaves the rest of the world alone', () => {
  // 天安门（WGS-84）：高德上约在 116.4036, 39.9101。
  const gcj = wgs84ToGcj02(116.397428, 39.90923)
  assert.ok(Math.abs(gcj.lng - 116.403674) < 0.0002, `lng ${gcj.lng}`)
  assert.ok(Math.abs(gcj.lat - 39.910633) < 0.0002, `lat ${gcj.lat}`)
  const shift = distanceMeters({ lng: 116.397428, lat: 39.90923 }, gcj)
  assert.ok(shift > 300 && shift < 800, `shift ${shift}`)
  assert.deepEqual(wgs84ToGcj02(139.6917, 35.6895), { lng: 139.6917, lat: 35.6895 })
})

test('trip day index follows the Shanghai calendar, not UTC', () => {
  assert.equal(shanghaiDateOf('2026-10-22T16:30:00Z'), '2026-10-23')
  assert.equal(travelDayIndexOf('2026-10-22', '2026-10-22T01:00:00Z'), 1)
  assert.equal(travelDayIndexOf('2026-10-22', '2026-10-22T16:30:00Z'), 2)
  assert.equal(travelDayIndexOf(null, '2026-10-22T01:00:00Z'), null)
  assert.equal(travelDateOfDay('2026-10-30', 3), '2026-11-01')
})

const stops = [
  { id: 'kangding', dayIndex: 1, name: '康定', lng: 101.9625, lat: 30.0497 },
  { id: 'xinduqiao', dayIndex: 1, name: '新都桥', lng: 101.4939, lat: 30.0503 },
  { id: 'zimei', dayIndex: 2, name: '子梅垭口', lng: 101.8466, lat: 29.6327 },
  { id: 'nocoords', dayIndex: 2, name: '上木居村', lng: null, lat: null },
  { id: 'lenggacuo', dayIndex: 3, name: '冷嘎措', lng: 101.7516, lat: 29.7072 },
]

test('compare marks on-plan, detour, discovery, skipped and pending', () => {
  const result = compareTravel({
    startDate: '2026-10-22',
    tripStatus: 'ongoing',
    today: '2026-10-23',
    stops,
    checkins: [
      { id: 'c1', checkedAt: '2026-10-22T04:00:00Z', lng: 101.9640, lat: 30.0500, placeName: null },
      // 子梅垭口原定第 2 天，第 3 天才去：改道。
      { id: 'c2', checkedAt: '2026-10-24T01:00:00Z', lng: 101.8470, lat: 29.6330, placeName: '子梅' },
      // 两个点都远：新发现。
      { id: 'c3', checkedAt: '2026-10-23T05:00:00Z', lng: 102.2, lat: 29.9, placeName: '路边牦牛' },
      // 没坐标，但地名和计划点一样。
      { id: 'c4', checkedAt: '2026-10-23T06:00:00Z', lng: null, lat: null, placeName: ' 上木居村 ' },
    ],
  })
  assert.equal(result.checkins.get('c1').kind, 'on_plan')
  assert.equal(result.checkins.get('c1').stopId, 'kangding')
  assert.ok(result.checkins.get('c1').distanceM <= TRAVEL_MATCH_RADIUS_M)
  assert.equal(result.checkins.get('c2').kind, 'detour')
  assert.equal(result.checkins.get('c2').dayIndex, 3)
  assert.equal(result.checkins.get('c3').kind, 'discovery')
  assert.equal(result.checkins.get('c3').stopId, null)
  assert.equal(result.checkins.get('c4').kind, 'on_plan')
  assert.equal(result.checkins.get('c4').distanceM, null)
  assert.equal(result.stops.get('kangding').kind, 'visited')
  // 第 1 天已经过去、新都桥没打卡：跳过。
  assert.equal(result.stops.get('xinduqiao').kind, 'skipped')
  assert.equal(result.stops.get('zimei').kind, 'visited')
  // 第 3 天还没过完：还没到。
  assert.equal(result.stops.get('lenggacuo').kind, 'pending')
})

test('a finished trip turns every unvisited stop into skipped; no start date never skips by date', () => {
  const done = compareTravel({ startDate: null, tripStatus: 'done', today: '2026-12-01', stops, checkins: [] })
  assert.ok([...done.stops.values()].every((match) => match.kind === 'skipped'))
  const planning = compareTravel({ startDate: null, tripStatus: 'planning', today: '2026-12-01', stops, checkins: [] })
  assert.ok([...planning.stops.values()].every((match) => match.kind === 'pending'))
})

test('stop input validation trims, pairs coordinates and bounds day index', () => {
  const ok = normalizeTravelStopInput({ name: '  子梅垭口 ', day_index: 2, lng: 101.84661234, lat: 29.63271234, notes: 'a\r\nb' }, 30)
  assert.equal(ok.ok, true)
  assert.equal(ok.value.name, '子梅垭口')
  assert.equal(ok.value.sort_order, 30)
  assert.equal(ok.value.lng, 101.846612)
  assert.equal(ok.value.notes, 'a\nb')
  assert.equal(ok.value.reason, null)
  assert.equal(normalizeTravelStopInput({ name: '' }).ok, false)
  assert.equal(normalizeTravelStopInput({ name: 'x', lng: 101 }).ok, false)
  assert.equal(normalizeTravelStopInput({ name: 'x', day_index: 0 }).ok, false)
  assert.equal(normalizeTravelStopInput({ name: 'x', lng: 200, lat: 10 }).ok, false)
})

test('trip patch validates dates and status, only touching provided fields', () => {
  assert.deepEqual(normalizeTravelTripPatch({ title: ' 贡嘎 ' }), { ok: true, value: { title: '贡嘎' } })
  assert.deepEqual(normalizeTravelTripPatch({ destination: '', start_date: '' }), { ok: true, value: { destination: null, start_date: null } })
  assert.equal(normalizeTravelTripPatch({ start_date: '2026-02-30' }).ok, false)
  assert.equal(normalizeTravelTripPatch({ start_date: '2026-10-23', end_date: '2026-10-22' }).ok, false)
  assert.equal(normalizeTravelTripPatch({ status: 'cancelled' }).ok, false)
})

test('amap links open a marker when coordinates exist and a search otherwise', () => {
  assert.equal(
    buildAmapMarkerUrl('子梅垭口', 101.8466, 29.6327),
    'https://uri.amap.com/marker?position=101.8466,29.6327&name=%E5%AD%90%E6%A2%85%E5%9E%AD%E5%8F%A3&src=hamster-nest&coordinate=gaode&callnative=1',
  )
  assert.match(buildAmapMarkerUrl('冷嘎措', null, null), /^https:\/\/uri\.amap\.com\/search\?keyword=/)
})
