/** 旅行创建、编辑和删除对话框，隔离表单状态与主工作区编排。 */
import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Trip, TripBrief, TripBriefField, TripConversation } from '@shared/types'
import { TRIP_BRIEF_FIELDS, TRIP_BRIEF_FIELD_LABELS } from '@shared/trip-brief'
import { Modal } from './components/Modal'

/** 新建旅行时只收集可选锚点，其余条件可在对话中补充。 */
export function CreateTripModal({ busy, onClose, onCreate }: {
  busy: boolean
  onClose: () => void
  onCreate: (input: { departureCity: string; destination: string; startDate: string; endDate: string }) => Promise<void>
}) {
  const [departureCity, setDepartureCity] = useState('')
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  return <Modal title="新建旅行" onClose={onClose}>
    <form className="create-trip-form" onSubmit={(event) => {
      event.preventDefault()
      void onCreate({ departureCity, destination, startDate, endDate })
    }}>
      <label className="form-label">目的地<input data-modal-initial-focus value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="例如：北京" /></label>
      <label className="form-label">从哪里出发<input value={departureCity} onChange={(event) => setDepartureCity(event.target.value)} placeholder="例如：广州" /></label>
      <div className="date-field-row"><label className="form-label">出发日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="form-label">返程日期<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
      <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy} type="submit"><Plus size={15} /> 创建旅行</button></div>
    </form>
  </Modal>
}

/** 允许用户随时修订关键条件，避免偏好只埋在聊天记录里。 */
export function TripBriefModal({ trip, onClose, onSave }: {
  trip: Trip
  onClose: () => void
  onSave: (brief: TripBrief, unknownFields: TripBriefField[]) => Promise<void>
}) {
  const [brief, setBrief] = useState<TripBrief>({ ...trip.brief })
  const [unknownFields, setUnknownFields] = useState<TripBriefField[]>([...trip.briefUnknownFields])
  const [busy, setBusy] = useState(false)
  /** 更新一项旅行条件，保留表单里的其他字段。 */
  const setField = <Key extends keyof TripBrief>(key: Key, value: TripBrief[Key]): void => {
    setBrief((current) => ({ ...current, [key]: value }))
    if (typeof value === 'string' && value.trim()) setUnknownFields((current) => current.filter((field) => field !== key))
  }
  /** 明确未知时清掉旧值，避免模型继续把过期内容当作约束。 */
  const toggleUnknownField = (field: TripBriefField, checked: boolean): void => {
    setUnknownFields((current) => checked ? [...current, field] : current.filter((item) => item !== field))
    if (checked) setBrief((current) => ({ ...current, [field]: '' }))
  }
  /** 保存期间禁用重复提交，并在成功或失败后恢复按钮状态。 */
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      await onSave(brief, unknownFields)
    } finally {
      setBusy(false)
    }
  }
  return <Modal wide title="旅行信息" subtitle="修改信息不会自动更新已保存的行程。" onClose={onClose}>
    <form className="brief-form" onSubmit={(event) => void save(event)}>
      <div className="brief-section-title">行程信息</div>
      <div className="brief-grid">
        <label className="form-label">目的地<input value={brief.destination} onChange={(event) => setField('destination', event.target.value)} /></label>
        <label className="form-label">出发地<input value={brief.departureCity} onChange={(event) => setField('departureCity', event.target.value)} /></label>
        <label className="form-label">出发日期<input type="date" value={brief.startDate} onChange={(event) => setField('startDate', event.target.value)} /></label>
        <label className="form-label">返程日期<input type="date" min={brief.startDate || undefined} value={brief.endDate} onChange={(event) => setField('endDate', event.target.value)} /></label>
        <label className="form-label">抵达航班或车次<input value={brief.arrivalFlight} onChange={(event) => setField('arrivalFlight', event.target.value)} placeholder="如：CA1234 或 G123" /></label>
        <label className="form-label">抵达时间<input type="time" value={brief.arrivalTime} onChange={(event) => setField('arrivalTime', event.target.value)} /></label>
        <label className="form-label">离开时间<input type="time" value={brief.leaveTime} onChange={(event) => setField('leaveTime', event.target.value)} /></label>
        <label className="form-label">同行人<input value={brief.travelers} onChange={(event) => setField('travelers', event.target.value)} placeholder="如：1 位成人，带老人" /></label>
      </div>
      <div className="brief-section-title">偏好与限制</div>
      <div className="brief-grid">
        <label className="form-label">预算<input value={brief.budget} onChange={(event) => setField('budget', event.target.value)} placeholder="如：中等；全程预算上限 5000 元" /></label>
        <label className="form-label">行程强度<input value={brief.pace} onChange={(event) => setField('pace', event.target.value)} placeholder="轻松 / 适中 / 紧凑" /></label>
        <label className="form-label">具体住宿地点<input value={brief.lodgingLocation} onChange={(event) => setField('lodgingLocation', event.target.value)} placeholder="酒店名称或完整地址；不确定时留空" /></label>
        <label className="form-label">住宿区域与偏好<input value={brief.lodging} onChange={(event) => setField('lodging', event.target.value)} placeholder="如王府井附近、含早、双床房" /></label>
        <label className="form-label">出发时间偏好<input value={brief.earlyStart} onChange={(event) => setField('earlyStart', event.target.value)} placeholder="如：希望 9 点后出门" /></label>
        <label className="form-label">兴趣点<input value={brief.interests} onChange={(event) => setField('interests', event.target.value)} placeholder="人文、自然、美食、拍照…" /></label>
        <label className="form-label">交通偏好<input value={brief.transport} onChange={(event) => setField('transport', event.target.value)} placeholder="地铁、公交、打车、步行…" /></label>
        <label className="form-label">忌口与饮食<input value={brief.dietary} onChange={(event) => setField('dietary', event.target.value)} placeholder="忌口、过敏或口味" /></label>
        <label className="form-label">行李限制<input value={brief.luggage} onChange={(event) => setField('luggage', event.target.value)} placeholder="航司额度、随身设备" /></label>
      </div>
      <label className="form-label">穿搭需求与已有衣物<textarea value={brief.clothing} onChange={(event) => setField('clothing', event.target.value)} rows={2} placeholder="如：带短袖和冲锋衣，希望轻装出行" /></label>
      <label className="form-label">其他约束<textarea value={brief.constraints} onChange={(event) => setField('constraints', event.target.value)} rows={2} placeholder="不能错过的活动、无障碍需求、避坑要求等" /></label>
      <details className="brief-unknown-disclosure">
        <summary>标记不确定的信息 <span>{unknownFields.length ? `${unknownFields.length} 项` : '可选'}</span></summary>
        <p>勾选后清空该项，之后不再追问；填入内容会自动取消标记。</p>
        <div className="brief-unknown-grid" role="group" aria-label="暂时无法确定的旅行信息">
          {TRIP_BRIEF_FIELDS.map((field) => <label key={field} className="brief-unknown-option">
            <input type="checkbox" checked={unknownFields.includes(field)} onChange={(event) => toggleUnknownField(field, event.target.checked)} />
            <span>{TRIP_BRIEF_FIELD_LABELS[field]}</span>
          </label>)}
        </div>
      </details>
      <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy} type="submit">{busy ? '保存中…' : '保存旅行信息'}</button></div>
    </form>
  </Modal>
}

/** 在不可逆删除前列出本机将清除的资料，并说明外部副本不受影响。 */
export function DeleteTripModal({ trip, busy, hasActivity, onClose, onConfirm }: {
  trip: Trip
  busy: boolean
  hasActivity: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return <Modal title={`删除“${trip.title}”`} subtitle="此操作无法撤销。" onClose={onClose}>
    <div className="delete-trip-content">
      <p className="delete-trip-intro">以下内容会从此设备移除：</p>
      <ul className="delete-trip-scope">
        <li>旅行信息与条件</li>
        <li>对话记录（{trip.messages.length} 条）</li>
        <li>已保存来源与导入资料（{trip.sources.length} 条）</li>
        <li>出行准备事项（{trip.preparationItems.length} 条）</li>
        <li>行程版本（{trip.revisions.length} 个）</li>
      </ul>
      <p className="delete-trip-boundary">其他旅行、设置和服务密钥会保留。发给模型或外部服务的数据不会随旅行删除。</p>
      {hasActivity && <p className="delete-trip-busy" role="status">这趟旅行仍在规划或查询。请先停止操作，或等它完成后再删除。</p>}
      <div className="modal-footer delete-trip-footer">
        <button type="button" className="secondary-button" disabled={busy} data-modal-initial-focus onClick={onClose}>取消</button>
        <button type="button" className="danger-button" disabled={busy || hasActivity} onClick={onConfirm}><Trash2 size={14} />{busy ? '正在删除…' : '删除旅行资料'}</button>
      </div>
    </div>
  </Modal>
}

/** 删除单个话题前说明消息范围，保留旅行级资料和已保存方案。 */
export function DeleteConversationModal({ conversation, messageCount, lastConversation, busy, hasActivity, onClose, onConfirm }: {
  conversation: TripConversation
  messageCount: number
  lastConversation: boolean
  busy: boolean
  hasActivity: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return <Modal title={`删除“${conversation.title}”`} subtitle="此操作无法撤销。" onClose={onClose}>
    <div className="delete-trip-content">
      <p className="delete-trip-intro">将从此设备删除这个话题和其中的 {messageCount} 条消息。</p>
      <p className="delete-trip-boundary">旅行信息、来源、已保存行程和出行准备清单会保留。{lastConversation ? '删除后会新建一个空白“总体规划”话题。' : ''}</p>
      {hasActivity && <p className="delete-trip-busy" role="status">这个话题仍在回复。请等回复结束后再删除。</p>}
      <div className="modal-footer delete-trip-footer">
        <button type="button" className="secondary-button" disabled={busy} data-modal-initial-focus onClick={onClose}>取消</button>
        <button type="button" className="danger-button" disabled={busy || hasActivity} onClick={onConfirm}><Trash2 size={14} />{busy ? '正在删除…' : '删除话题'}</button>
      </div>
    </div>
  </Modal>
}
