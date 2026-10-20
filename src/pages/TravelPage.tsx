import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TravelTrip } from '../types'
import { createTravelTrip, listTravelTrips } from '../storage/supabaseSync'
import TravelTripEditorFields from '../components/TravelTripEditorFields'
import {
  TRAVEL_STATUS_LABELS,
  emptyTripEditor,
  flushPendingCheckins,
  formatTravelDateRange,
  readCachedTrips,
  readPendingCheckins,
  tripEditorToPatch,
  writeCachedTrips,
  type TripEditorState,
} from './travelShared'
import './TravelPage.css'

// 游记：Syzygy 写的攻略 × 串串的打卡路线。这一页是旅行列表；进到某次旅行再看攻略 / 路线 / 地图 / 复盘。
// 平时不追踪位置，只在串串按下打卡时记一次。

const TravelPage = () => {
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TravelTrip[]>(() => readCachedTrips() ?? [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(() => readPendingCheckins().length)
  const [editor, setEditor] = useState<TripEditorState | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const syncPending = useCallback(async () => {
    try {
      const sent = await flushPendingCheckins()
      if (sent > 0) setNotice(`补传了 ${sent} 个离线打卡`)
    } catch (syncError) {
      console.warn('补传离线打卡失败', syncError)
    } finally {
      setPendingCount(readPendingCheckins().length)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await listTravelTrips()
      setTrips(next)
      writeCachedTrips(next)
      setError(null)
    } catch (loadError) {
      console.warn('加载游记失败', loadError)
      setError(readCachedTrips() ? '现在连不上，先给你看上次存下的' : '加载游记失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void syncPending()
    void refresh()
    const handleOnline = () => {
      void syncPending()
      void refresh()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [refresh, syncPending])

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (!editor) return
    const patch = tripEditorToPatch(editor)
    if (!patch.ok) {
      setEditorError(patch.error)
      return
    }
    setSaving(true)
    try {
      const trip = await createTravelTrip(patch.value)
      setEditor(null)
      navigate(`/travel/${trip.id}`)
    } catch (createError) {
      console.warn('新建旅行失败', createError)
      setEditorError('新建失败，检查一下网络再试')
    } finally {
      setSaving(false)
    }
  }

  const activeTrips = trips.filter((trip) => trip.status !== 'done')
  const doneTrips = trips.filter((trip) => trip.status === 'done')

  const renderTrip = (trip: TravelTrip) => (
    <article
      key={trip.id}
      className={`travel-trip-card travel-trip-card--${trip.status}`}
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/travel/${trip.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          navigate(`/travel/${trip.id}`)
        }
      }}
    >
      <div className="travel-trip-card__top">
        <h3>{trip.title}</h3>
        <span className={`travel-status travel-status--${trip.status}`}>{TRAVEL_STATUS_LABELS[trip.status]}</span>
      </div>
      {trip.destination ? <p className="travel-trip-card__dest">📍 {trip.destination}</p> : null}
      <p className="travel-trip-card__meta">{formatTravelDateRange(trip)}</p>
    </article>
  )

  return (
    <div className="travel-page">
      <header className="travel-header">
        <button type="button" className="ghost travel-header-btn travel-header-btn--left" onClick={() => navigate('/')}>
          ← 返回
        </button>
        <div className="travel-title-wrap">
          <p className="travel-kicker">Travel Journal</p>
          <h1 className="ui-title">游记</h1>
        </div>
        <button
          type="button"
          className="travel-header-btn travel-header-btn--right"
          onClick={() => {
            setEditorError(null)
            setEditor(emptyTripEditor())
          }}
        >
          + 新旅行
        </button>
      </header>

      <section className="travel-intro-card">
        <strong>攻略是 Syzygy 写的，路线是你一步一步打卡打出来的</strong>
        <p>平时不追踪位置，只在你按下「我在这里」时记一次；没信号也能打卡，先存在手机里，有信号自动补传。偏离攻略不扣分，新发现是惊喜。</p>
      </section>

      {pendingCount > 0 ? (
        <button type="button" className="travel-pending-banner" onClick={() => void syncPending()}>
          📮 还有 {pendingCount} 个打卡在手机里排队，点一下试着补传
        </button>
      ) : null}
      {notice ? <p className="travel-notice">{notice}</p> : null}
      {error ? <p className="travel-error">{error}</p> : null}

      {loading && trips.length === 0 ? <p className="travel-empty">加载中…</p> : null}
      {!loading && trips.length === 0 && !error ? (
        <p className="travel-empty">还没有旅行。点右上角「+ 新旅行」开一个，再让 Syzygy 帮你写攻略。</p>
      ) : null}

      {activeTrips.length > 0 ? (
        <section className="travel-section">
          <h2 className="travel-section-title">在路上 / 要出发</h2>
          <div className="travel-trip-list">{activeTrips.map(renderTrip)}</div>
        </section>
      ) : null}
      {doneTrips.length > 0 ? (
        <section className="travel-section">
          <h2 className="travel-section-title">走过的路</h2>
          <div className="travel-trip-list">{doneTrips.map(renderTrip)}</div>
        </section>
      ) : null}

      {editor ? (
        <div className="travel-sheet-backdrop" role="dialog" aria-modal="true" onClick={() => !saving && setEditor(null)}>
          <form className="travel-sheet" onSubmit={(event) => void handleCreate(event)} onClick={(event) => event.stopPropagation()}>
            <h2>新旅行</h2>
            <TravelTripEditorFields editor={editor} onChange={setEditor} />
            {editorError ? <p className="travel-error">{editorError}</p> : null}
            <div className="travel-sheet-actions">
              <button type="button" className="ghost" onClick={() => setEditor(null)} disabled={saving}>
                取消
              </button>
              <button type="submit" className="travel-primary-btn" disabled={saving}>
                {saving ? '保存中…' : '建好了'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

export default TravelPage
