import { useEffect, useState } from 'react'
import { Columns2, Terminal } from 'lucide-react'
import type { TerminalSession } from '../../shared/terminal'
import { TerminalPane } from './components/TerminalPane'

export function TerminalsPage() {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await window.constella!.terminal.list()
        if (!alive) return
        if (!result.ok) throw new Error(result.error.message)
        setSessions(result.value)
        setSelected((current) =>
          current.length
            ? current
            : result.value.length
              ? [result.value[0].id]
              : [],
        )
        setError('')
      } catch (error) {
        if (alive) setError(String(error))
      }
      if (alive) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  return (
    <main className="terminals-page">
      <div className="page-heading">
        <div>
          <h1>Terminals</h1>
          <p>Switch between your agents, or keep two sessions side by side.</p>
        </div>
        <span className="small-muted">
          {sessions.filter((s) => s.state !== 'exited').length} open sessions
        </span>
      </div>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      {!sessions.length ? (
        <div className="terminal-empty">
          <Terminal size={28} />
          <h2>No terminal sessions yet</h2>
          <p>
            Run an agent node or open a project manager to start your installed
            CLI.
          </p>
        </div>
      ) : (
        <div className="terminal-multiplexer">
          <nav className="terminal-session-list" aria-label="Terminal sessions">
            {sessions.map((session) => (
              <div
                className={
                  selected.includes(session.id)
                    ? 'terminal-session selected'
                    : 'terminal-session'
                }
                key={session.id}
              >
                <button
                  type="button"
                  className="terminal-session-select"
                  onClick={() => setSelected([session.id])}
                >
                  <Terminal size={14} />
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {session.provider === 'claude'
                        ? 'Claude Code'
                        : 'Codex CLI'}{' '}
                      · {session.state}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Open beside current terminal"
                  aria-label={`Open ${session.title} beside current terminal`}
                  disabled={selected[0] === session.id}
                  onClick={() =>
                    setSelected([selected[0], session.id].filter(Boolean))
                  }
                >
                  <Columns2 size={14} />
                </button>
              </div>
            ))}
          </nav>
          <div
            className={`terminal-panes ${selected.length > 1 ? 'split' : ''}`}
          >
            {selected.map((id) => (
              <TerminalPane key={id} sessionId={id} />
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
