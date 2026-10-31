import { useState } from 'react'
import { GitBranch, ShieldCheck, Terminal } from 'lucide-react'

const steps = [
  {
    id: 'start',
    kicker: 'Start',
    title: 'Git init',
    note: 'A repository on this machine. The board is stored locally, next to the files you already have.',
    tone: 'violet',
  },
  {
    id: 'agent',
    kicker: 'Codex agent',
    title: 'Worker',
    note: 'An agent works on a task branch. It can edit and propose a diff. It does not merge on its own.',
    tone: 'violet',
  },
  {
    id: 'review',
    kicker: 'Human review',
    title: 'Approval gate',
    note: 'You read the diff and accept it. Nothing lands on the main line until this gate opens.',
    tone: 'amber',
  },
  {
    id: 'merge',
    kicker: 'After approval',
    title: 'Integrate',
    note: 'Accepted work can join the main line. The gate is the point of the pipeline.',
    tone: 'emerald',
  },
] as const

function Node({
  id,
  active,
  onFocus,
}: {
  id: (typeof steps)[number]['id']
  active: boolean
  onFocus: (id: (typeof steps)[number]['id']) => void
}) {
  const step = steps.find((item) => item.id === id)!
  return (
    <button
      type="button"
      className={`pipeline-node tone-${step.tone} ${active ? 'active' : ''}`}
      onMouseEnter={() => onFocus(step.id)}
      onFocus={() => onFocus(step.id)}
    >
      <span className="pipeline-pip" />
      <span>
        <small>{step.kicker}</small>
        <strong>{step.title}</strong>
      </span>
      {step.id === 'start' && <GitBranch size={14} />}
      {step.id === 'agent' && <Terminal size={14} />}
      {step.id === 'review' && <ShieldCheck size={14} />}
    </button>
  )
}

function Cable({ vertical = false }: { vertical?: boolean }) {
  return (
    <svg
      className={vertical ? 'pipeline-cable vertical' : 'pipeline-cable'}
      viewBox={vertical ? '0 0 12 28' : '0 0 48 12'}
      aria-hidden="true"
    >
      <line
        className="cable-flow"
        x1={vertical ? 6 : 0}
        y1={vertical ? 0 : 6}
        x2={vertical ? 6 : 48}
        y2={vertical ? 28 : 6}
      />
    </svg>
  )
}

export function WorkflowPipeline() {
  const [focus, setFocus] = useState<(typeof steps)[number]['id']>('start')
  const note = steps.find((step) => step.id === focus)?.note
  return (
    <section className="pipeline">
      <p className="pipeline-kicker">Pipeline architecture</p>
      <div className="pipeline-board">
        <Node id="start" active={focus === 'start'} onFocus={setFocus} />
        <Cable />
        <Node id="agent" active={focus === 'agent'} onFocus={setFocus} />
        <Cable />
        <div className="pipeline-drop">
          <Node id="review" active={focus === 'review'} onFocus={setFocus} />
          <Cable vertical />
          <Node id="merge" active={focus === 'merge'} onFocus={setFocus} />
        </div>
      </div>
      <p className="pipeline-note">{note}</p>
    </section>
  )
}
