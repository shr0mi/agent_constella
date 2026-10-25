import { useEffect, useRef, useState, type FormEvent } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Cpu,
  FlaskConical,
  FolderKanban,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react'
import {
  limitations,
  skills,
  type Activity as ActivityItem,
  type Effort,
  type Failure,
  type Run,
} from '../../shared/contracts'
import { refreshDiagnostics, unwrap, useAppStore } from './store'

function FailureNotice({
  failure,
  dismiss,
}: {
  failure: Failure
  dismiss?: () => void
}) {
  return (
    <div className="failure" role="alert">
      <TriangleAlert size={17} />
      <div>
        <strong>{failure.code.replaceAll('_', ' ')}</strong>
        <pre>{failure.message}</pre>
        <p>{failure.hint}</p>
      </div>
      {dismiss && (
        <button
          className="icon-button"
          onClick={dismiss}
          aria-label="Dismiss error"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}

function Sidebar() {
  const diagnostics = useAppStore((s) => s.state?.diagnostics)
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Sparkles size={21} />
        </span>
        <span>
          AgentConstella
          <span className="brand-sub">YOUR LOCAL AGENT WORKSPACE</span>
        </span>
      </div>
      <div className="workspace-label">
        <span className="workspace-avatar">A</span>
        <div>
          Personal workspace<small>Local · single user</small>
        </div>
        <ChevronDown size={14} />
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <NavLink to="/playground">
          <FlaskConical size={17} />
          Connectivity lab
          <span className="nav-dot" />
        </NavLink>
        <NavLink to="/projects">
          <FolderKanban size={17} />
          Projects<span className="soon">02</span>
        </NavLink>
        <NavLink to="/skills">
          <Zap size={17} />
          Skills<span className="soon">03</span>
        </NavLink>
        <NavLink to="/agents">
          <Bot size={17} />
          Agents<span className="soon">03</span>
        </NavLink>
      </nav>
      <div className="sidebar-note">
        <GitBranch size={18} />
        <strong>From a task to a team.</strong>
        <p>Build visible workflows with humans and Codex.</p>
        <span>FOUNDATION · MILESTONE 01</span>
      </div>
      <div className="sidebar-bottom">
        <NavLink to="/integration">
          <CircleHelp size={17} />
          Integration notes
          <ArrowRight size={14} />
        </NavLink>
        <div className="local-indicator">
          <span
            className={`status-dot ${diagnostics?.auth.status === 'signed-in' ? 'green' : ''}`}
          />
          <div>
            Local Codex runtime
            <small>
              {diagnostics?.auth.status === 'signed-in'
                ? 'Login detected'
                : 'Check diagnostics to connect'}
            </small>
          </div>
          <Command size={15} />
        </div>
      </div>
    </aside>
  )
}

export function App() {
  const { state, error, setState, setError } = useAppStore()
  const location = useLocation()
  useEffect(() => {
    const bridge = window.constella
    if (!bridge) {
      setError({
        code: 'PRELOAD_UNAVAILABLE',
        message: 'The Electron preload bridge did not load.',
        hint: 'Restart the desktop app with npm run dev. If this persists, check the launch terminal for a preload error. The renderer URL alone cannot access Codex.',
      })
      return
    }
    let alive = true
    const unsubscribe = bridge.onState((next) => {
      if (alive) setState(next)
    })
    void unwrap(bridge.getState())
      .then((next) => {
        if (!alive) return
        setState(next)
        void refreshDiagnostics()
      })
      .catch(() => {})
    return () => {
      alive = false
      unsubscribe()
    }
  }, [setState, setError])
  const pageName =
    location.pathname === '/integration'
      ? 'Integration notes'
      : location.pathname === '/playground'
        ? 'Connectivity lab'
        : location.pathname.slice(1)
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="topbar">
          <span>Workspace</span>
          <ChevronRight size={14} />
          <strong>{pageName}</strong>
          <span className="topbar-spacer" />
          <span className="starter-badge">STARTER</span>
          <span className="avatar">AK</span>
        </header>
        <div className="global-errors">
          {error && (
            <FailureNotice
              failure={error}
              dismiss={() => setError(undefined)}
            />
          )}
          {state?.persistenceError && (
            <FailureNotice failure={state.persistenceError} />
          )}
        </div>
        <Routes>
          <Route path="/" element={<Navigate to="/playground" replace />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/integration" element={<IntegrationNotes />} />
          <Route
            path="/projects"
            element={
              <FuturePage
                title="Projects"
                milestone="02"
                text="Your repositories and Kanban boards will live here. The current milestone establishes the desktop and Codex execution foundation."
                icon={<FolderKanban size={30} />}
              />
            }
          />
          <Route
            path="/skills"
            element={
              <FuturePage
                title="Skills"
                milestone="03"
                text="Global and project skill catalogs are planned for milestone 3. Try the selected Connectivity proof skill in the lab today."
                icon={<Zap size={30} />}
              />
            }
          />
          <Route
            path="/agents"
            element={
              <FuturePage
                title="Agents"
                milestone="03"
                text="Reusable roles, instructions, and model defaults are planned for milestone 3. The lab currently runs one Codex conversation."
                icon={<Bot size={30} />}
              />
            }
          />
          <Route path="*" element={<Navigate to="/playground" replace />} />
        </Routes>
      </div>
    </div>
  )
}

const examples = [
  {
    label: 'Read a file',
    icon: <Terminal size={14} />,
    prompt:
      'Read workspace-proof.txt using a shell command and tell me the proof word. Remember the word COMET for our next turn.',
  },
  {
    label: 'Try cancellation',
    icon: <Square size={12} />,
    prompt:
      'Run a single shell command that sleeps for 30 seconds, then prints FINISHED. Do not run it in the background. I will stop this turn while it is running.',
  },
  {
    label: 'Continue the thread',
    icon: <GitBranch size={14} />,
    prompt:
      'What word did I ask you to remember earlier in this conversation? Answer from the saved conversation history.',
  },
]

function Playground() {
  const state = useAppStore((s) => s.state)
  const { checking, setError } = useAppStore()
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<Effort | ''>('')
  const [sandbox, setSandbox] = useState<'workspace-write' | 'read-only'>(
    'workspace-write',
  )
  const [selectedSkill, setSelectedSkill] = useState(true)
  const [tab, setTab] = useState<'conversation' | 'events'>('conversation')
  const [pending, setPending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const session = state?.session
  const runs = session?.runs ?? []
  const last = runs.at(-1)
  const active = last?.status === 'running' || last?.status === 'stopping'
  const models = state?.diagnostics?.models ?? []
  const selectedModel = models.find((option) => option.id === model)
  useEffect(() => {
    if (followRef.current)
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [last?.items.length, last?.events.length, last?.status, tab])

  async function perform(action: () => Promise<unknown>) {
    setPending(true)
    setError(undefined)
    try {
      await action()
    } catch (error) {
      if (!useAppStore.getState().error)
        setError({
          code: 'BRIDGE',
          message: String(error),
          hint: 'Restart the desktop app if the bridge disconnected.',
        })
    } finally {
      setPending(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || !window.constella || pending || active) return
    const message = prompt
    void perform(async () => {
      await unwrap(
        window.constella!.run({
          prompt: message,
          model: model || undefined,
          effort: effort || undefined,
          sandbox,
          skillIds: selectedSkill ? ['connectivity-proof'] : [],
        }),
      )
      setPrompt('')
      followRef.current = true
    })
  }

  return (
    <main className="lab-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span />
            FOUNDATION / 01
          </div>
          <h1>Connectivity lab</h1>
          <p>A small space to put your Codex connection to work.</p>
        </div>
        <button
          className="button secondary"
          disabled={active || pending || !session}
          onClick={() =>
            void perform(async () => {
              await unwrap(window.constella!.newSession())
              setPrompt('')
            })
          }
        >
          <Plus size={15} />
          New scratch session
        </button>
      </div>
      <div className="lab-grid">
        <section className="conversation-panel">
          <div className="panel-heading">
            <div className="agent-icon">
              <Bot size={20} />
            </div>
            <div>
              <strong>Codex playground</strong>
              <span>
                {session?.threadId
                  ? `Thread ${session.threadId.slice(0, 8)}… · saved locally`
                  : 'A new conversation, ready when you are'}
              </span>
            </div>
            <span className={`run-status ${active ? 'live' : ''}`}>
              <span className={`status-dot ${active ? 'green pulse' : ''}`} />
              {active
                ? last?.status === 'stopping'
                  ? 'Stopping'
                  : 'Working'
                : last
                  ? last.status
                  : 'Ready'}
            </span>
          </div>
          <div className="tabs">
            <button
              className={tab === 'conversation' ? 'selected' : ''}
              onClick={() => setTab('conversation')}
            >
              <MessageSquare size={14} />
              Conversation
            </button>
            <button
              className={tab === 'events' ? 'selected' : ''}
              onClick={() => setTab('events')}
            >
              <Activity size={14} />
              SDK events
              <span className="count">
                {runs.reduce((n, run) => n + run.events.length, 0)}
              </span>
            </button>
            <span className="tab-spacer" />
            <span className="small-muted">
              <ShieldCheck size={13} />
              {sandbox === 'workspace-write' ? 'Workspace writes' : 'Read only'}
            </span>
          </div>
          <div
            className="transcript"
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current
              if (el)
                followRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 150
            }}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {runs.length === 0 ? (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Sparkles size={29} />
                  <span className="orbit orbit-one" />
                  <span className="orbit orbit-two" />
                </div>
                <span className="eyebrow">LET’S MAKE A CONNECTION</span>
                <h2>
                  One workspace.
                  <br />
                  One real conversation.
                </h2>
                <p>
                  Send a prompt, watch tools run, then pick up where you left
                  off. Everything happens in a disposable local workspace.
                </p>
                <div className="flow">
                  <span>
                    <Terminal size={14} />
                    Execute
                  </span>
                  <i />
                  <span>
                    <Square size={11} />
                    Stop
                  </span>
                  <i />
                  <span>
                    <GitBranch size={14} />
                    Continue
                  </span>
                </div>
              </div>
            ) : tab === 'conversation' ? (
              runs.map((run, index) => (
                <RunView key={run.id} run={run} number={index + 1} />
              ))
            ) : (
              <div className="event-log">
                <div className="event-log-note">
                  Raw SDK events · newest 300 per turn · large payloads are
                  truncated. Nested tool activity can be missing from this
                  stream.
                </div>
                {runs.map((run, index) => (
                  <div key={run.id}>
                    <h3>
                      TURN {String(index + 1).padStart(2, '0')}{' '}
                      <span>{run.status}</span>
                    </h3>
                    {run.events.length === 0 && (
                      <p className="small-muted">
                        Waiting for the SDK process…
                      </p>
                    )}
                    {run.events.map((event, i) => (
                      <details key={`${run.id}-${i}`}>
                        <summary>
                          <span className="event-time">
                            {new Date(event.at).toLocaleTimeString()}
                          </span>
                          <code>{event.type}</code>
                          <ChevronDown size={12} />
                        </summary>
                        <pre>{event.detail}</pre>
                      </details>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="composer-area">
            <div className="examples">
              {examples.map((example) => (
                <button
                  key={example.label}
                  disabled={active || pending}
                  onClick={() => setPrompt(example.prompt)}
                >
                  {example.icon}
                  {example.label}
                </button>
              ))}
            </div>
            <form
              className={`composer ${active ? 'is-active' : ''}`}
              onSubmit={submit}
            >
              <label className="sr-only" htmlFor="prompt">
                Message Codex
              </label>
              <textarea
                id="prompt"
                placeholder={
                  session?.threadId
                    ? 'Continue this conversation…'
                    : 'Ask Codex to do something in the scratch workspace…'
                }
                value={prompt}
                maxLength={32000}
                disabled={active || pending || !session}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              <div className="composer-toolbar">
                <span>
                  <Terminal size={13} />
                  Scratch workspace<span className="composer-separator">/</span>
                  {selectedModel?.name ?? 'Configured default'}
                </span>
                {active ? (
                  <button
                    type="button"
                    className="button stop"
                    disabled={last?.status === 'stopping' || pending}
                    onClick={() =>
                      void perform(() => unwrap(window.constella!.stop()))
                    }
                  >
                    <Square size={13} fill="currentColor" />
                    {last?.status === 'stopping' ? 'Stopping…' : 'Stop'}
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label={
                      session?.threadId
                        ? 'Continue conversation'
                        : 'Send prompt'
                    }
                    disabled={!prompt.trim() || pending || !session}
                  >
                    {pending ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <ArrowUp size={19} />
                    )}
                  </button>
                )}
              </div>
            </form>
            <div className="composer-foot">
              <span>
                {session?.threadId
                  ? 'Saved thread · each message starts a new turn'
                  : 'Messages use your local Codex authentication'}
              </span>
              <span>⌘ / Ctrl + Enter to send</span>
            </div>
          </div>
        </section>
        <aside className="config-column">
          <section className="config-card">
            <div className="card-title">
              <Radio size={16} />
              <h2>Connection</h2>
              <button
                className="icon-button"
                onClick={() => void refreshDiagnostics()}
                disabled={checking || !session}
                aria-label="Refresh diagnostics"
              >
                <RefreshCw size={14} className={checking ? 'spin' : ''} />
              </button>
            </div>
            <div className="connection-state">
              <span
                className={`status-dot ${state?.diagnostics?.auth.status === 'signed-in' ? 'green' : ''}`}
              />
              {checking
                ? 'Checking local runtime…'
                : state?.diagnostics?.auth.status === 'signed-in'
                  ? 'Login detected'
                  : 'Authentication unconfirmed'}
            </div>
            <dl className="runtime-versions">
              <div>
                <dt>SDK</dt>
                <dd>{state?.diagnostics?.sdkVersion ?? '—'}</dd>
              </div>
              <div>
                <dt>CLI</dt>
                <dd>
                  {state?.diagnostics?.cliVersion.replace('codex-cli ', '') ??
                    '—'}
                </dd>
              </div>
            </dl>
            {state?.diagnostics?.auth.status !== 'signed-in' && (
              <p className="helper">
                Sign in from this repository:
                <code className="inline-command">npx codex login</code>Then
                refresh the connection.
              </p>
            )}
            <span className="connection-caption">
              Provider access is verified by a real turn.
            </span>
          </section>
          <section className="config-card">
            <div className="card-title">
              <Cpu size={16} />
              <h2>Run configuration</h2>
            </div>
            <fieldset disabled={active || pending}>
              <label className="field-label" htmlFor="model">
                Model
              </label>
              <div className="select-wrap">
                <select
                  id="model"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value)
                    setEffort('')
                  }}
                >
                  <option value="">Configured default</option>
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              <label className="field-label" htmlFor="effort">
                Reasoning effort
              </label>
              <div className="select-wrap">
                <select
                  id="effort"
                  value={effort}
                  disabled={!selectedModel}
                  onChange={(event) =>
                    setEffort(event.target.value as Effort | '')
                  }
                >
                  <option value="">Model default</option>
                  {selectedModel?.efforts.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              <p className="helper">
                {models.length
                  ? 'Options from the pinned runtime catalog.'
                  : 'Use the configured default until the runtime catalog is available.'}
              </p>
              {state?.diagnostics?.modelError && (
                <details className="catalog-error">
                  <summary>Catalog unavailable</summary>
                  <pre>{state.diagnostics.modelError}</pre>
                </details>
              )}
              <label className="field-label" htmlFor="sandbox">
                File access
              </label>
              <div className="select-wrap">
                <select
                  id="sandbox"
                  value={sandbox}
                  onChange={(event) =>
                    setSandbox(event.target.value as typeof sandbox)
                  }
                >
                  <option value="workspace-write">
                    Write in scratch workspace
                  </option>
                  <option value="read-only">Read only</option>
                </select>
                <ChevronDown size={13} />
              </div>
            </fieldset>
            <div className="permission-note">
              <ShieldCheck size={15} />
              <p>
                No interactive approvals.
                <br />
                <span>
                  Sandbox network access and web search are disabled. Nested
                  tool failures can be absent from the event feed.{' '}
                  <NavLink to="/integration">See integration notes.</NavLink>
                </span>
              </p>
            </div>
          </section>
          <section className="config-card">
            <div className="card-title">
              <Zap size={16} />
              <h2>Selected skill</h2>
              <span className="tiny-tag">1 AVAILABLE</span>
            </div>
            <label className="skill-option">
              <input
                type="checkbox"
                checked={selectedSkill}
                disabled={active || pending}
                onChange={(event) => setSelectedSkill(event.target.checked)}
              />
              <span>
                <strong>{skills[0].name}</strong>
                <small>Read the fixture. Return a proof.</small>
              </span>
              <span className="skill-icon">
                <Zap size={13} />
              </span>
            </label>
            <p className="helper">
              Selected instructions and their resource path are saved with each
              turn.
            </p>
          </section>
          <section className="workspace-card">
            <div>
              <Layers3 size={15} />
              <strong>Disposable workspace</strong>
            </div>
            <p title={session?.workspace}>
              {session?.workspace ?? 'Preparing workspace…'}
            </p>
            <span>
              <Check size={12} />
              App metadata is stored separately
            </span>
          </section>
        </aside>
      </div>
    </main>
  )
}

function RunView({ run, number }: { run: Run; number: number }) {
  return (
    <article className="turn">
      <div className="turn-divider">
        <span>TURN {String(number).padStart(2, '0')}</span>
        <span>
          {run.options.model ?? 'Configured default'} ·{' '}
          {run.options.effort ?? 'default effort'}
        </span>
      </div>
      <div className="user-message">
        <span className="message-avatar">You</span>
        <div>
          <div className="message-label">
            You
            <time>
              {new Date(run.startedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
          <p>{run.prompt}</p>
        </div>
      </div>
      <div className="agent-message">
        <span className="message-avatar codex">
          <Bot size={16} />
        </span>
        <div className="agent-content">
          <div className="message-label">
            Codex<span className="tiny-tag">{run.status}</span>
          </div>
          {run.items.map((item) => (
            <ActivityView item={item} key={item.id} />
          ))}
          {run.items.length === 0 &&
            ['running', 'stopping'].includes(run.status) && (
              <div className="waiting">
                <LoaderCircle size={14} className="spin" />
                {run.status === 'stopping'
                  ? 'Stopping the SDK process…'
                  : 'Waiting for the first SDK event…'}
              </div>
            )}
          {run.error && <FailureNotice failure={run.error} />}
          {run.status === 'cancelled' && (
            <div className="interrupted-note">
              <Square size={13} />
              Stopped. File changes remain. Send a message to continue this
              thread.
            </div>
          )}
          {run.usage && (
            <div className="usage">
              <Check size={12} />
              Turn completed
              <span>
                {run.usage.input_tokens.toLocaleString()} in /{' '}
                {run.usage.output_tokens.toLocaleString()} out
              </span>
            </div>
          )}
          <details className="snapshot">
            <summary>
              Run snapshot
              <ChevronDown size={12} />
            </summary>
            <pre>
              {JSON.stringify(
                {
                  options: run.options,
                  selectedSkills: run.skillSnapshots,
                  resolvedPrompt: run.resolvedPrompt,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </div>
    </article>
  )
}

function ActivityView({ item }: { item: ActivityItem }) {
  if (item.type === 'agent_message')
    return <div className="assistant-text">{item.text}</div>
  return (
    <details
      className={`tool-item ${item.type === 'error' ? 'tool-failed' : ''}`}
    >
      <summary>
        {item.type === 'reasoning' ? (
          <Sparkles size={13} />
        ) : (
          <Terminal size={13} />
        )}
        <span>{item.title}</span>
        {item.status && <small>{item.status}</small>}
        <ChevronDown size={12} />
      </summary>
      <pre>{item.text || 'No output yet.'}</pre>
    </details>
  )
}

function IntegrationNotes() {
  return (
    <main className="notes-page">
      <div className="eyebrow">FOUNDATION / INTEGRATION RECORD</div>
      <h1>Know the boundaries.</h1>
      <p className="notes-intro">
        The starter uses the Codex TypeScript SDK for execution. These
        constraints shape the full application.
      </p>
      <div className="notes-grid">
        {limitations.map((note, i) => (
          <section className="note-card" key={note}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            <h2>
              {
                [
                  'Permissions',
                  'Streaming',
                  'Skills',
                  'Model discovery',
                  'Cancellation',
                  'Local persistence',
                ][i]
              }
            </h2>
            <p>{note}</p>
          </section>
        ))}
      </div>
      <div className="next-note">
        <TriangleAlert size={18} />
        <div>
          <strong>Approval UI requires a transport decision.</strong>
          <p>
            Use Codex app-server if later milestones need bidirectional approval
            requests, native skill inputs, or richer streaming. See
            docs/codex-integration.md for the implementation record and
            verification commands.
          </p>
        </div>
      </div>
      <NavLink to="/playground" className="button secondary">
        Back to the lab
        <ArrowRight size={14} />
      </NavLink>
    </main>
  )
}

function FuturePage({
  title,
  text,
  milestone,
  icon,
}: {
  title: string
  text: string
  milestone: string
  icon: React.ReactNode
}) {
  return (
    <main className="future-page">
      <div className="future-icon">{icon}</div>
      <span className="eyebrow">PLANNED / MILESTONE {milestone}</span>
      <h1>{title}</h1>
      <p>{text}</p>
      <NavLink to="/playground" className="button primary">
        Open connectivity lab
        <ArrowRight size={15} />
      </NavLink>
    </main>
  )
}
