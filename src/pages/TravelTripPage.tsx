import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { TravelCheckin, TravelCheckinComment, TravelPlanStop, TravelTripStatus } from '../types'
import {
  createTravelComment,
  createTravelStop,
  deleteTravelCheckin,
  deleteTravelComment,
  deleteTravelStop,
  deleteTravelTrip,
  getTravelTripBundle,
  updateTravelCheckin,
  updateTravelStop,
  updateTravelTrip,
  uploadTravelCheckins,
  type TravelCheckinUpload,
  type TravelTripBundle,
} from '../storage/supabaseSync'
import {
  TRAVEL_CHECKIN_KIND_LABELS,
  TRAVEL_MATCH_RADIUS_M,
  TRAVEL_STOP_KIND_LABELS,
  buildAmapMarkerUrl,
  compareTravel,
  distanceMeters,
  normalizeTravelStopInput,
  shanghaiDateOf,
  travelDateOfDay,
  travelDayIndexOf,
  wgs84ToGcj02,
  type TravelCheckinKind,
  type TravelStopKind,
} from '../../supabase/functions/hamster-mcp/travel_contract'
import MarkdownRenderer from '../components/MarkdownRenderer'
import ConfirmDialog from '../components/ConfirmDialog'
import TravelTripEditorFields from '../components/TravelTripEditorFields'
import {
  TRAVEL_MOODS,
  TRAVEL_STATUS_LABELS,
  addPendingCheckin,
  createCheckinClientId,
  createMapProjection,
  dropCachedBundle,
  flushPendingCheckins,
  formatCheckinTime,
  formatDistance,
  formatTravelDate,
  formatTravelDateRange,
  getCurrentTravelPosition,
  getTravelAuthorLabel,
  isPendingCheckin,
  pendingToCheckin,
  readCachedBundle,
  readPendingCheckins,
  removePendingCheckins,
  tripEditorToPatch,
  tripToEditor,
  writeCachedBundle,
  type TravelPosition,
  type TripEditorState,
} from './travelShared'
import './TravelPage.css'

// 一次旅行：攻略（Syzygy 写的计划点）/ 路线（串串的打卡）/ 地图（虚线计划、实线实际）/ 复盘。
// 打卡离线优先：先进手机本地队列，再试着补传；没信号时整页从本地缓存读。

type Tab = 'plan' | 'route' | 'map' | 'summary'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'plan', label: '攻略' },
  { id: 'route', label: '路线' },
  { id: 'map', label: '地图' },
  { id: 'summary', label: '复盘' },
]

type CheckinSheet = {
  phase: 'locating' | 'ready' | 'failed'
  position: TravelPosition | null
  gcj: { lng: number; lat: number } | null
  locateError: string | null
  placeName: string
  placeTouched: boolean
  note: string
  mood: string | null
  checkedAt: string
}

type StopEditor = {
  stopId: string | null
  sortOrder: number
  dayIndex: string
  plannedTime: string
  name: string
  address: string
  coords: string
  reason: string
  notes: string
  navHint: string
}

type CheckinEditor = { checkin: TravelCheckin; placeName: string; note: string; mood: string | null }

type PendingDelete =
  | { kind: 'trip' }
  | { kind: 'stop'; stop: TravelPlanStop }
  | { kind: 'checkin'; checkin: TravelCheckin }
  | { kind: 'comment'; comment: TravelCheckinComment }

const STOP_KIND_CLASS: Record<TravelStopKind, string> = { visited: 'visited', skipped: 'skipped', pending: 'pending' }
const CHECKIN_KIND_CLASS: Record<TravelCheckinKind, string> = { on_plan: 'on-plan', detour: 'detour', discovery: 'discovery' }

const MAP_WIDTH = 360
const MAP_HEIGHT = 300

const stopToEditor = (stop: TravelPlanStop): StopEditor => ({
  stopId: stop.id,
  sortOrder: stop.sortOrder,
  dayIndex: String(stop.dayIndex),
  plannedTime: stop.plannedTime ?? '',
  name: stop.name,
  address: stop.address ?? '',
  coords: stop.lng !== null && stop.lat !== null ? `${stop.lng},${stop.lat}` : '',
  reason: stop.reason ?? '',
  notes: stop.notes ?? '',
  navHint: stop.navHint ?? '',
})

// 坐标输入框接受「经度,纬度」（高德复制出来的格式），逗号 / 空格 / 中文逗号都行。
const parseCoords = (value: string): { lng: number | null; lat: number | null } | null => {
  const trimmed = value.trim()
  if (!trimmed) return { lng: null, lat: null }
  const parts = trimmed.split(/[\s,，]+/u).filter(Boolean)
  if (parts.length !== 2) return null
  const [lng, lat] = parts.map(Number)
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null
}

const TravelTripPage = () => {
  const navigate = useNavigate()
  const { tripId = '' } = useParams<{ tripId: string }>()
  const [bundle, setBundle] = useState<TravelTripBundle | null>(() => readCachedBundle(tripId))
  const [pending, setPending] = useState<TravelCheckinUpload[]>(() => readPendingCheckins().filter((item) => item.tripId === tripId))
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('plan')
  const [saving, setSaving] = useState(false)
  const [sheet, setSheet] = useState<CheckinSheet | null>(null)
  const [stopEditor, setStopEditor] = useState<StopEditor | null>(null)
  const [tripEditor, setTripEditor] = useState<TripEditorState | null>(null)
  const [checkinEditor, setCheckinEditor] = useState<CheckinEditor | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null)
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null)

  const reloadPending = useCallback(() => {
    setPending(readPendingCheckins().filter((item) => item.tripId === tripId))
  }, [tripId])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getTravelTripBundle(tripId)
      if (!next) {
        setMissing(true)
        setBundle(null)
        dropCachedBundle(tripId)
      } else {
        setMissing(false)
        setBundle(next)
        writeCachedBundle(next)
      }
      setOffline(false)
      setError(null)
    } catch (loadError) {
      console.warn('加载旅行失败', loadError)
      setOffline(true)
      setError(readCachedBundle(tripId) ? null : '加载失败，检查一下网络')
    } finally {
      setLoading(false)
    }
  }, [tripId])

  const syncPending = useCallback(async () => {
    try {
      const sent = await flushPendingCheckins()
      if (sent > 0) {
        setNotice(`补传了 ${sent} 个打卡`)
        await refresh()
      }
    } catch (syncError) {
      console.warn('补传打卡失败', syncError)
    } finally {
      reloadPending()
    }
  }, [refresh, reloadPending])

  useEffect(() => {
    void refresh().then(() => syncPending())
    const handleOnline = () => void syncPending().then(() => refresh())
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [refresh, syncPending])

  const trip = bundle?.trip ?? null
  const stops = useMemo(() => bundle?.stops ?? [], [bundle])
  const today = shanghaiDateOf(new Date())

  // 库里的打卡 + 手机里还在排队的打卡，按按下的时刻排。
  const checkins = useMemo(() => {
    const synced = bundle?.checkins ?? []
    const syncedIds = new Set(synced.map((checkin) => checkin.clientId))
    const queued = pending.filter((item) => !syncedIds.has(item.clientId)).map(pendingToCheckin)
    return [...synced, ...queued].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
  }, [bundle, pending])

  const commentsByCheckin = useMemo(() => {
    const map = new Map<string, TravelCheckinComment[]>()
    for (const comment of bundle?.comments ?? []) map.set(comment.checkinId, [...(map.get(comment.checkinId) ?? []), comment])
    return map
  }, [bundle])

  const compared = useMemo(
    () =>
      compareTravel({
        startDate: trip?.startDate ?? null,
        tripStatus: trip?.status ?? 'planning',
        today,
        stops: stops.map((stop) => ({ id: stop.id, dayIndex: stop.dayIndex, name: stop.name, lng: stop.lng, lat: stop.lat })),
        checkins: checkins.map((checkin) => ({
          id: checkin.id,
          checkedAt: checkin.checkedAt,
          lng: checkin.gcjLng,
          lat: checkin.gcjLat,
          placeName: checkin.placeName,
        })),
      }),
    [trip, stops, checkins, today],
  )

  const stopsByDay = useMemo(() => {
    const groups = new Map<number, TravelPlanStop[]>()
    for (const stop of stops) groups.set(stop.dayIndex, [...(groups.get(stop.dayIndex) ?? []), stop])
    return [...groups.entries()].sort(([a], [b]) => a - b)
  }, [stops])

  const stopMap = useMemo(() => new Map(stops.map((stop) => [stop.id, stop])), [stops])

  const counts = useMemo(() => {
    const result = { on_plan: 0, detour: 0, discovery: 0, visited: 0, skipped: 0, pending: 0 }
    compared.checkins.forEach((match) => {
      result[match.kind] += 1
    })
    compared.stops.forEach((match) => {
      result[match.kind] += 1
    })
    return result
  }, [compared])

  const todayIndex = trip?.status === 'ongoing' ? travelDayIndexOf(trip.startDate, new Date().toISOString()) : null

  // ── 打卡 ───────────────────────────────────────────────────────────────

  const nearestStop = (gcj: { lng: number; lat: number } | null) => {
    if (!gcj) return null
    let best: { stop: TravelPlanStop; distance: number } | null = null
    for (const stop of stops) {
      if (stop.lng === null || stop.lat === null) continue
      const distance = distanceMeters(gcj, { lng: stop.lng, lat: stop.lat })
      if (!best || distance < best.distance) best = { stop, distance }
    }
    return best
  }

  const locate = async () => {
    setSheet((current) => (current ? { ...current, phase: 'locating', locateError: null } : current))
    try {
      const position = await getCurrentTravelPosition()
      const gcj = wgs84ToGcj02(position.lng, position.lat)
      const nearest = nearestStop(gcj)
      setSheet((current) => {
        if (!current) return current
        const suggested = nearest && nearest.distance <= TRAVEL_MATCH_RADIUS_M ? nearest.stop.name : ''
        return {
          ...current,
          phase: 'ready',
          position,
          gcj,
          placeName: current.placeTouched ? current.placeName : suggested,
        }
      })
    } catch (locateError) {
      setSheet((current) =>
        current ? { ...current, phase: 'failed', locateError: locateError instanceof Error ? locateError.message : '暂时拿不到定位' } : current,
      )
    }
  }

  const openCheckin = () => {
    setFormError(null)
    setSheet({
      phase: 'locating',
      position: null,
      gcj: null,
      locateError: null,
      placeName: '',
      placeTouched: false,
      note: '',
      mood: null,
      // 时间以按下「我在这里」的那一刻为准，不是保存或补传的时刻。
      checkedAt: new Date().toISOString(),
    })
    void locate()
  }

  const saveCheckin = async (event: FormEvent) => {
    event.preventDefault()
    if (!sheet || !trip) return
    const placeName = sheet.placeName.trim()
    if (!sheet.position && !placeName) {
      setFormError('没有定位的话，至少写个地名吧')
      return
    }
    const upload: TravelCheckinUpload = {
      clientId: createCheckinClientId(),
      tripId: trip.id,
      checkedAt: sheet.checkedAt,
      wgsLng: sheet.position?.lng ?? null,
      wgsLat: sheet.position?.lat ?? null,
      accuracyM: sheet.position?.accuracy ?? null,
      gcjLng: sheet.gcj?.lng ?? null,
      gcjLat: sheet.gcj?.lat ?? null,
      placeName: placeName.slice(0, 120) || null,
      note: sheet.note.trim().slice(0, 2000) || null,
      mood: sheet.mood,
    }
    if (!addPendingCheckin(upload)) {
      // 手机存储写不进（满了 / 无痕模式）：直接传；传不上就别关面板，草稿留着，不能假装存住了。
      try {
        await uploadTravelCheckins([upload])
        setSheet(null)
        setTab('route')
        setNotice('打卡成功（手机里存不下，直接传上去了）')
        await refresh()
      } catch (uploadError) {
        console.warn('打卡既存不进手机也传不上去', uploadError)
        setFormError('手机存储满了、现在也连不上，这次打卡没存住。先截个图，有信号再点一次「打卡」')
      }
      return
    }
    reloadPending()
    setSheet(null)
    setTab('route')
    try {
      const sent = await flushPendingCheckins()
      if (sent > 0) {
        setNotice('打卡成功，Syzygy 看得到了')
        await refresh()
      } else {
        setNotice('已存进手机，有信号会自动补传')
      }
    } catch (syncError) {
      console.warn('打卡上传失败，留在本地队列', syncError)
      setNotice('已存进手机，有信号会自动补传')
    } finally {
      reloadPending()
    }
  }

  // ── 攻略点 ─────────────────────────────────────────────────────────────

  const openNewStop = (dayIndex?: number) => {
    setFormError(null)
    const maxOrder = stops.reduce((max, stop) => Math.max(max, stop.sortOrder), 0)
    setStopEditor({
      stopId: null,
      sortOrder: maxOrder + 10,
      dayIndex: String(dayIndex ?? stopsByDay.at(-1)?.[0] ?? 1),
      plannedTime: '',
      name: '',
      address: '',
      coords: '',
      reason: '',
      notes: '',
      navHint: '',
    })
  }

  const saveStop = async (event: FormEvent) => {
    event.preventDefault()
    if (!stopEditor || !trip) return
    const coords = parseCoords(stopEditor.coords)
    if (!coords) {
      setFormError('坐标格式是「经度,纬度」，比如 101.8466,29.6327')
      return
    }
    const normalized = normalizeTravelStopInput(
      {
        day_index: Number(stopEditor.dayIndex),
        sort_order: stopEditor.sortOrder,
        planned_time: stopEditor.plannedTime,
        name: stopEditor.name,
        address: stopEditor.address,
        lng: coords.lng,
        lat: coords.lat,
        reason: stopEditor.reason,
        notes: stopEditor.notes,
        nav_hint: stopEditor.navHint,
      },
      stopEditor.sortOrder,
    )
    if (!normalized.ok) {
      setFormError(normalized.error)
      return
    }
    const value = normalized.value
    const payload = {
      dayIndex: value.day_index,
      sortOrder: value.sort_order,
      plannedTime: value.planned_time,
      name: value.name,
      address: value.address,
      lng: value.lng,
      lat: value.lat,
      reason: value.reason,
      notes: value.notes,
      navHint: value.nav_hint,
    }
    setSaving(true)
    try {
      if (stopEditor.stopId) await updateTravelStop(stopEditor.stopId, payload)
      else await createTravelStop(trip.id, payload)
      setStopEditor(null)
      await refresh()
    } catch (saveError) {
      console.warn('保存攻略点失败', saveError)
      setFormError('保存失败，检查一下网络再试')
    } finally {
      setSaving(false)
    }
  }

  // ── 旅行本身 ───────────────────────────────────────────────────────────

  const saveTrip = async (event: FormEvent) => {
    event.preventDefault()
    if (!tripEditor || !trip) return
    const patch = tripEditorToPatch(tripEditor)
    if (!patch.ok) {
      setFormError(patch.error)
      return
    }
    setSaving(true)
    try {
      await updateTravelTrip(trip.id, patch.value)
      setTripEditor(null)
      await refresh()
    } catch (saveError) {
      console.warn('更新旅行失败', saveError)
      setFormError('保存失败，检查一下网络再试')
    } finally {
      setSaving(false)
    }
  }

  const changeStatus = async (status: TravelTripStatus) => {
    if (!trip) return
    setSaving(true)
    try {
      await updateTravelTrip(trip.id, { status })
      setNotice(status === 'ongoing' ? '出发！路上按「我在这里」打卡' : status === 'done' ? '欢迎回家。可以让 Syzygy 写复盘了' : null)
      await refresh()
    } catch (statusError) {
      console.warn('更新旅行状态失败', statusError)
      setError('状态没改成功，检查一下网络')
    } finally {
      setSaving(false)
    }
  }

  const saveSummary = async () => {
    if (!trip || summaryDraft === null) return
    setSaving(true)
    try {
      await updateTravelTrip(trip.id, { summary: summaryDraft.trim() || null })
      setSummaryDraft(null)
      await refresh()
    } catch (saveError) {
      console.warn('保存复盘失败', saveError)
      setError('复盘没保存上，检查一下网络')
    } finally {
      setSaving(false)
    }
  }

  // ── 打卡编辑 / 留言 ────────────────────────────────────────────────────

  const saveCheckinEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!checkinEditor) return
    const { checkin } = checkinEditor
    if (checkin.gcjLng === null && checkin.gcjLat === null && !checkinEditor.placeName.trim()) {
      setFormError('这次打卡没有定位，地名得留着，不然就不知道是哪了')
      return
    }
    setSaving(true)
    try {
      await updateTravelCheckin(checkinEditor.checkin.id, {
        placeName: checkinEditor.placeName.trim().slice(0, 120) || null,
        note: checkinEditor.note.trim().slice(0, 2000) || null,
        mood: checkinEditor.mood,
      })
      setCheckinEditor(null)
      await refresh()
    } catch (saveError) {
      console.warn('更新打卡失败', saveError)
      setFormError('保存失败，检查一下网络再试')
    } finally {
      setSaving(false)
    }
  }

  const submitComment = async (checkinId: string) => {
    const content = (commentDrafts[checkinId] ?? '').trim()
    if (!content) return
    setSaving(true)
    try {
      await createTravelComment(checkinId, content.slice(0, 2000))
      setCommentDrafts((current) => ({ ...current, [checkinId]: '' }))
      await refresh()
    } catch (commentError) {
      console.warn('留言失败', commentError)
      setError('留言没发出去，检查一下网络')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete || !trip) return
    setSaving(true)
    try {
      if (pendingDelete.kind === 'trip') {
        await deleteTravelTrip(trip.id)
        removePendingCheckins((item) => item.tripId === trip.id)
        dropCachedBundle(trip.id)
        navigate('/travel')
        return
      }
      if (pendingDelete.kind === 'stop') await deleteTravelStop(pendingDelete.stop.id)
      if (pendingDelete.kind === 'checkin') {
        const { checkin } = pendingDelete
        removePendingCheckins((item) => item.clientId === checkin.clientId)
        if (!isPendingCheckin(checkin)) await deleteTravelCheckin(checkin.id)
        reloadPending()
      }
      if (pendingDelete.kind === 'comment') await deleteTravelComment(pendingDelete.comment.id)
      setPendingDelete(null)
      await refresh()
    } catch (deleteError) {
      console.warn('删除失败', deleteError)
      setError('删除失败，检查一下网络')
      setPendingDelete(null)
    } finally {
      setSaving(false)
    }
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────

  if (!trip) {
    return (
      <div className="travel-page">
        <header className="travel-header">
          <button type="button" className="ghost travel-header-btn travel-header-btn--left" onClick={() => navigate('/travel')}>
            ← 游记
          </button>
          <div className="travel-title-wrap">
            <p className="travel-kicker">Travel Journal</p>
            <h1 className="ui-title">游记</h1>
          </div>
        </header>
        <p className="travel-empty">{loading ? '加载中…' : missing ? '这次旅行找不到了，可能已经删掉了' : error ?? '加载失败'}</p>
      </div>
    )
  }

  const renderStop = (stop: TravelPlanStop) => {
    const match = compared.stops.get(stop.id)
    const kind = match?.kind ?? 'pending'
    return (
      <article key={stop.id} className={`travel-stop travel-stop--${STOP_KIND_CLASS[kind]}`}>
        <div className="travel-stop__top">
          <div className="travel-stop__title">
            {stop.plannedTime ? <span className="travel-stop__time">{stop.plannedTime}</span> : null}
            <h4>{stop.name}</h4>
          </div>
          <span className={`travel-badge travel-badge--${STOP_KIND_CLASS[kind]}`}>{TRAVEL_STOP_KIND_LABELS[kind]}</span>
        </div>
        {stop.address ? <p className="travel-stop__address">{stop.address}</p> : null}
        {stop.reason ? (
          <div className="travel-stop__block">
            <span className="travel-stop__label">为什么去</span>
            <p>{stop.reason}</p>
          </div>
        ) : null}
        {stop.notes ? (
          <div className="travel-stop__block">
            <span className="travel-stop__label">注意</span>
            <p>{stop.notes}</p>
          </div>
        ) : null}
        {stop.navHint ? (
          <div className="travel-stop__block travel-stop__nav">
            <span className="travel-stop__label">🧭 怎么走</span>
            <p>{stop.navHint}</p>
          </div>
        ) : null}
        <div className="travel-stop__actions">
          <a className="travel-amap-link" href={buildAmapMarkerUrl(stop.name, stop.lng, stop.lat)} target="_blank" rel="noreferrer">
            在高德打开 ↗
          </a>
          <span className="travel-stop__author">{getTravelAuthorLabel(stop.writtenBy)}</span>
          <button
            type="button"
            className="travel-inline-btn"
            onClick={() => {
              setFormError(null)
              setStopEditor(stopToEditor(stop))
            }}
          >
            编辑
          </button>
          <button type="button" className="travel-inline-btn travel-inline-btn--danger" onClick={() => setPendingDelete({ kind: 'stop', stop })}>
            删除
          </button>
        </div>
      </article>
    )
  }

  const renderCheckin = (checkin: TravelCheckin) => {
    const match = compared.checkins.get(checkin.id)
    const kind = match?.kind ?? 'discovery'
    const matchedStop = match?.stopId ? stopMap.get(match.stopId) : null
    const queued = isPendingCheckin(checkin)
    const comments = commentsByCheckin.get(checkin.id) ?? []
    return (
      <article key={checkin.id} className={`travel-checkin travel-checkin--${CHECKIN_KIND_CLASS[kind]}`}>
        <div className="travel-checkin__dot" aria-hidden="true">
          {checkin.mood ?? '📍'}
        </div>
        <div className="travel-checkin__body">
          <div className="travel-checkin__top">
            <h4>{checkin.placeName || '没写地名的地方'}</h4>
            <span className={`travel-badge travel-badge--${CHECKIN_KIND_CLASS[kind]}`}>{TRAVEL_CHECKIN_KIND_LABELS[kind]}</span>
          </div>
          <p className="travel-checkin__meta">
            {formatCheckinTime(checkin.checkedAt)}
            {match?.dayIndex ? ` · 第 ${match.dayIndex} 天` : ''}
            {matchedStop
              ? ` · ${kind === 'detour' ? `原计划第 ${matchedStop.dayIndex} 天的` : '对上了'}「${matchedStop.name}」${match?.distanceM !== null && match?.distanceM !== undefined ? `（${formatDistance(match.distanceM)}）` : ''}`
              : ''}
            {queued ? <span className="travel-queued"> · 📮 待补传</span> : null}
          </p>
          {checkin.note ? <p className="travel-checkin__note">{checkin.note}</p> : null}
          {checkin.gcjLng !== null && checkin.gcjLat !== null ? (
            <p className="travel-checkin__coords">
              <a href={buildAmapMarkerUrl(checkin.placeName || '打卡点', checkin.gcjLng, checkin.gcjLat)} target="_blank" rel="noreferrer">
                {checkin.gcjLng.toFixed(5)}, {checkin.gcjLat.toFixed(5)}
              </a>
              {checkin.accuracyM !== null ? ` · 精度约 ${formatDistance(checkin.accuracyM)}` : ''}
            </p>
          ) : (
            <p className="travel-checkin__coords">没有定位，只记了地名</p>
          )}
          <div className="travel-stop__actions">
            {!queued ? (
              <button
                type="button"
                className="travel-inline-btn"
                onClick={() => {
                  setFormError(null)
                  setCheckinEditor({ checkin, placeName: checkin.placeName ?? '', note: checkin.note ?? '', mood: checkin.mood })
                }}
              >
                编辑
              </button>
            ) : null}
            <button type="button" className="travel-inline-btn travel-inline-btn--danger" onClick={() => setPendingDelete({ kind: 'checkin', checkin })}>
              删除
            </button>
          </div>
          {!queued ? (
            <div className="travel-comments">
              {comments.map((comment) => (
                <div key={comment.id} className={comment.author === 'chuanchuan' ? 'travel-comment travel-comment--mine' : 'travel-comment'}>
                  <span className="travel-comment__author">{getTravelAuthorLabel(comment.author)}</span>
                  <p>{comment.content}</p>
                  <button type="button" className="travel-comment__delete" aria-label="删除留言" onClick={() => setPendingDelete({ kind: 'comment', comment })}>
                    ×
                  </button>
                </div>
              ))}
              <div className="travel-comment-form">
                <input
                  value={commentDrafts[checkin.id] ?? ''}
                  placeholder="留一句…"
                  maxLength={2000}
                  onChange={(event) => setCommentDrafts((current) => ({ ...current, [checkin.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void submitComment(checkin.id)
                    }
                  }}
                />
                <button type="button" className="travel-inline-btn" disabled={saving || !(commentDrafts[checkin.id] ?? '').trim()} onClick={() => void submitComment(checkin.id)}>
                  发送
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  const renderMap = () => {
    const mappedStops = stops.filter((stop) => stop.lng !== null && stop.lat !== null)
    const mappedCheckins = checkins.filter((checkin) => checkin.gcjLng !== null && checkin.gcjLat !== null)
    const project = createMapProjection(
      [
        ...mappedStops.map((stop) => ({ lng: stop.lng as number, lat: stop.lat as number })),
        ...mappedCheckins.map((checkin) => ({ lng: checkin.gcjLng as number, lat: checkin.gcjLat as number })),
      ],
      MAP_WIDTH,
      MAP_HEIGHT,
    )
    if (!project) {
      return <p className="travel-empty">攻略点和打卡都还没有坐标，地图画不出来。</p>
    }
    const stopPoints = mappedStops.map((stop) => ({ stop, ...project({ lng: stop.lng as number, lat: stop.lat as number }) }))
    const checkinPoints = mappedCheckins.map((checkin) => ({ checkin, ...project({ lng: checkin.gcjLng as number, lat: checkin.gcjLat as number }) }))
    const selectedStop = selectedPoint ? stopPoints.find((point) => point.stop.id === selectedPoint)?.stop : null
    const selectedCheckin = selectedPoint ? checkinPoints.find((point) => point.checkin.id === selectedPoint)?.checkin : null
    return (
      <div className="travel-map-card">
        <svg className="travel-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="攻略与实际路线对比示意图">
          <rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} rx="16" className="travel-map__bg" />
          {stopPoints.length > 1 ? (
            <polyline className="travel-map__plan-line" points={stopPoints.map((point) => `${point.x},${point.y}`).join(' ')} />
          ) : null}
          {checkinPoints.length > 1 ? (
            <polyline className="travel-map__route-line" points={checkinPoints.map((point) => `${point.x},${point.y}`).join(' ')} />
          ) : null}
          {stopPoints.map(({ stop, x, y }) => {
            const kind = compared.stops.get(stop.id)?.kind ?? 'pending'
            return (
              <g key={stop.id} className={`travel-map__stop travel-map__stop--${STOP_KIND_CLASS[kind]}`} onClick={() => setSelectedPoint(stop.id)}>
                <circle cx={x} cy={y} r={10} />
                <text x={x} y={y + 3.5} textAnchor="middle">
                  {stop.dayIndex}
                </text>
              </g>
            )
          })}
          {checkinPoints.map(({ checkin, x, y }) => {
            const kind = compared.checkins.get(checkin.id)?.kind ?? 'discovery'
            return (
              <circle
                key={checkin.id}
                cx={x}
                cy={y}
                r={selectedPoint === checkin.id ? 7.5 : 5.5}
                className={`travel-map__checkin travel-map__checkin--${CHECKIN_KIND_CLASS[kind]}`}
                onClick={() => setSelectedPoint(checkin.id)}
              />
            )
          })}
        </svg>
        <p className="travel-map__caption">
          {selectedStop
            ? `计划 · 第 ${selectedStop.dayIndex} 天 · ${selectedStop.name}（${TRAVEL_STOP_KIND_LABELS[compared.stops.get(selectedStop.id)?.kind ?? 'pending']}）`
            : selectedCheckin
              ? `打卡 · ${formatCheckinTime(selectedCheckin.checkedAt)} · ${selectedCheckin.placeName || '没写地名'}（${TRAVEL_CHECKIN_KIND_LABELS[compared.checkins.get(selectedCheckin.id)?.kind ?? 'discovery']}）`
              : '点地图上的点看看是哪里'}
        </p>
        <div className="travel-map__legend">
          <span><i className="legend-line legend-line--plan" />攻略（虚线，数字是第几天）</span>
          <span><i className="legend-line legend-line--route" />实际路线</span>
          <span><i className="legend-dot legend-dot--on-plan" />按计划 {counts.on_plan}</span>
          <span><i className="legend-dot legend-dot--detour" />改道 {counts.detour}</span>
          <span><i className="legend-dot legend-dot--discovery" />新发现 {counts.discovery}</span>
          <span><i className="legend-ring legend-ring--skipped" />跳过 {counts.skipped}</span>
        </div>
        <p className="travel-map__note">示意图，不是真地图：只按经纬度把点摆出来，没信号也能看。看真地图点攻略里的「在高德打开」。</p>
      </div>
    )
  }

  const canCheckin = trip.status !== 'done'

  return (
    <div className="travel-page">
      <header className="travel-header">
        <button type="button" className="ghost travel-header-btn travel-header-btn--left" onClick={() => navigate('/travel')}>
          ← 游记
        </button>
        <div className="travel-title-wrap">
          <p className="travel-kicker">{formatTravelDateRange(trip)}</p>
          <h1 className="ui-title travel-detail-title">{trip.title}</h1>
        </div>
        <button
          type="button"
          className="travel-header-btn travel-header-btn--right"
          onClick={() => {
            setFormError(null)
            setTripEditor(tripToEditor(trip))
          }}
        >
          编辑
        </button>
      </header>

      <section className="travel-intro-card travel-trip-summary">
        <div className="travel-trip-summary__row">
          <span className={`travel-status travel-status--${trip.status}`}>{TRAVEL_STATUS_LABELS[trip.status]}</span>
          {trip.destination ? <span className="travel-trip-summary__dest">📍 {trip.destination}</span> : null}
          {todayIndex !== null && todayIndex >= 1 ? <span className="travel-trip-summary__day">今天是第 {todayIndex} 天</span> : null}
        </div>
        <p className="travel-trip-summary__stats">
          攻略 {stops.length} 站 · 打卡 {checkins.length} 次 · 按计划 {counts.on_plan} · 改道 {counts.detour} · 新发现 {counts.discovery}
          {counts.skipped > 0 ? ` · 跳过 ${counts.skipped}` : ''}
        </p>
        <div className="travel-trip-summary__actions">
          {trip.status === 'planning' ? (
            <button type="button" className="travel-chip" disabled={saving} onClick={() => void changeStatus('ongoing')}>
              🚗 出发啦
            </button>
          ) : null}
          {trip.status === 'ongoing' ? (
            <button type="button" className="travel-chip" disabled={saving} onClick={() => void changeStatus('done')}>
              🏠 回家啦
            </button>
          ) : null}
        </div>
      </section>

      {canCheckin ? (
        <button type="button" className="travel-checkin-btn" onClick={openCheckin}>
          <span className="travel-checkin-btn__icon" aria-hidden="true">📍</span>
          <span>
            <strong>我在这里</strong>
            <small>没信号也能打，先存在手机里</small>
          </span>
        </button>
      ) : null}

      {offline ? <p className="travel-offline">📴 现在连不上，看的是上次存下的；打卡照常，有信号会自动补传</p> : null}
      {pending.length > 0 ? (
        <button type="button" className="travel-pending-banner" onClick={() => void syncPending()}>
          📮 {pending.length} 个打卡在手机里排队，点一下试着补传
        </button>
      ) : null}
      {notice ? <p className="travel-notice">{notice}</p> : null}
      {error ? <p className="travel-error">{error}</p> : null}

      <nav className="travel-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'travel-tab selected' : 'travel-tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'plan' ? (
        <section className="travel-section">
          {stopsByDay.length === 0 ? (
            <p className="travel-empty">
              还没有攻略。把行程告诉 Syzygy，让 ta 用 <code>write_trip_plan</code> 写进来；也可以自己先加几站。
            </p>
          ) : (
            stopsByDay.map(([dayIndex, dayStops]) => {
              const date = travelDateOfDay(trip.startDate, dayIndex)
              return (
                <div key={dayIndex} className={todayIndex === dayIndex ? 'travel-day travel-day--today' : 'travel-day'}>
                  <h3 className="travel-day__title">
                    第 {dayIndex} 天{date ? <small> · {formatTravelDate(date)}</small> : null}
                    {todayIndex === dayIndex ? <span className="travel-day__today">今天</span> : null}
                  </h3>
                  <div className="travel-stop-list">{dayStops.map(renderStop)}</div>
                </div>
              )
            })
          )}
          <button type="button" className="travel-add-btn" onClick={() => openNewStop()}>
            + 加一站
          </button>
        </section>
      ) : null}

      {tab === 'route' ? (
        <section className="travel-section">
          {checkins.length === 0 ? (
            <p className="travel-empty">{canCheckin ? '还没有打卡。到了一个地方，就按上面的「我在这里」。' : '这次旅行没有打卡。'}</p>
          ) : (
            <div className="travel-route">{checkins.map(renderCheckin)}</div>
          )}
        </section>
      ) : null}

      {tab === 'map' ? <section className="travel-section">{renderMap()}</section> : null}

      {tab === 'summary' ? (
        <section className="travel-section travel-summary-card">
          {summaryDraft !== null ? (
            <>
              <textarea
                className="travel-summary-input"
                value={summaryDraft}
                rows={12}
                maxLength={20000}
                placeholder="这一趟怎么样？哪里按计划，哪里改道了，最大的新发现是什么…"
                onChange={(event) => setSummaryDraft(event.target.value)}
              />
              <div className="travel-sheet-actions">
                <button type="button" className="ghost" onClick={() => setSummaryDraft(null)} disabled={saving}>
                  取消
                </button>
                <button type="button" className="travel-primary-btn" onClick={() => void saveSummary()} disabled={saving}>
                  {saving ? '保存中…' : '保存复盘'}
                </button>
              </div>
            </>
          ) : trip.summary ? (
            <>
              <MarkdownRenderer content={trip.summary} />
              <button type="button" className="travel-inline-btn" onClick={() => setSummaryDraft(trip.summary ?? '')}>
                编辑复盘
              </button>
            </>
          ) : (
            <>
              <p className="travel-empty">
                还没有复盘。旅行结束后，Syzygy 会对照攻略和你的打卡来写（<code>update_trip</code>）；你也可以先写几句。
              </p>
              <button type="button" className="travel-inline-btn" onClick={() => setSummaryDraft('')}>
                自己写
              </button>
            </>
          )}
        </section>
      ) : null}

      <button type="button" className="travel-delete-trip" onClick={() => setPendingDelete({ kind: 'trip' })}>
        删除这次旅行
      </button>

      {sheet ? (
        <div className="travel-sheet-backdrop" role="dialog" aria-modal="true" onClick={() => setSheet(null)}>
          <form className="travel-sheet" onSubmit={(event) => void saveCheckin(event)} onClick={(event) => event.stopPropagation()}>
            <h2>📍 我在这里</h2>
            <p className="travel-sheet__time">{formatCheckinTime(sheet.checkedAt)}</p>
            <div className={`travel-locate travel-locate--${sheet.phase}`}>
              {sheet.phase === 'locating' ? '正在定位…（山里可能要多等几秒）' : null}
              {sheet.phase === 'ready' && sheet.position ? (
                <>
                  已定位{sheet.position.accuracy !== null ? `，精度约 ${formatDistance(sheet.position.accuracy)}` : ''}
                  {(() => {
                    const nearest = nearestStop(sheet.gcj)
                    if (!nearest) return null
                    return nearest.distance <= TRAVEL_MATCH_RADIUS_M
                      ? `。离攻略里的「${nearest.stop.name}」${formatDistance(nearest.distance)}`
                      : `。最近的攻略点「${nearest.stop.name}」还有 ${formatDistance(nearest.distance)}，算新发现`
                  })()}
                </>
              ) : null}
              {sheet.phase === 'failed' ? (
                <>
                  {sheet.locateError}
                  <button type="button" className="travel-inline-btn" onClick={() => void locate()}>
                    再试一次
                  </button>
                </>
              ) : null}
            </div>
            <label className="travel-field">
              <span>这是哪</span>
              <input
                value={sheet.placeName}
                maxLength={120}
                placeholder="地名，可以不填"
                onChange={(event) => setSheet({ ...sheet, placeName: event.target.value, placeTouched: true })}
              />
            </label>
            <label className="travel-field">
              <span>说一句</span>
              <textarea
                value={sheet.note}
                rows={3}
                maxLength={2000}
                placeholder="看到了什么？冷不冷？头疼不疼？"
                onChange={(event) => setSheet({ ...sheet, note: event.target.value })}
              />
            </label>
            <div className="travel-chip-list" aria-label="心情">
              {TRAVEL_MOODS.map((mood) => (
                <button
                  key={mood}
                  type="button"
                  className={sheet.mood === mood ? 'travel-chip travel-chip--mood selected' : 'travel-chip travel-chip--mood'}
                  onClick={() => setSheet({ ...sheet, mood: sheet.mood === mood ? null : mood })}
                >
                  {mood}
                </button>
              ))}
            </div>
            {formError ? <p className="travel-error">{formError}</p> : null}
            <div className="travel-sheet-actions">
              <button type="button" className="ghost" onClick={() => setSheet(null)}>
                取消
              </button>
              <button type="submit" className="travel-primary-btn" disabled={sheet.phase === 'locating'}>
                {sheet.phase === 'locating' ? '定位中…' : sheet.position ? '打卡' : '只记地名'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {stopEditor ? (
        <div className="travel-sheet-backdrop" role="dialog" aria-modal="true" onClick={() => !saving && setStopEditor(null)}>
          <form className="travel-sheet" onSubmit={(event) => void saveStop(event)} onClick={(event) => event.stopPropagation()}>
            <h2>{stopEditor.stopId ? '编辑这一站' : '加一站'}</h2>
            <div className="travel-field-row">
              <label className="travel-field travel-field--narrow">
                <span>第几天</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={stopEditor.dayIndex}
                  onChange={(event) => setStopEditor({ ...stopEditor, dayIndex: event.target.value })}
                />
              </label>
              <label className="travel-field">
                <span>大致时间</span>
                <input
                  value={stopEditor.plannedTime}
                  maxLength={40}
                  placeholder="09:30 / 上午 / 日落前"
                  onChange={(event) => setStopEditor({ ...stopEditor, plannedTime: event.target.value })}
                />
              </label>
            </div>
            <label className="travel-field">
              <span>地点</span>
              <input value={stopEditor.name} maxLength={120} onChange={(event) => setStopEditor({ ...stopEditor, name: event.target.value })} />
            </label>
            <label className="travel-field">
              <span>地址</span>
              <input value={stopEditor.address} maxLength={200} onChange={(event) => setStopEditor({ ...stopEditor, address: event.target.value })} />
            </label>
            <label className="travel-field">
              <span>坐标（高德，经度,纬度）</span>
              <input
                value={stopEditor.coords}
                inputMode="decimal"
                placeholder="101.8466,29.6327"
                onChange={(event) => setStopEditor({ ...stopEditor, coords: event.target.value })}
              />
            </label>
            <label className="travel-field">
              <span>为什么去</span>
              <textarea value={stopEditor.reason} rows={2} onChange={(event) => setStopEditor({ ...stopEditor, reason: event.target.value })} />
            </label>
            <label className="travel-field">
              <span>注意事项</span>
              <textarea value={stopEditor.notes} rows={2} onChange={(event) => setStopEditor({ ...stopEditor, notes: event.target.value })} />
            </label>
            <label className="travel-field">
              <span>怎么走</span>
              <textarea value={stopEditor.navHint} rows={2} onChange={(event) => setStopEditor({ ...stopEditor, navHint: event.target.value })} />
            </label>
            {formError ? <p className="travel-error">{formError}</p> : null}
            <div className="travel-sheet-actions">
              <button type="button" className="ghost" onClick={() => setStopEditor(null)} disabled={saving}>
                取消
              </button>
              <button type="submit" className="travel-primary-btn" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {tripEditor ? (
        <div className="travel-sheet-backdrop" role="dialog" aria-modal="true" onClick={() => !saving && setTripEditor(null)}>
          <form className="travel-sheet" onSubmit={(event) => void saveTrip(event)} onClick={(event) => event.stopPropagation()}>
            <h2>编辑旅行</h2>
            <TravelTripEditorFields editor={tripEditor} onChange={setTripEditor} />
            {formError ? <p className="travel-error">{formError}</p> : null}
            <div className="travel-sheet-actions">
              <button type="button" className="ghost" onClick={() => setTripEditor(null)} disabled={saving}>
                取消
              </button>
              <button type="submit" className="travel-primary-btn" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {checkinEditor ? (
        <div className="travel-sheet-backdrop" role="dialog" aria-modal="true" onClick={() => !saving && setCheckinEditor(null)}>
          <form className="travel-sheet" onSubmit={(event) => void saveCheckinEdit(event)} onClick={(event) => event.stopPropagation()}>
            <h2>改一下这次打卡</h2>
            <p className="travel-sheet__time">{formatCheckinTime(checkinEditor.checkin.checkedAt)}</p>
            <label className="travel-field">
              <span>这是哪</span>
              <input
                value={checkinEditor.placeName}
                maxLength={120}
                onChange={(event) => setCheckinEditor({ ...checkinEditor, placeName: event.target.value })}
              />
            </label>
            <label className="travel-field">
              <span>说一句</span>
              <textarea
                value={checkinEditor.note}
                rows={3}
                maxLength={2000}
                onChange={(event) => setCheckinEditor({ ...checkinEditor, note: event.target.value })}
              />
            </label>
            <div className="travel-chip-list" aria-label="心情">
              {TRAVEL_MOODS.map((mood) => (
                <button
                  key={mood}
                  type="button"
                  className={checkinEditor.mood === mood ? 'travel-chip travel-chip--mood selected' : 'travel-chip travel-chip--mood'}
                  onClick={() => setCheckinEditor({ ...checkinEditor, mood: checkinEditor.mood === mood ? null : mood })}
                >
                  {mood}
                </button>
              ))}
            </div>
            {formError ? <p className="travel-error">{formError}</p> : null}
            <div className="travel-sheet-actions">
              <button type="button" className="ghost" onClick={() => setCheckinEditor(null)} disabled={saving}>
                取消
              </button>
              <button type="submit" className="travel-primary-btn" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'trip'
            ? `删除「${trip.title}」？`
            : pendingDelete?.kind === 'stop'
              ? `删除攻略点「${pendingDelete.stop.name}」？`
              : pendingDelete?.kind === 'checkin'
                ? '删除这次打卡？'
                : '删除这条留言？'
        }
        description={
          pendingDelete?.kind === 'trip'
            ? '攻略、打卡、留言会一起删掉，不能恢复。'
            : pendingDelete?.kind === 'checkin'
              ? '打卡下面的留言也会一起删掉。'
              : undefined
        }
        confirmLabel="删除"
        confirmDisabled={saving}
        cancelDisabled={saving}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

export default TravelTripPage
