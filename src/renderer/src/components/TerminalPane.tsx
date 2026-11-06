import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Check, LoaderCircle, Terminal as TerminalIcon } from 'lucide-react'
import {
  isTerminalWheelInput,
  type TerminalInput,
  type TerminalSession,
} from '../../../shared/terminal'
import '@xterm/xterm/css/xterm.css'
import '../terminal.css'

export function TerminalPane({
  sessionId,
  disabled = false,
  finishLabel,
  toolbarActions,
  statusLabel,
  showCaption = true,
  showCloseControl = true,
}: {
  sessionId: string
  disabled?: boolean
  finishLabel?: string
  toolbarActions?: ReactNode
  statusLabel?: string
  showCaption?: boolean
  showCloseControl?: boolean
}) {
  const element = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState<TerminalSession>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  useEffect(() => {
    const api = window.constella?.terminal
    if (!api || !element.current) {
      setError('Terminal support is unavailable. Restart the desktop app.')
      return
    }
    let alive = true,
      timer: ReturnType<typeof setTimeout>,
      cursor = 0
    let state: TerminalSession['state'] = 'ready'
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      scrollback: 5000,
      theme: {
        background: '#172131',
        foreground: '#f1f5fc',
        cursor: '#f1f5fc',
        selectionBackground: '#43536a',
      },
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element.current)
    const sendInput = (
      data: string,
      encoding: TerminalInput['encoding'] = 'utf8',
    ) => {
      if (
        (state !== 'running' || disabledRef.current) &&
        !(
          state !== 'exited' &&
          term.buffer.active.type === 'alternate' &&
          isTerminalWheelInput({ data, encoding })
        )
      )
        return
      void api
        .input({ sessionId, data, encoding })
        .then((result) => {
          if (!result.ok && alive) setError(result.error.message)
        })
        .catch((error) => {
          if (alive) setError(String(error))
        })
    }
    const input = term.onData((data) => sendInput(data))
    const binaryInput = term.onBinary((data) => sendInput(data, 'binary'))
    const resize = () => {
      if (
        !alive ||
        !element.current?.clientWidth ||
        !element.current.clientHeight
      )
        return
      fit.fit()
      void api
        .resize({ sessionId, cols: term.cols, rows: term.rows })
        .then((result) => {
          if (!result.ok && alive) setError(result.error.message)
        })
        .catch(() => {})
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element.current)
    async function poll() {
      try {
        const result = await api!.read({ sessionId, after: cursor })
        if (!alive) return
        if (!result.ok) {
          setError(`${result.error.message} ${result.error.hint}`)
          return
        }
        const value = result.value
        if (value.reset) term.reset()
        term.write(value.data)
        cursor = value.cursor
        state = value.session.state
        setSession((previous) =>
          JSON.stringify(previous) === JSON.stringify(value.session)
            ? previous
            : value.session,
        )
        setError('')
      } catch (error) {
        if (alive) setError(String(error))
      }
      if (alive) timer = setTimeout(() => void poll(), 150)
    }
    resize()
    void poll()
    term.focus()
    return () => {
      alive = false
      clearTimeout(timer)
      observer.disconnect()
      input.dispose()
      binaryInput.dispose()
      term.dispose()
    }
  }, [sessionId])
  async function finish() {
    setPending(true)
    try {
      const result = await window.constella!.terminal.finish({ sessionId })
      if (!result.ok) throw new Error(result.error.message)
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <section
      className="native-terminal"
      aria-label="Native coding agent terminal"
    >
      <div className="terminal-toolbar">
        <span>
          <TerminalIcon size={14} />
          <strong>
            {session?.provider === 'claude' ? 'Claude Code' : 'Codex CLI'}
          </strong>
          <small>
            {statusLabel ??
              (session?.state === 'running'
                ? 'Interactive terminal'
                : session?.state === 'ready'
                  ? 'Result handed back'
                  : session?.state === 'exited'
                    ? `Exited (${session.exitCode ?? 'unknown'})`
                    : 'Connecting…')}
          </small>
        </span>
        <div className="terminal-toolbar-actions">
          {toolbarActions}
          {showCloseControl && session?.state === 'ready' && (
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() => {
                setPending(true)
                void window
                  .constella!.terminal.close({ sessionId })
                  .then((result) => {
                    if (!result.ok) setError(result.error.message)
                  })
                  .finally(() => setPending(false))
              }}
            >
              Close terminal
            </button>
          )}
          {session?.state === 'running' && !disabled && (
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() => void finish()}
            >
              {pending ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Check size={13} />
              )}
              {finishLabel ??
                (session.role === 'manager'
                  ? 'Finish manager assignment'
                  : session.role === 'lab'
                    ? 'Finish lab assignment'
                    : 'Finish step & run checks')}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      <div className="terminal-screen" ref={element} />
      {showCaption && (
        <p className="terminal-caption">
          {session?.state === 'running'
            ? 'Use the CLI directly. Its permission prompts and commands stay in this terminal.'
            : 'Continue from the workflow controls to start another assignment. Closing this pane keeps the session.'}
        </p>
      )}
    </section>
  )
}
