import type { TravelCheckin, TravelTrip, TravelTripStatus } from '../types'
import type { TravelCheckinUpload, TravelTripBundle } from '../storage/supabaseSync'
import { uploadTravelCheckins } from '../storage/supabaseSync'
import { getRecordSourceLabel } from '../constants/recordSources'
import { isPermanentTravelUploadError, normalizeTravelTripPatch } from '../../supabase/functions/hamster-mcp/travel_contract'

// 游记共用：标签、离线打卡队列、离线缓存、定位、示意地图投影。
// 对比规则与坐标转换在 travel_contract.ts（与 MCP 共用）。

export const TRAVEL_STATUS_LABELS: Record<TravelTripStatus, string> = {
  planning: '计划中',
  ongoing: '进行中',
  done: '已完成',
}

export const TRAVEL_STATUS_OPTIONS: TravelTripStatus[] = ['planning', 'ongoing', 'done']

export const TRAVEL_MOODS = ['😊', '🤩', '🥹', '😮‍💨', '🥶', '😴', '🤤', '🏔️']

// 写攻略 / 留言的是谁：串串是 🐹，各端口是 🩵 + 端口名。
export const getTravelAuthorLabel = (author: string) =>
  author === 'chuanchuan' ? '🐹 串串' : `🩵 ${getRecordSourceLabel(author)}`

// ── 旅行编辑表单 ───────────────────────────────────────────────────────────

export type TripEditorState = {
  title: string
  destination: string
  startDate: string
  endDate: string
  status: TravelTripStatus
}

export const emptyTripEditor = (): TripEditorState => ({ title: '', destination: '', startDate: '', endDate: '', status: 'planning' })

export const tripToEditor = (trip: TravelTrip): TripEditorState => ({
  title: trip.title,
  destination: trip.destination ?? '',
  startDate: trip.startDate ?? '',
  endDate: trip.endDate ?? '',
  status: trip.status,
})

// 返回可直接交给 createTravelTrip / updateTravelTrip 的字段（校验规则与 MCP 共用）。
export const tripEditorToPatch = (editor: TripEditorState) => {
  const result = normalizeTravelTripPatch({
    title: editor.title,
    destination: editor.destination,
    start_date: editor.startDate,
    end_date: editor.endDate,
    status: editor.status,
  })
  if (!result.ok) return result
  return {
    ok: true as const,
    value: {
      title: result.value.title as string,
      destination: (result.value.destination as string | null) ?? null,
      startDate: (result.value.start_date as string | null) ?? null,
      endDate: (result.value.end_date as string | null) ?? null,
      status: editor.status,
    },
  }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export const formatTravelDate = (date: string) => {
  const [, month, day] = date.split('-')
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]
  return `${Number(month)}/${Number(day)} 周${weekday}`
}

export const formatTravelDateRange = (trip: Pick<TravelTrip, 'startDate' | 'endDate'>) => {
  if (!trip.startDate) return '日期未定'
  if (!trip.endDate || trip.endDate === trip.startDate) return formatTravelDate(trip.startDate)
  return `${formatTravelDate(trip.startDate)} – ${formatTravelDate(trip.endDate)}`
}

// 打卡时间按手机本地时区显示（人在川西就是上海时区）。
export const formatCheckinTime = (iso: string) => {
  const date = new Date(iso)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const formatDistance = (meters: number) => (meters < 1000 ? `${Math.round(meters)} 米` : `${(meters / 1000).toFixed(1)} 公里`)

const safeStorage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

const readJson = <T,>(key: string, fallback: T): T => {
  const storage = safeStorage()
  if (!storage) return fallback
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const writeJson = (key: string, value: unknown) => {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('游记本地存储写入失败', error)
  }
}

// ── 离线打卡队列 ───────────────────────────────────────────────────────────
// 川西很多路段没信号：按下打卡先进手机本地队列，有信号再补传。上传是幂等的（client_id），
// 所以「传成功了但回包丢了」也不怕重传。

const PENDING_KEY = 'hamster-nest:travel:pending-checkins:v1'

export const readPendingCheckins = (): TravelCheckinUpload[] => {
  const list = readJson<TravelCheckinUpload[]>(PENDING_KEY, [])
  return Array.isArray(list) ? list.filter((item) => item && typeof item.clientId === 'string') : []
}

export const addPendingCheckin = (upload: TravelCheckinUpload) => {
  const list = readPendingCheckins().filter((item) => item.clientId !== upload.clientId)
  writeJson(PENDING_KEY, [...list, upload])
}

export const removePendingCheckins = (predicate: (item: TravelCheckinUpload) => boolean) => {
  writeJson(PENDING_KEY, readPendingCheckins().filter((item) => !predicate(item)))
}

export const createCheckinClientId = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // 非安全上下文没有 randomUUID，走下面的兜底。
  }
  return `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

// 传不上去的坏数据（比如旅行在别的设备上被删了）隔离到这里，不删、不重试，留给串串看一眼再清。
const FAILED_KEY = 'hamster-nest:travel:failed-checkins:v1'

export type FailedTravelCheckin = { upload: TravelCheckinUpload; error: string; failedAt: string }

export const readFailedCheckins = (): FailedTravelCheckin[] => {
  const list = readJson<FailedTravelCheckin[]>(FAILED_KEY, [])
  return Array.isArray(list) ? list.filter((item) => item && item.upload && typeof item.upload.clientId === 'string') : []
}

export const clearFailedCheckins = () => writeJson(FAILED_KEY, [])

const quarantineCheckins = (items: FailedTravelCheckin[]) => {
  if (items.length === 0) return
  const ids = new Set(items.map((item) => item.upload.clientId))
  writeJson(FAILED_KEY, [...readFailedCheckins().filter((item) => !ids.has(item.upload.clientId)), ...items])
  removePendingCheckins((item) => ids.has(item.clientId))
}

const errorMessage = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)

let flushing: Promise<number> | null = null

// 把队列里的打卡送上去，返回这次送达的条数。离线或网络失败时原样留在队列里；
// 整批因为某条数据本身坏了而被拒时，逐条重传，把坏的那几条隔离出去，好的照常送达。
export const flushPendingCheckins = async (): Promise<number> => {
  if (flushing) return flushing
  flushing = (async () => {
    const pending = readPendingCheckins()
    if (pending.length === 0) return 0
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0
    try {
      const sent = new Set(await uploadTravelCheckins(pending))
      removePendingCheckins((item) => sent.has(item.clientId))
      return sent.size
    } catch (batchError) {
      if (!isPermanentTravelUploadError(batchError)) throw batchError
    }
    let sentCount = 0
    const broken: FailedTravelCheckin[] = []
    for (const item of pending) {
      try {
        await uploadTravelCheckins([item])
        removePendingCheckins((queued) => queued.clientId === item.clientId)
        sentCount += 1
      } catch (itemError) {
        if (!isPermanentTravelUploadError(itemError)) throw itemError
        broken.push({ upload: item, error: errorMessage(itemError), failedAt: new Date().toISOString() })
      }
    }
    quarantineCheckins(broken)
    return sentCount
  })()
  try {
    return await flushing
  } finally {
    flushing = null
  }
}

// 本地排队中的打卡长得和库里的一样，方便路线 / 地图一起画。
export const pendingToCheckin = (upload: TravelCheckinUpload): TravelCheckin => ({
  id: `pending:${upload.clientId}`,
  userId: '',
  tripId: upload.tripId,
  clientId: upload.clientId,
  checkedAt: upload.checkedAt,
  wgsLng: upload.wgsLng,
  wgsLat: upload.wgsLat,
  accuracyM: upload.accuracyM,
  gcjLng: upload.gcjLng,
  gcjLat: upload.gcjLat,
  placeName: upload.placeName,
  note: upload.note,
  mood: upload.mood,
  createdAt: upload.checkedAt,
  updatedAt: upload.checkedAt,
})

export const isPendingCheckin = (checkin: TravelCheckin) => checkin.id.startsWith('pending:')

// ── 离线缓存：没信号时也能翻攻略 ─────────────────────────────────────────────

const TRIPS_CACHE_KEY = 'hamster-nest:travel:trips:v1'
const bundleCacheKey = (tripId: string) => `hamster-nest:travel:trip:${tripId}:v1`

export const readCachedTrips = () => readJson<TravelTrip[] | null>(TRIPS_CACHE_KEY, null)
export const writeCachedTrips = (trips: TravelTrip[]) => writeJson(TRIPS_CACHE_KEY, trips)
export const readCachedBundle = (tripId: string) => readJson<TravelTripBundle | null>(bundleCacheKey(tripId), null)
export const writeCachedBundle = (bundle: TravelTripBundle) => writeJson(bundleCacheKey(bundle.trip.id), bundle)
export const dropCachedBundle = (tripId: string) => {
  try {
    safeStorage()?.removeItem(bundleCacheKey(tripId))
  } catch {
    // 忽略
  }
}

// ── 定位 ─────────────────────────────────────────────────────────────────────
// GPS 不需要信号，没网也能定位；拿到的是 WGS-84。

export type TravelPosition = { lng: number; lat: number; accuracy: number | null }

export const getCurrentTravelPosition = () =>
  new Promise<TravelPosition>((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('这个浏览器拿不到定位'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lng: position.coords.longitude,
          lat: position.coords.latitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? '定位权限被拒绝了，可以去设置里打开；不打开也能只记地名'
            : error.code === error.TIMEOUT
              ? '定位超时了，换个开阔点再试试'
              : '暂时拿不到定位'
        reject(new Error(message))
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    )
  })

// ── 示意地图投影 ─────────────────────────────────────────────────────────────
// 不接地图瓦片（离线也要能看），只把经纬度等距投影到一个框里；经度按纬度余弦压缩，形状不变形。

export type MapPoint = { lng: number; lat: number }

export const createMapProjection = (points: MapPoint[], width: number, height: number, padding = 28) => {
  if (points.length === 0) return null
  const lngs = points.map((point) => point.lng)
  const lats = points.map((point) => point.lat)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const midLat = (minLat + maxLat) / 2
  const kx = Math.cos((midLat * Math.PI) / 180)
  // 只有一个点或点重合时给一个最小跨度（约 1 公里），别除以 0。
  const spanX = Math.max((maxLng - minLng) * kx, 0.01)
  const spanY = Math.max(maxLat - minLat, 0.01)
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2
  const centerLng = (minLng + maxLng) / 2
  const centerLat = (minLat + maxLat) / 2
  return (point: MapPoint) => ({
    x: offsetX + ((point.lng - centerLng) * kx + spanX / 2) * scale,
    y: offsetY + (centerLat - point.lat + spanY / 2) * scale,
  })
}
