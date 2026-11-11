/** 展示真实运行状态、工具返回和等待时间，不推断模型内部阶段。 */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, CircleAlert, ListChecks, LoaderCircle } from 'lucide-react'
import type { ToolFeedback } from '../../shared/types'

export interface AgentProgressActivity {
  id: string
  toolCallId?: string
  label: string
  detail?: string
  feedback?: ToolFeedback[]
  state: 'running' | 'completed' | 'partial' | 'failed'
}

export type AgentProgressOutcome = 'running' | 'completed' | 'failed'

/** 把运行时间缩成稳定的分秒显示，长任务自动增加小时位。 */
export function formatAgentElapsedTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3_600)
  const minutes = Math.floor((safeSeconds % 3_600) / 60)
  const remainder = safeSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/** 每秒只更新局部计时器，避免根工作区跟着长任务频繁重渲染。 */
export function AgentProgress({ status, startedAt, activities = [], outcome = 'running', finishedAt }: {
  status: string
  startedAt: number
  activities?: AgentProgressActivity[]
  outcome?: AgentProgressOutcome
  finishedAt?: number
}) {
  const isRunning = outcome === 'running'
  const [now, setNow] = useState(() => finishedAt ?? Date.now())
  const elapsedSeconds = Math.floor((Math.max(startedAt, finishedAt ?? now) - startedAt) / 1_000)
  const currentActivityLabel = status.replace(/^正在/u, '')
  // 进行中的工具动作占主状态位，避免和已完成工具历史重复展示。
  const runningActivity = activities.slice().reverse().find((activity) => activity.state === 'running')
  const visibleStatus = outcome === 'completed' ? '本轮已完成'
    : outcome === 'failed' ? '本轮未完成'
      : runningActivity?.label.replace(/^正在/u, '') ?? status
  const seenActivityLabels = new Set<string>()
  const recentActivities = activities.slice().reverse().flatMap((activity) => {
    const label = activity.label.replace(/^正在/u, '')
    if (activity.state === 'running' || label === currentActivityLabel || seenActivityLabels.has(label)) return []
    seenActivityLabels.add(label)
    return [activity]
  }).slice(0, 4).reverse()

  useEffect(() => {
    if (!isRunning) return
    const updateElapsed = (): void => setNow(Date.now())
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt, isRunning])

  return <section className={`agent-progress agent-progress-${outcome}`} role={isRunning ? 'status' : undefined} aria-live={isRunning ? 'polite' : undefined} aria-label={outcome === 'completed' ? '本轮工具步骤已完成' : outcome === 'failed' ? '本轮工具步骤未完成' : '本轮规划进度'}>
    <span className="agent-progress-icon" aria-hidden="true">{outcome === 'completed' ? <Check size={15} />
      : outcome === 'failed' ? <CircleAlert size={15} /> : <LoaderCircle size={15} />}</span>
    <div className="agent-progress-copy">
      <div className="agent-progress-heading">
        <span>{visibleStatus}</span>
        <small aria-hidden="true">已用 {formatAgentElapsedTime(elapsedSeconds)}</small>
      </div>
      {recentActivities.length > 0 && <ol className="agent-activity-list" aria-label="最近完成的工具">
        {recentActivities.map((activity) => <li className={`agent-activity activity-${activity.state}`} key={activity.id}>
          <span className="agent-activity-icon" aria-hidden="true">{activity.state === 'running'
            ? <LoaderCircle size={12} />
            : activity.state === 'completed' ? <Check size={12} /> : <CircleAlert size={12} />}</span>
          <span className="agent-activity-label">{activity.label.replace(/^正在/u, '')}</span>
          {activity.detail && <small>{activity.detail}</small>}
          {activity.feedback?.map((item, index) => <small className={`agent-feedback feedback-${item.severity}`} key={`${item.code}-${index}`}><b>{feedbackLabel(item.severity)}</b> {item.message}</small>)}
        </li>)}
      </ol>}
      {activities.length > recentActivities.length && <details className="agent-activity-history">
        <summary><ListChecks size={13} aria-hidden="true" /><span>全部步骤</span><small>{activities.length}</small><ChevronDown size={13} aria-hidden="true" /></summary>
        <ol aria-label="本轮工具步骤">
          {activities.map((activity, index) => <li className={`agent-activity activity-${activity.state}`} key={`${activity.id}-${index}`}>
            <span className="agent-activity-icon" aria-hidden="true">{activity.state === 'running'
              ? <LoaderCircle size={12} />
              : activity.state === 'completed' ? <Check size={12} /> : <CircleAlert size={12} />}</span>
            <span className="agent-activity-label">{activity.label.replace(/^正在/u, '')}</span>
            {activity.detail && <small>{activity.detail}</small>}
            {activity.feedback?.map((item, feedbackIndex) => <small className={`agent-feedback feedback-${item.severity}`} key={`${item.code}-${feedbackIndex}`}><b>{feedbackLabel(item.severity)}</b> {item.message}</small>)}
          </li>)}
        </ol>
      </details>}
    </div>
  </section>
}

/** 让工具反馈等级能快速扫描，同时保留简短说明。 */
function feedbackLabel(severity: 'error' | 'warning' | 'info'): string {
  return severity === 'warning' ? 'WARN' : severity.toUpperCase()
}
