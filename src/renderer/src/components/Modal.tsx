import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Undo2, X } from 'lucide-react'

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
  wide = false,
  className = '',
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  wide?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => {
      dialog.close()
      previousFocus?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`workspace-modal ${wide ? 'wide' : ''} ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          const box = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose()
        }
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          disabled={busy}
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  )
}

/**
 * A destructive button that waits before acting. Clicking starts a short
 * countdown with an Undo option; the action only runs if it is not undone.
 * Leaving the view during the countdown cancels it.
 */
export function TimedUndoButton({
  label,
  icon,
  onConfirm,
  seconds = 5,
  pendingLabel = 'Deleting',
  disabled = false,
  className = '',
}: {
  label: string
  icon?: ReactNode
  onConfirm: () => void
  seconds?: number
  pendingLabel?: string
  disabled?: boolean
  className?: string
}) {
  const [left, setLeft] = useState<number | null>(null)
  const confirm = useRef(onConfirm)
  confirm.current = onConfirm
  useEffect(() => {
    if (left === null) return
    if (left <= 0) {
      setLeft(null)
      confirm.current()
      return
    }
    const timer = window.setTimeout(
      () => setLeft((current) => (current === null ? null : current - 1)),
      1000,
    )
    return () => window.clearTimeout(timer)
  }, [left])
  if (left === null)
    return (
      <button
        type="button"
        className={`button timed-undo ${className}`}
        disabled={disabled}
        onClick={() => setLeft(seconds)}
      >
        {icon}
        {label}
      </button>
    )
  return (
    <div
      className={`timed-undo-active ${className}`}
      role="status"
      aria-live="polite"
      style={{ '--undo-duration': `${seconds}s` } as CSSProperties}
    >
      <span className="timed-undo-fill" aria-hidden="true" />
      <span className="timed-undo-ring" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <circle className="timed-undo-progress" cx="12" cy="12" r="9" />
        </svg>
        <b>{left}</b>
      </span>
      <span className="timed-undo-text">{pendingLabel}…</span>
      <button type="button" onClick={() => setLeft(null)} autoFocus>
        <Undo2 size={13} />
        Undo
      </button>
    </div>
  )
}
