/** 提供统一的对话框语义、键盘焦点管理和遮罩关闭行为。 */
import { useLayoutEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

/** 复用结构化弹层，保持焦点和遮罩点击行为一致。 */
export function Modal({ title, subtitle, children, onClose, wide = false }: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const closeRef = useRef(onClose)
  const titleId = useId()
  const subtitleId = useId()
  closeRef.current = onClose

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    /** 只返回弹窗内可见且可接收焦点的控件。 */
    const getFocusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')

    const focusable = getFocusableElements()
    // React 的 autoFocus 不保留 DOM 属性；显式标记让弹窗管理器稳定识别首个焦点。
    const initialFocus = focusable.find((element) => element.hasAttribute('data-modal-initial-focus'))
    ;(initialFocus ?? focusable[0] ?? dialog).focus()

    // 在文档级处理按键，避免焦点意外移出弹窗后 Tab 键无法收回。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements()
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (openerRef.current?.isConnected) openerRef.current.focus()
    }
  }, [])

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className={`modal-card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} tabIndex={-1}>
      <header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={18} /></button></header>
      <div className="modal-content">{children}</div>
    </section>
  </div>
}
