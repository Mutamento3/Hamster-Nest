import type { TripEditorState } from '../pages/travelShared'
import { TRAVEL_STATUS_LABELS, TRAVEL_STATUS_OPTIONS } from '../pages/travelShared'

// 新建 / 编辑旅行共用的表单字段（样式在 TravelPage.css）。
const TravelTripEditorFields = ({
  editor,
  onChange,
}: {
  editor: TripEditorState
  onChange: (next: TripEditorState) => void
}) => (
  <>
    <label className="travel-field">
      <span>标题</span>
      <input
        value={editor.title}
        maxLength={80}
        placeholder="比如：贡嘎自驾"
        onChange={(event) => onChange({ ...editor, title: event.target.value })}
        autoFocus
      />
    </label>
    <label className="travel-field">
      <span>目的地</span>
      <input
        value={editor.destination}
        maxLength={120}
        placeholder="比如：康定 · 新都桥 · 子梅垭口"
        onChange={(event) => onChange({ ...editor, destination: event.target.value })}
      />
    </label>
    <div className="travel-field-row">
      <label className="travel-field">
        <span>出发</span>
        <input type="date" value={editor.startDate} onChange={(event) => onChange({ ...editor, startDate: event.target.value })} />
      </label>
      <label className="travel-field">
        <span>回来</span>
        <input type="date" value={editor.endDate} onChange={(event) => onChange({ ...editor, endDate: event.target.value })} />
      </label>
    </div>
    <div className="travel-chip-list" role="radiogroup" aria-label="状态">
      {TRAVEL_STATUS_OPTIONS.map((status) => (
        <button
          key={status}
          type="button"
          role="radio"
          aria-checked={editor.status === status}
          className={editor.status === status ? 'travel-chip selected' : 'travel-chip'}
          onClick={() => onChange({ ...editor, status })}
        >
          {TRAVEL_STATUS_LABELS[status]}
        </button>
      ))}
    </div>
  </>
)

export default TravelTripEditorFields
