import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Check, LoaderCircle, Terminal as TerminalIcon } from 'lucide-react'
import {
  isTerminalWheelInput,
  terminalReadOnlyMessage,
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
  const [readError, setReadError] = useState('')
  const [scrollNotice, setScrollNotice] = useState('')
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
    let supportsReadOnlyWheel = false
    let wheelRemainder = 0
    setError('')
    setReadError('')
    setScrollNotice('')
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Geist Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: '#101216',
        foreground: '#e4e6eb',
        cursor: '#c6f35b',
        cursorAccent: '#101216',
        selectionBackground: '#c6f35b33',
      },
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element.current)
    // Scrolling the DOM renderer rebuilds every visible row. Prefer GPU
    // rendering, retaining xterm's DOM fallback if unavailable or lost.
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl?.dispose())
      term.loadAddon(webgl)
    } catch {
      webgl?.dispose()
    }
    const showScrollNotice = () => {
      if (alive)
        setScrollNotice(
          'This older fullscreen session cannot scroll after handoff. New terminals use normal scrollback.',
        )
    }
    term.attachCustomWheelEventHandler((event) => {
      const readOnly = state !== 'running' || disabledRef.current
      if (
        term.buffer.active.type === 'normal' &&
        term.modes.mouseTrackingMode !== 'none' &&
        (readOnly || term.buffer.active.baseY > 0)
      ) {
        // A CLI can request mouse reports in inline mode too. Keep normal
        // scrollback local, including when its keyboard input is disabled.
        const screenHeight =
          element.current?.querySelector('.xterm-screen')?.clientHeight ?? 0
        const lineHeight = screenHeight > 0 ? screenHeight / term.rows : 15
        const delta =
          event.deltaMode === 1
            ? event.deltaY
            : event.deltaMode === 2
              ? event.deltaY * term.rows
              : event.deltaY / lineHeight
        wheelRemainder += delta * (term.options.scrollSensitivity ?? 1)
        const lines = Math.trunc(wheelRemainder)
        wheelRemainder -= lines
        if (lines) term.scrollLines(lines)
        event.preventDefault()
        return false
      }
      if (
        readOnly &&
        term.buffer.active.type === 'alternate' &&
        !supportsReadOnlyWheel
      ) {
        showScrollNotice()
        event.preventDefault()
        return false
      }
      return true
    })
    const sendInput = (
      data: string,
      encoding: TerminalInput['encoding'] = 'utf8',
    ) => {
      if (
        (state !== 'running' || disabledRef.current) &&
        !(
          state !== 'exited' &&
          supportsReadOnlyWheel &&
          term.buffer.active.type === 'alternate' &&
          isTerminalWheelInput({ data, encoding })
        )
      )
        return
      void api
        .input({ sessionId, data, encoding })
        .then((result) => {
          if (!alive) return
          if (!result.ok) {
            if (
              isTerminalWheelInput({ data, encoding }) &&
              result.error.message === terminalReadOnlyMessage
            ) {
              // An older daemon can hand off between our last read and input.
              state = 'ready'
              supportsReadOnlyWheel = false
              showScrollNotice()
            } else setError(result.error.message)
          } else setError('')
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
          setReadError(`${result.error.message} ${result.error.hint}`)
          return
        }
        const value = result.value
        state = value.session.state
        supportsReadOnlyWheel = value.supportsReadOnlyWheel === true
        if (value.reset) term.reset()
        // Avoid idle parser/render work and let a large replay drain before
        // fetching more output, rather than growing xterm's write queue.
        if (value.data)
          await new Promise<void>((resolve) => term.write(value.data, resolve))
        if (!alive) return
        cursor = value.cursor
        setSession((previous) =>
          JSON.stringify(previous) === JSON.stringify(value.session)
            ? previous
            : value.session,
        )
        setReadError('')
        if (
          term.buffer.active.type === 'normal' ||
          supportsReadOnlyWheel ||
          (state === 'running' && !disabledRef.current)
        )
          setScrollNotice('')
        if (state !== 'running')
          setError((previous) =>
            previous === terminalReadOnlyMessage ? '' : previous,
          )
      } catch (error) {
        if (alive) setReadError(String(error))
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
      {(readError || error) && (
        <p className="terminal-error" role="alert">
          {readError || error}
        </p>
      )}
      <div className="terminal-screen" ref={element} />
      {scrollNotice && (
        <p className="terminal-caption" role="status">
          {scrollNotice}
        </p>
      )}
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
