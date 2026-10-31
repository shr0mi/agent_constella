import { Activity, CheckCircle2, GitCommit, ShieldAlert } from 'lucide-react'

export function FlowTuneDock({
  activeTasks,
  doneTasks,
  signedIn,
}: {
  activeTasks: number
  doneTasks: number
  signedIn: boolean
}) {
  return (
    <footer className="flow-dock" aria-label="Workspace status">
      <div className="flow-dock-metric">
        <Activity size={14} />
        <span>
          {activeTasks} open
          <small>{doneTasks} done</small>
        </span>
      </div>
      <div className={`flow-gate ${signedIn ? 'quiet' : ''}`}>
        <ShieldAlert size={13} />
        <span>
          {signedIn
            ? 'Codex login detected'
            : 'Codex login is unconfirmed. Run npx codex login before an agent turn.'}
        </span>
      </div>
      <div className="flow-dock-pills">
        <div className="flow-pill">
          <GitCommit size={13} />
          <span>local git</span>
        </div>
        <div className={`flow-pill ${signedIn ? 'ok' : ''}`}>
          <CheckCircle2 size={13} />
          <span>{signedIn ? 'Login detected' : 'Not checked'}</span>
        </div>
      </div>
    </footer>
  )
}
