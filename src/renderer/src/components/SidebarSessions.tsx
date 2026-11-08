import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Check, TriangleAlert } from 'lucide-react'
import type { NodeSession } from '../../../shared/execution'
import './sidebar-sessions.css'

const labels = { running: 'Running', attention: 'Attention required', done: 'Done' }

export function SidebarSessions() {
  const [sessions, setSessions] = useState<NodeSession[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const location = useLocation()
  useEffect(() => {
    const bridge = window.constella
    if (!bridge?.execution?.listSessions) {
      setLoading(false)
      setFailed(true)
      return
    }
    let alive = true,
      pending = false,
      again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      if (pending) {
        again = true
        return
      }
      pending = true
      try {
        const result = await bridge!.execution.listSessions()
        if (!result.ok) throw new Error(result.error.message)
        if (alive) {
          setSessions(result.value)
          setFailed(false)
        }
      } catch {
        if (alive) setFailed(true)
      } finally {
        pending = false
        if (alive) {
          setLoading(false)
          if (again) {
            again = false
            changed()
          }
        }
      }
    }
    function changed() {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void refresh()
        }, 200)
    }
    const unsubscribers = [
      bridge.execution.onChange(changed),
      bridge.workflow.onChange(changed),
      bridge.graphs.onChange(changed),
      bridge.workspace.onChange(changed),
    ]
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [retry])
  const active = sessions.filter((session) => session.state !== 'done')
  const recent = sessions.filter((session) => session.state === 'done')
  const attentionCount = active.filter((session) => session.state === 'attention').length
  function row(session: NodeSession) {
    const path = `/projects/${session.projectId}/tasks/${session.taskId}/graph`
    const selected =
      location.pathname === path &&
      new URLSearchParams(location.search).get('node') === session.nodeId
    return (
      <Link
        key={session.nodeId}
        to={`${path}?node=${session.nodeId}`}
        className={`sidebar-session${selected ? ' active' : ''}${session.state === 'attention' ? ' requires-attention' : ''}`}
        aria-current={selected ? 'page' : undefined}
        title={`${session.title} · ${labels[session.state]} (${session.detail})\n${session.projectName} / ${session.taskTitle}`}
      >
        <span className={`session-status ${session.state}`} aria-hidden="true">
          {session.state === 'done' && <Check size={8} strokeWidth={3} />}
          {session.state === 'attention' && <TriangleAlert size={14} />}
        </span>
        <span className="sidebar-session-text">
          <strong>{session.title}</strong>
          <small className="sidebar-session-state">{labels[session.state]}</small>
          <small>{session.state === 'attention' ? `${session.detail} · ` : ''}{session.projectName}</small>
        </span>
      </Link>
    )
  }
  return (
    <section
      className="sidebar-sessions"
      aria-labelledby="sidebar-sessions-title"
      aria-busy={loading}
    >
      <h2 className="nav-label" id="sidebar-sessions-title">
        Sessions
        <span
          className={attentionCount ? 'sidebar-attention-count' : undefined}
          role="status"
          aria-label={attentionCount ? `${attentionCount} sessions require attention` : `${active.length} active sessions`}
        >
          {attentionCount > 0 && <TriangleAlert size={12} aria-hidden="true" />}
          {attentionCount || active.length || ''}
        </span>
      </h2>
      {failed && (
        <div className="sidebar-session-message" role="status">
          <span>
            {sessions.length ? 'Sessions may be outdated.' : 'Couldn’t load sessions.'}
          </span>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <p className="sidebar-session-message">Loading sessions…</p>
      ) : !failed && !sessions.length ? (
        <p className="sidebar-session-message">Run an agent node to see it here.</p>
      ) : null}
      {active.map(row)}
      {recent.length > 0 && (
        <>
          <h3 className="sidebar-session-recent">Recent</h3>
          {recent.map(row)}
        </>
      )}
    </section>
  )
}
