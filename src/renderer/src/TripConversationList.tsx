/** 呈现当前旅行的独立话题列表，并保留键盘可识别的当前选择状态。 */
import { MessageCircle, Plus, Trash2 } from 'lucide-react'
import type { ChatMessage, TripConversation } from '@shared/types'

interface Props {
  conversations: TripConversation[]
  messages: ChatMessage[]
  activeConversationId: string
  runningConversationId: string | null
  onSelect: (conversationId: string) => void
  onDelete: (conversationId: string) => void
  onCreate: () => void
}

/** 侧栏话题列表只显示会话元数据，不把旅行级资料误画成会话内容。 */
export function TripConversationList({ conversations, messages, activeConversationId, runningConversationId, onSelect, onDelete, onCreate }: Props) {
  const messageCounts = new Map<string, number>()
  for (const message of messages) {
    messageCounts.set(message.conversationId, (messageCounts.get(message.conversationId) ?? 0) + 1)
  }

  return <section className="conversation-section" aria-label="当前旅行话题">
    <div className="conversation-section-heading">
      <span>话题</span>
      <button className="icon-button" aria-label="新建话题" title="新建话题" onClick={onCreate}>
        <Plus size={15} />
      </button>
    </div>
    <div className="conversation-list">
      {conversations.map((conversation) => {
        const active = activeConversationId === conversation.id
        const messageCount = messageCounts.get(conversation.id) ?? 0
        const running = runningConversationId === conversation.id
        return <div key={conversation.id} className={`conversation-row${active ? ' active' : ''}`}>
          <button
            type="button"
            className="conversation-select"
            aria-current={active ? 'page' : undefined}
            title={conversation.title}
            onClick={() => onSelect(conversation.id)}
          >
            <MessageCircle size={14} aria-hidden="true" />
            <span>{conversation.title}</span>
            {messageCount > 0 && <small>{messageCount}</small>}
          </button>
          <button
            type="button"
            className="conversation-delete icon-button"
            aria-label={`删除话题：${conversation.title}`}
            title={running ? '该话题回复结束后即可删除' : `删除话题：${conversation.title}`}
            disabled={running}
            onClick={() => onDelete(conversation.id)}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      })}
    </div>
  </section>
}
