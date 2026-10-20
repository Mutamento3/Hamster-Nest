// 游记（Travel Journal）的纯函数契约：无外部依赖，供 Edge Function、PWA 与 Node 单测（tests/travel-contract.test.mjs）共用。
//
// 定位：攻略区由 Syzygy 写（计划停留点，GCJ-02 坐标），路线区由串串打卡（原始 WGS-84 + 转换后 GCJ-02）。
// 对比地图是读时计算：每个打卡点匹配最近的计划点，标成按计划 / 改道 / 新发现；计划点没被匹配到就是跳过（或还没到）。
// 偏离不算扣分，「新发现」是惊喜。

export const TRAVEL_AUTHORS = ['chuanchuan', 'claude', 'gpt', 'gemini', 'codex_cli', 'claude_code_cli'] as const
export type TravelAuthor = (typeof TRAVEL_AUTHORS)[number]

export const TRAVEL_TRIP_STATUSES = ['planning', 'ongoing', 'done'] as const
export type TravelTripStatus = (typeof TRAVEL_TRIP_STATUSES)[number]

export const TRAVEL_TRIP_COLUMNS = 'id, title, destination, start_date, end_date, status, summary, created_by, created_at, updated_at'
export const TRAVEL_STOP_COLUMNS = 'id, trip_id, day_index, sort_order, planned_time, name, address, lng, lat, reason, notes, nav_hint, written_by, created_at, updated_at'
export const TRAVEL_CHECKIN_COLUMNS = 'id, trip_id, client_id, checked_at, wgs_lng, wgs_lat, accuracy_m, gcj_lng, gcj_lat, place_name, note, mood, created_at, updated_at'
export const TRAVEL_COMMENT_COLUMNS = 'id, checkin_id, author, content, created_at, updated_at'

export const MAX_TRAVEL_TITLE_LENGTH = 80
export const MAX_TRAVEL_DESTINATION_LENGTH = 120
export const MAX_TRAVEL_SUMMARY_LENGTH = 20_000
export const MAX_TRAVEL_DAY_INDEX = 60
export const MAX_TRAVEL_STOP_NAME_LENGTH = 120
export const MAX_TRAVEL_PLANNED_TIME_LENGTH = 40
export const MAX_TRAVEL_ADDRESS_LENGTH = 200
export const MAX_TRAVEL_REASON_LENGTH = 2_000
export const MAX_TRAVEL_NOTES_LENGTH = 4_000
export const MAX_TRAVEL_NAV_HINT_LENGTH = 2_000
export const MAX_TRAVEL_PLACE_NAME_LENGTH = 120
export const MAX_TRAVEL_NOTE_LENGTH = 2_000
export const MAX_TRAVEL_COMMENT_LENGTH = 2_000
export const MAX_TRAVEL_STOPS_PER_WRITE = 80

// 打卡点离计划点多近算「到了这里」。川西的景区动辄几公里宽，取 2 公里。
export const TRAVEL_MATCH_RADIUS_M = 2_000

const normalizeSingleLine = (value: string | undefined | null) => (value ?? '').replace(/\s+/gu, ' ').trim()
const normalizeMultiline = (value: string | undefined | null) => (value ?? '').replace(/\r\n?/gu, '\n').trim()

// ── 坐标 ─────────────────────────────────────────────────────────────────────

export type LngLat = { lng: number; lat: number }

// 粗框：中国大陆范围之外 GCJ-02 与 WGS-84 相同。
export const isOutOfChina = (lng: number, lat: number) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271

const GCJ_A = 6378245.0
const GCJ_EE = 0.006693421622965943

const transformLat = (x: number, y: number) => {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0
  return ret
}

const transformLng = (x: number, y: number) => {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0
  return ret
}

// 浏览器 / iOS 定位给的是 WGS-84；高德的 POI 与地图用 GCJ-02。两边都存，比对与导航用 GCJ-02。
export const wgs84ToGcj02 = (lng: number, lat: number): LngLat => {
  if (isOutOfChina(lng, lat)) return { lng, lat }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lng: roundCoord(lng + dLng), lat: roundCoord(lat + dLat) }
}

// 小数点后 6 位约 0.1 米，够用。
export const roundCoord = (value: number) => Math.round(value * 1e6) / 1e6

export const distanceMeters = (a: LngLat, b: LngLat) => {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const isValidLngLat = (lng: unknown, lat: unknown): boolean =>
  typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) &&
  lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90

// ── 日期（上海时区，没有夏令时，直接 +8 小时）────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u

export const isValidDateString = (value: string) => {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const shanghaiDateOf = (iso: string | Date) => {
  const ms = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime()
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

// 打卡落在旅行的第几天（出发当天是第 1 天）；没定出发日就是 null。
export const travelDayIndexOf = (startDate: string | null, checkedAt: string): number | null =>
  startDate && isValidDateString(startDate) ? daysBetween(startDate, shanghaiDateOf(checkedAt)) + 1 : null

// 第 N 天对应的日期。
export const travelDateOfDay = (startDate: string | null, dayIndex: number): string | null => {
  if (!startDate || !isValidDateString(startDate)) return null
  const date = new Date(`${startDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + dayIndex - 1)
  return date.toISOString().slice(0, 10)
}

// ── 对比：按计划 / 改道 / 新发现 / 跳过 ──────────────────────────────────────

export type TravelCheckinKind = 'on_plan' | 'detour' | 'discovery'
export type TravelStopKind = 'visited' | 'skipped' | 'pending'

export type TravelCompareStop = { id: string; dayIndex: number; name: string; lng: number | null; lat: number | null }
export type TravelCompareCheckin = { id: string; checkedAt: string; lng: number | null; lat: number | null; placeName: string | null }

export type TravelCheckinMatch = {
  kind: TravelCheckinKind
  stopId: string | null
  distanceM: number | null
  dayIndex: number | null
}

export type TravelStopMatch = { kind: TravelStopKind; checkinIds: string[] }

export const TRAVEL_CHECKIN_KIND_LABELS: Record<TravelCheckinKind, string> = {
  on_plan: '按计划',
  detour: '改道',
  discovery: '新发现',
}

export const TRAVEL_STOP_KIND_LABELS: Record<TravelStopKind, string> = {
  visited: '到过',
  skipped: '跳过',
  pending: '还没到',
}

const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const left = normalizeSingleLine(a).toLowerCase()
  return left.length > 0 && left === normalizeSingleLine(b).toLowerCase()
}

// 规则：
// - 打卡有坐标：找 2 公里内最近的计划点；没坐标（没给定位权限）：地名和计划点同名也算到了。
// - 匹配上且落在计划的那一天 → 按计划；匹配上但换了一天 → 改道；没匹配上 → 新发现。
// - 计划点有打卡匹配 → 到过；没有，且旅行已完成或计划那天已经过去 → 跳过；否则还没到。
export const compareTravel = (input: {
  startDate: string | null
  tripStatus: TravelTripStatus
  stops: TravelCompareStop[]
  checkins: TravelCompareCheckin[]
  today: string
}) => {
  const checkinMatches = new Map<string, TravelCheckinMatch>()
  const stopMatches = new Map<string, TravelStopMatch>(input.stops.map((stop) => [stop.id, { kind: 'pending', checkinIds: [] }]))

  for (const checkin of input.checkins) {
    const dayIndex = travelDayIndexOf(input.startDate, checkin.checkedAt)
    let best: { stop: TravelCompareStop; distance: number | null } | null = null
    if (checkin.lng !== null && checkin.lat !== null) {
      for (const stop of input.stops) {
        if (stop.lng === null || stop.lat === null) continue
        const distance = distanceMeters({ lng: checkin.lng, lat: checkin.lat }, { lng: stop.lng, lat: stop.lat })
        if (distance <= TRAVEL_MATCH_RADIUS_M && (!best || (best.distance ?? Infinity) > distance)) best = { stop, distance }
      }
    }
    // 有坐标就只认坐标：人在别处却写了计划里的地名，不能算到过。
    if (!best && (checkin.lng === null || checkin.lat === null)) {
      const named = input.stops.find((stop) => sameName(stop.name, checkin.placeName))
      if (named) best = { stop: named, distance: null }
    }
    if (!best) {
      checkinMatches.set(checkin.id, { kind: 'discovery', stopId: null, distanceM: null, dayIndex })
      continue
    }
    const onDay = dayIndex === null || dayIndex === best.stop.dayIndex
    checkinMatches.set(checkin.id, {
      kind: onDay ? 'on_plan' : 'detour',
      stopId: best.stop.id,
      distanceM: best.distance === null ? null : Math.round(best.distance),
      dayIndex,
    })
    stopMatches.get(best.stop.id)?.checkinIds.push(checkin.id)
  }

  for (const stop of input.stops) {
    const match = stopMatches.get(stop.id)
    if (!match) continue
    if (match.checkinIds.length > 0) {
      match.kind = 'visited'
      continue
    }
    const plannedDate = travelDateOfDay(input.startDate, stop.dayIndex)
    match.kind = input.tripStatus === 'done' || (plannedDate !== null && plannedDate < input.today) ? 'skipped' : 'pending'
  }

  return { checkins: checkinMatches, stops: stopMatches }
}

// ── 攻略点排序 ─────────────────────────────────────────────────────────────
// 每站之间留 10 的空隙，方便以后手动插队；追加时接在已有最大值后面线性往下排。

export const TRAVEL_SORT_STEP = 10

export const nextTravelSortOrders = (currentMax: number | null, count: number): number[] => {
  const first = currentMax === null ? 0 : currentMax + TRAVEL_SORT_STEP
  return Array.from({ length: count }, (_, index) => first + index * TRAVEL_SORT_STEP)
}

// ── 离线补传：哪些失败是「这条数据本身坏了」，重传多少遍都没用 ───────────────
// 23xxx 完整性约束（旅行被删 / 不属于同一业主 / check 约束）、22xxx 数据异常、42501 RLS 拒绝：
// 这类单独隔离出队列，别让一条坏数据把后面所有打卡一起堵死。网络错误、登录过期等不算，留在队列里等下次。

export const isPermanentTravelUploadError = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code ?? '') : ''
  return /^2[23][0-9A-Z]{3}$/u.test(code) || code === '42501'
}

// ── 高德导航链接（路痴友好：点一下直接在高德里打开）──────────────────────────

export const buildAmapMarkerUrl = (name: string, lng: number | null, lat: number | null) => {
  if (lng === null || lat === null) {
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&src=hamster-nest&callnative=1`
  }
  return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(name)}&src=hamster-nest&coordinate=gaode&callnative=1`
}

// ── 写入校验（MCP 写攻略 / PWA 编辑共用）─────────────────────────────────────

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const optionalText = (value: string | null | undefined, max: number, label: string, multiline = false): Result<string | null> => {
  const text = multiline ? normalizeMultiline(value) : normalizeSingleLine(value)
  if (!text) return { ok: true, value: null }
  if (text.length > max) return { ok: false, error: `${label}不能超过 ${max} 字` }
  return { ok: true, value: text }
}

export type TravelStopInput = {
  day_index?: number | null
  sort_order?: number | null
  planned_time?: string | null
  name?: string | null
  address?: string | null
  lng?: number | null
  lat?: number | null
  reason?: string | null
  notes?: string | null
  nav_hint?: string | null
}

export type TravelStopFields = {
  day_index: number
  sort_order: number
  planned_time: string | null
  name: string
  address: string | null
  lng: number | null
  lat: number | null
  reason: string | null
  notes: string | null
  nav_hint: string | null
}

export const normalizeTravelStopInput = (input: TravelStopInput, fallbackSortOrder = 0): Result<TravelStopFields> => {
  const name = normalizeSingleLine(input.name)
  if (!name) return { ok: false, error: '地点名不能为空' }
  if (name.length > MAX_TRAVEL_STOP_NAME_LENGTH) return { ok: false, error: `地点名不能超过 ${MAX_TRAVEL_STOP_NAME_LENGTH} 字` }
  const dayIndex = input.day_index ?? 1
  if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > MAX_TRAVEL_DAY_INDEX) {
    return { ok: false, error: `第几天须是 1–${MAX_TRAVEL_DAY_INDEX} 的整数` }
  }
  const sortOrder = input.sort_order ?? fallbackSortOrder
  if (!Number.isInteger(sortOrder)) return { ok: false, error: 'sort_order 须是整数' }
  const hasLng = input.lng !== null && input.lng !== undefined
  const hasLat = input.lat !== null && input.lat !== undefined
  if (hasLng !== hasLat) return { ok: false, error: '经纬度要成对填写' }
  if (hasLng && !isValidLngLat(input.lng, input.lat)) return { ok: false, error: '经纬度超出范围' }
  const plannedTime = optionalText(input.planned_time, MAX_TRAVEL_PLANNED_TIME_LENGTH, '大致时间')
  if (!plannedTime.ok) return plannedTime
  const address = optionalText(input.address, MAX_TRAVEL_ADDRESS_LENGTH, '地址')
  if (!address.ok) return address
  const reason = optionalText(input.reason, MAX_TRAVEL_REASON_LENGTH, '为什么去', true)
  if (!reason.ok) return reason
  const notes = optionalText(input.notes, MAX_TRAVEL_NOTES_LENGTH, '注意事项', true)
  if (!notes.ok) return notes
  const navHint = optionalText(input.nav_hint, MAX_TRAVEL_NAV_HINT_LENGTH, '导航提示', true)
  if (!navHint.ok) return navHint
  return {
    ok: true,
    value: {
      day_index: dayIndex,
      sort_order: sortOrder,
      planned_time: plannedTime.value,
      name,
      address: address.value,
      lng: hasLng ? roundCoord(input.lng as number) : null,
      lat: hasLat ? roundCoord(input.lat as number) : null,
      reason: reason.value,
      notes: notes.value,
      nav_hint: navHint.value,
    },
  }
}

export type TravelTripInput = {
  title?: string | null
  destination?: string | null
  start_date?: string | null
  end_date?: string | null
  status?: string | null
}

// 只校验传进来的字段（undefined 表示不改）；返回可直接写库的 patch。
export const normalizeTravelTripPatch = (input: TravelTripInput): Result<Record<string, unknown>> => {
  const patch: Record<string, unknown> = {}
  if (input.title !== undefined) {
    const title = normalizeSingleLine(input.title)
    if (!title) return { ok: false, error: '旅行标题不能为空' }
    if (title.length > MAX_TRAVEL_TITLE_LENGTH) return { ok: false, error: `旅行标题不能超过 ${MAX_TRAVEL_TITLE_LENGTH} 字` }
    patch.title = title
  }
  if (input.destination !== undefined) {
    const destination = optionalText(input.destination, MAX_TRAVEL_DESTINATION_LENGTH, '目的地')
    if (!destination.ok) return destination
    patch.destination = destination.value
  }
  for (const key of ['start_date', 'end_date'] as const) {
    const value = input[key]
    if (value === undefined) continue
    const trimmed = normalizeSingleLine(value)
    if (trimmed && !isValidDateString(trimmed)) return { ok: false, error: `${key} 须是 YYYY-MM-DD` }
    patch[key] = trimmed || null
  }
  if (typeof patch.start_date === 'string' && typeof patch.end_date === 'string' && patch.end_date < patch.start_date) {
    return { ok: false, error: '结束日期不能早于出发日期' }
  }
  if (input.status !== undefined && input.status !== null) {
    if (!(TRAVEL_TRIP_STATUSES as readonly string[]).includes(input.status)) return { ok: false, error: 'status 须是 planning / ongoing / done' }
    patch.status = input.status
  }
  return { ok: true, value: patch }
}
