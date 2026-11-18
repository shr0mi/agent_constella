import type React from 'react'
import { TerminalsPage } from './Terminals'
import { TerminalPane } from './components/TerminalPane'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import logoUrl from '../../../docs/assets/brand/agentconstella-logo.png'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  FlaskConical,
  FolderKanban,
  GitBranch,
  HardDrive,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react'
import {
  type Activity as ActivityItem,
  type Effort,
  type Failure,
  type Run,
} from '../../shared/contracts'
import { refreshDiagnostics, unwrap, useAppStore } from './store'
import { GettingStarted, ProjectBoardPage, ProjectsPage } from './Projects'
import { useWorkspaceStore } from './workspace-store'
import { resolveModelSettings } from '../../shared/model-settings'
import { CatalogPage } from './Catalogs'
import { useCatalog } from './catalog-store'
import { SkillSelector } from './components/CatalogSelectors'
import { TaskGraphPage } from './TaskGraph'
import { SidebarSessions } from './components/SidebarSessions'

function FailureNotice({
  failure,
  dismiss,
}: {
  failure: Failure
  dismiss?: () => void
}) {
  return (
    <motion.div
      className="failure"
      role="alert"
      title={failure.code}
      initial={{ opacity: 0, x: 24, filter: 'blur(4px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
    >
      <TriangleAlert size={16} />
      <div>
        <strong>{failure.message}</strong>
        {failure.hint && <p>{failure.hint}</p>}
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
    </motion.div>
  )
}

function ProjectSwitcher() {
  const projects = useWorkspaceStore((state) => state.snapshot?.projects) ?? []
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const currentId = /^\/projects\/([^/]+)/.exec(location.pathname)?.[1]
  const current = projects.find((project) => project.id === currentId)
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="project-switcher" ref={ref}>
      <button
        type="button"
        className={`project-switcher-trigger ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="project-switcher-mark">
          {current ? current.name.slice(0, 1).toUpperCase() : <FolderKanban size={15} />}
        </span>
        <span className="project-switcher-text">
          <small>{current ? 'Project' : 'Workspace'}</small>
          <strong>{current?.name ?? 'All projects'}</strong>
        </span>
        <ChevronDown size={14} className="project-switcher-chevron" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="project-switcher-menu"
            role="listbox"
            initial={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <button type="button" onClick={() => navigate('/projects')}>
              <FolderKanban size={14} />
              <span>All projects</span>
              {!current && <Check size={13} />}
            </button>
            {projects.length > 0 && <div className="project-switcher-sep" />}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === currentId}
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <span className="project-switcher-mini">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{project.name}</span>
                {project.id === currentId && <Check size={13} />}
              </button>
            ))}
            <div className="project-switcher-sep" />
            <button type="button" className="add" onClick={() => navigate('/projects')}>
              <Plus size={14} />
              <span>New or open a project</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Sidebar() {
  const diagnostics = useAppStore((s) => s.state?.diagnostics)
  const workspace = useWorkspaceStore((state) => state.snapshot)
  const projects = workspace?.projects ?? []
  useEffect(() => {
    if (!diagnostics && window.constella) void refreshDiagnostics()
  }, [diagnostics])
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <img src={logoUrl} alt="" draggable={false} />
        </span>
        <span>
          AgentConstella
          <span className="brand-sub">Local agent workspace</span>
        </span>
      </div>
      <ProjectSwitcher />
      <button
        type="button"
        className="sidebar-search"
        onClick={() => window.dispatchEvent(new Event('constella:palette'))}
      >
        <Search size={14} />
        <span>Search…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="sidebar-content">
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          <NavLink to="/projects">
            <FolderKanban size={17} />
            Projects<span className="soon">{projects.length}</span>
          </NavLink>
          <NavLink to="/terminals">
            <Terminal size={17} />
            Terminals
          </NavLink>
          <NavLink to="/playground">
            <FlaskConical size={17} />
            Connectivity lab
          </NavLink>
          <NavLink to="/skills">
            <Zap size={17} />
            Skills
          </NavLink>
          <NavLink to="/agents">
            <Bot size={17} />
            Agents
          </NavLink>
        </nav>
        <SidebarSessions />
      </div>
      <div className="sidebar-bottom">
        <NavLink to="/integration">
          <CircleHelp size={17} />
          Integration notes
          <ArrowRight size={14} />
        </NavLink>
        <NavLink to="/playground" className="agent-status" title="Open the Connectivity lab">
          <span className="agent-status-title">Your agents</span>
          {(['claude', 'codex'] as const).map((id) => {
            const ready = !!diagnostics?.providers?.find(
              (item) => item.provider === id,
            )?.available
            return (
              <span key={id} className={`agent-status-row ${ready ? 'ready' : ''}`}>
                <span className="agent-status-icon">
                  {id === 'claude' ? <Sparkles size={13} /> : <Terminal size={13} />}
                </span>
                <span className="agent-status-name">
                  {id === 'claude' ? 'Claude Code' : 'Codex'}
                </span>
                <span className="agent-status-state">
                  {!diagnostics ? (
                    '…'
                  ) : ready ? (
                    <Check size={13} strokeWidth={2.75} />
                  ) : (
                    'Not installed'
                  )}
                </span>
              </span>
            )
          })}
        </NavLink>
      </div>
    </aside>
  )
}

type PaletteItem = {
  id: string
  group: string
  label: string
  hint?: string
  icon: React.ReactNode
  to: string
}

function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [closing, setClosing] = useState(false)
  const navigate = useNavigate()
  function close(after?: () => void) {
    setClosing(true)
    window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
      after?.()
    }, 200)
  }
  const { snapshot } = useWorkspaceStore()
  useEffect(() => {
    const toggle = () => {
      setOpen((current) => !current)
      setQuery('')
      setActive(0)
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        toggle()
      } else if (event.key === 'Escape') {
        setClosing(true)
        window.setTimeout(() => {
          setOpen(false)
          setClosing(false)
        }, 200)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('constella:palette', toggle)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('constella:palette', toggle)
    }
  }, [])
  if (!open) return null
  const items: PaletteItem[] = [
    { id: 'projects', group: 'Navigate', label: 'Projects', icon: <FolderKanban size={15} />, to: '/projects' },
    { id: 'terminals', group: 'Navigate', label: 'Terminals', icon: <Terminal size={15} />, to: '/terminals' },
    { id: 'lab', group: 'Navigate', label: 'Connectivity lab', icon: <FlaskConical size={15} />, to: '/playground' },
    { id: 'skills', group: 'Navigate', label: 'Skills', icon: <Zap size={15} />, to: '/skills' },
    { id: 'agents', group: 'Navigate', label: 'Agents', icon: <Bot size={15} />, to: '/agents' },
    { id: 'notes', group: 'Navigate', label: 'Integration notes', icon: <CircleHelp size={15} />, to: '/integration' },
    ...(snapshot?.projects ?? []).map((project) => ({
      id: `p-${project.id}`,
      group: 'Projects',
      label: project.name,
      hint: project.repoPath,
      icon: <GitBranch size={15} />,
      to: `/projects/${project.id}`,
    })),
    ...(snapshot?.tasks ?? [])
      .filter((task) => !task.archivedAt)
      .map((task) => ({
        id: `t-${task.id}`,
        group: 'Tasks',
        label: task.title,
        hint: task.status,
        icon: <Layers3 size={15} />,
        to: `/projects/${task.projectId}/tasks/${task.id}/graph`,
      })),
  ]
  const q = query.trim().toLowerCase()
  const results = items.filter((item) =>
    `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase().includes(q),
  )
  const current = Math.min(active, Math.max(results.length - 1, 0))
  function go(item: PaletteItem | undefined) {
    if (!item) return
    close(() => navigate(item.to))
  }
  return (
    <div
      className={`cmdk-backdrop${closing ? ' closing' : ''}`}
      onMouseDown={() => close()}
    >
      <div
        className="cmdk"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmdk-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Jump to a page, project or task…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((current + 1) % Math.max(results.length, 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((current - 1 + results.length) % Math.max(results.length, 1))
              } else if (event.key === 'Enter') go(results[current])
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list">
          {results.length === 0 && <div className="cmdk-empty">No matches</div>}
          {results.map((item, index) => (
            <div key={item.id}>
              {(index === 0 || results[index - 1].group !== item.group) && (
                <div className="cmdk-group">{item.group}</div>
              )}
              <button
                type="button"
                className={`cmdk-item${index === current ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Ctrl K</kbd> toggle</span>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const { state, error, setState, setError } = useAppStore()
  const location = useLocation()
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot)
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
    if (
      !bridge.workspace ||
      !bridge.catalog ||
      !bridge.graphs ||
      !bridge.execution ||
      !bridge.workflow
    ) {
      setError({
        code: 'BRIDGE_VERSION',
        message: 'The desktop bridge needs to be restarted.',
        hint: 'Quit Electron completely, stop the dev command, then run npm run dev again to load the project bridge.',
      })
      useWorkspaceStore.getState().setLoading(false)
      return
    }
    let alive = true
    const unsubscribe = bridge.onState((next) => {
      if (alive) setState(next)
    })
    const unsubscribeWorkspace = bridge.workspace.onChange((snapshot) => {
      if (alive) useWorkspaceStore.getState().setSnapshot(snapshot)
    })
    void unwrap(bridge.workspace.getSnapshot())
      .then((snapshot) => {
        if (alive) useWorkspaceStore.getState().setSnapshot(snapshot)
      })
      .catch(() => {
        if (alive) useWorkspaceStore.getState().setLoading(false)
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
      unsubscribeWorkspace()
    }
  }, [setState, setError])
  const pageName =
    location.pathname === '/integration'
      ? 'Integration notes'
      : location.pathname === '/playground'
        ? 'Connectivity lab'
        : location.pathname.startsWith('/projects/')
          ? (workspaceSnapshot?.projects.find(
              (project) => project.id === location.pathname.split('/')[2],
            )?.name ?? 'Project')
          : location.pathname.slice(1)
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="topbar">
          <NavLink to="/projects" className="crumb">
            Workspace
          </NavLink>
          <ChevronRight size={14} />
          {(() => {
            const [, root, projectId, sub, taskId] = location.pathname.split('/')
            const task =
              root === 'projects' && sub === 'tasks'
                ? workspaceSnapshot?.tasks.find((item) => item.id === taskId)
                : undefined
            if (root === 'projects' && projectId && task)
              return (
                <>
                  <NavLink to={`/projects/${projectId}`} end className="crumb">
                    {pageName}
                  </NavLink>
                  <ChevronRight size={14} />
                  <strong>{task.title}</strong>
                </>
              )
            return <strong>{pageName}</strong>
          })()}
          <span className="topbar-spacer" />
          <span className="topbar-local"><HardDrive size={13} /> Local workspace</span>
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
        <CommandPalette />
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/terminals" element={<TerminalsPage />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/integration" element={<IntegrationNotes />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectBoardPage />} />
          <Route
            path="/projects/:projectId/tasks/:taskId/graph"
            element={<TaskGraphPage />}
          />
          <Route path="/skills" element={<CatalogPage kind="skills" />} />
          <Route path="/agents" element={<CatalogPage kind="profiles" />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
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
  const [effort, setEffort] = useState<Effort | '' | '__default__'>('')
  const [provider, setProvider] = useState<'codex' | 'claude'>('codex')
  const [selectedSkill, setSelectedSkill] = useState(true)
  const [profileId, setProfileId] = useState('')
  const [additionalSkills, setAdditionalSkills] = useState<string[]>([])
  const [tab, setTab] = useState<'conversation' | 'events'>('conversation')
  const [pending, setPending] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const session = state?.session
  const projects = useWorkspaceStore((state) => state.snapshot?.projects)
  const { snapshot: catalog } = useCatalog(session?.projectId ?? null)
  const profile = catalog?.profiles.find(
    (profile) => profile.id === profileId && !profile.removedAt,
  )
  const profileSkills = profile?.skillIds ?? []
  const runs = session?.runs ?? []
  const last = runs.at(-1)
  const active = last?.status === 'running' || last?.status === 'stopping'
  const models = state?.diagnostics?.models ?? []
  const project = projects?.find((project) => project.id === session?.projectId)
  const modelOverride = model === '__configured__' ? null : model || undefined
  const effortOverride = effort === '__default__' ? null : effort || undefined
  const effective = resolveModelSettings(
    { model: modelOverride, effort: effortOverride },
    profile,
    project,
  )
  const selectedModel = models.find((option) => option.id === effective.model)
  // The CLI owns sign-in, so "ready" means the selected CLI was found and runs.
  const signedIn = !!state?.diagnostics?.providers?.find(
    (item) => item.provider === provider,
  )?.available
  const skillCount =
    (selectedSkill ? 1 : 0) + new Set([...profileSkills, ...additionalSkills]).size
  function chooseProfile(id: string) {
    const selected = catalog?.profiles.find((profile) => profile.id === id)
    setProfileId(id)
    setAdditionalSkills([])
    setSelectedSkill(false)
    setModel(selected?.model ?? '')
    setEffort(selected?.effort ?? '')
  }
  function openDrawer(section?: string) {
    setDrawer(true)
    if (section)
      window.setTimeout(
        () =>
          document
            .getElementById(section)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        280,
      )
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    setProfileId('')
    setAdditionalSkills([])
    setModel('')
    setEffort('')
    setSelectedSkill(true)
  }, [session?.projectId])
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
          provider,
          model: modelOverride,
          effort: effortOverride,
          profileId: profileId || undefined,
          skillIds: [
            ...(selectedSkill ? ['connectivity-proof'] : []),
            ...additionalSkills,
          ],
        }),
      )
      setPrompt('')
      followRef.current = true
    })
  }

  return (
    <MotionConfig reducedMotion="user">
    <main className="lab-page">
      <div className="page-heading">
        <div>
          <h1>Connectivity lab</h1>
          <p>Try your installed coding agents in a disposable terminal workspace.</p>
        </div>
        <button
          className="button secondary"
          disabled={active || pending || !session}
          onClick={() =>
            void perform(async () => {
              await unwrap(
                window.constella!.newSession({ projectId: session?.projectId }),
              )
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
              <strong>Agent terminal lab</strong>
              <span>
                {session?.threadId
                  ? `Thread ${session.threadId.slice(0, 8)}… · saved locally`
                  : 'A new conversation, ready when you are'}
              </span>
            </div>
            <RunStatus run={last} turn={runs.length} />
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
              Session events
              <span className="count">
                {runs.reduce((n, run) => n + run.events.length, 0)}
              </span>
            </button>
            <span className="tab-spacer" />
            <span
              className="small-muted lab-info"
              title="Your CLI manages authentication, tool permissions, network access and its own conversation history."
            >
              <ShieldCheck size={13} />
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
            {session?.threadId?.startsWith('terminal:') && tab === 'conversation' ? (
              <TerminalPane sessionId={session.threadId.slice(9)} disabled={!active} finishLabel="Finish lab assignment" />
            ) : runs.length === 0 && !signedIn ? (
              <div className="lab-onboarding">
                <GettingStarted
                  variant="lab"
                  provider={provider}
                  onProviderChange={setProvider}
                />
              </div>
            ) : runs.length === 0 ? (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Terminal size={29} />
                </div>
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
                  Raw Session events · newest 300 per turn · large payloads are
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
                        Waiting for the native CLI…
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
            {runs.length === 0 && signedIn && (
              <div className="ac-suggestions">
                {examples.map((example) => (
                  <button
                    key={example.label}
                    type="button"
                    disabled={active || pending}
                    onClick={() => setPrompt(example.prompt)}
                  >
                    {example.icon}
                    {example.label}
                  </button>
                ))}
              </div>
            )}
            <form
              className={`ac-composer ${active ? 'is-active' : ''}`}
              onSubmit={submit}
            >
              <div className="ac-top">
                <ProviderPicker
                  provider={provider}
                  available={{
                    codex: !!state?.diagnostics?.providers?.find(
                      (item) => item.provider === 'codex',
                    )?.available,
                    claude: !!state?.diagnostics?.providers?.find(
                      (item) => item.provider === 'claude',
                    )?.available,
                  }}
                  disabled={active || pending}
                  onChange={setProvider}
                />
                <label className="sr-only" htmlFor="prompt">
                  Agent assignment
                </label>
                <textarea
                  id="prompt"
                  placeholder={
                    session?.threadId
                      ? 'Continue this conversation…'
                      : 'What should the agent do?'
                  }
                  value={prompt}
                  maxLength={32000}
                  rows={2}
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
              </div>
              <div className="ac-bottom">
                <ProfilePicker
                  profiles={(catalog?.profiles ?? []).filter(
                    (item) => !item.removedAt,
                  )}
                  selectedId={profile ? profileId : ''}
                  disabled={active || pending || !session}
                  manageTo={
                    session?.projectId
                      ? `/agents?project=${session.projectId}`
                      : '/agents'
                  }
                  onChange={chooseProfile}
                />
                <button
                  type="button"
                  className="ac-pill"
                  onClick={() => openDrawer('lab-skills')}
                >
                  <Zap size={13} />
                  {skillCount}
                  <span className="ac-pill-dim">
                    {skillCount === 1 ? 'skill' : 'skills'}
                  </span>
                </button>
                <span className="tab-spacer" />
                <span className="ac-model" title="Model">
                  {selectedModel?.name ?? 'Default model'}
                </span>
                <button
                  type="button"
                  className="ac-icon-button"
                  onClick={() => openDrawer()}
                  aria-label="Session settings"
                  title="Session settings"
                >
                  <Settings2 size={15} />
                </button>
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
                  <motion.button
                    className="ac-send"
                    aria-label={
                      session?.threadId
                        ? 'Continue conversation'
                        : 'Send prompt'
                    }
                    disabled={!prompt.trim() || pending || !session}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    {pending ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <ArrowUp size={18} />
                    )}
                  </motion.button>
                )}
              </div>
            </form>
            <div className="composer-foot">
              <span>
                {session?.threadId
                  ? 'Saved thread · each message starts a new turn'
                  : 'Runs in a disposable scratch workspace'}
              </span>
              <span>Ctrl + Enter to send</span>
            </div>
          </div>
        </section>
        {drawer && (
          <div className="lab-drawer-scrim" onClick={() => setDrawer(false)} />
        )}
        <aside
          className={`config-column lab-drawer${drawer ? ' open' : ''}`}
          inert={!drawer}
          aria-label="Session settings"
        >
          <header className="lab-drawer-head">
            <div>
              <strong>Session settings</strong>
              <span>Optional — the defaults work fine.</span>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => setDrawer(false)}
              aria-label="Close settings"
            >
              <X size={16} />
            </button>
          </header>
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
                <dt>Transport</dt>
                <dd>{state?.diagnostics?.transport ?? '—'}</dd>
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
                Sign in using your installed CLI:
                <code className="inline-command">codex login / claude auth login</code>Then
                refresh the connection.
              </p>
            )}
            <span className="connection-caption">
              Provider access is verified by a real turn.
            </span>
          </section>
          <section className="config-card lab-profile-config" id="lab-context">
            <div className="card-title">
              <Bot size={16} />
              <h2>Agent context</h2>
            </div>
            <fieldset disabled={active || pending || !session}>
              <label className="field-label" htmlFor="lab-project">
                Project
              </label>
              <div className="select-wrap">
                <select
                  id="lab-project"
                  value={session?.projectId ?? ''}
                  onChange={(event) => {
                    const projectId = event.target.value || undefined
                    void perform(async () => {
                      await unwrap(window.constella!.newSession({ projectId }))
                    })
                  }}
                >
                  <option value="">Global skills only</option>
                  {projects?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              <p className="helper">
                Changing the project starts a fresh scratch conversation.
              </p>
              <label className="field-label" htmlFor="lab-profile">
                Agent profile
              </label>
              <div className="select-wrap">
                <select
                  id="lab-profile"
                  value={profileId}
                  onChange={(event) => {
                    const id = event.target.value
                    const selected = catalog?.profiles.find(
                      (profile) => profile.id === id,
                    )
                    setProfileId(id)
                    setAdditionalSkills([])
                    setSelectedSkill(false)
                    setModel(selected?.model ?? '')
                    setEffort(selected?.effort ?? '')
                  }}
                >
                  <option value="">No profile</option>
                  {profileId && !profile && (
                    <option value={profileId}>Profile unavailable</option>
                  )}
                  {catalog?.profiles
                    .filter((profile) => !profile.removedAt)
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ·{' '}
                        {profile.projectId ? 'Project' : 'Global'}
                      </option>
                    ))}
                </select>
                <ChevronDown size={13} />
              </div>
            </fieldset>
            <p className="helper">
              <NavLink
                to={
                  session?.projectId
                    ? `/agents?project=${session.projectId}`
                    : '/agents'
                }
              >
                Manage agent profiles →
              </NavLink>
            </p>
          </section>
          <section className="config-card">
            <div className="card-title">
              <Cpu size={16} />
              <h2 id="lab-run">Run configuration</h2>
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
                  <option value="">
                    Agent/project default (
                    {profile?.model ??
                      project?.defaultModel ??
                      'configured runtime'}
                    )
                  </option>
                  <option value="__configured__">
                    Configured runtime default
                  </option>
                  {model && model !== '__configured__' && !selectedModel && (
                    <option value={model}>{model} (unavailable)</option>
                  )}
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
                  disabled={!effective.model}
                  onChange={(event) =>
                    setEffort(event.target.value as Effort | '' | '__default__')
                  }
                >
                  <option value="">Inherit agent/project effort</option>
                  <option value="__default__">Model default</option>
                  {selectedModel?.efforts.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              <p className="helper">
                The native CLI validates your model and effort settings.
              </p>
              {state?.diagnostics?.modelError && (
                <details className="catalog-error">
                  <summary>Catalog unavailable</summary>
                  <pre>{state.diagnostics.modelError}</pre>
                </details>
              )}
            </fieldset>
            <div className="permission-note">
              <ShieldCheck size={15} />
              <p>
                Native interactive permissions.
                <br />
                <span>
                  Your CLI manages authentication, tool permissions, network access, and its own conversation history.{' '}
                  <NavLink to="/integration">See integration notes.</NavLink>
                </span>
              </p>
            </div>
          </section>
          <section className="config-card">
            <div className="card-title">
              <Zap size={16} />
              <h2 id="lab-skills">Selected skills</h2>
            </div>
            <label className="skill-option">
              <input
                type="checkbox"
                checked={selectedSkill}
                disabled={active || pending}
                onChange={(event) => setSelectedSkill(event.target.checked)}
              />
              <span>
                <strong>Connectivity proof · demo</strong>
                <small>Read the fixture. Return a proof.</small>
              </span>
              <span className="skill-icon">
                <Zap size={13} />
              </span>
            </label>
            <SkillSelector
              skills={catalog?.skills ?? []}
              selected={[...new Set([...profileSkills, ...additionalSkills])]}
              requiredIds={profileSkills}
              onChange={(ids) =>
                setAdditionalSkills(
                  ids.filter((id) => !profileSkills.includes(id)),
                )
              }
              disabled={active || pending}
            />
            <p className="helper">
              Selected instructions and resources are snapshotted with each
              turn.{' '}
              <NavLink
                to={
                  session?.projectId
                    ? `/skills?project=${session.projectId}`
                    : '/skills'
                }
              >
                Manage skills →
              </NavLink>
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
    </MotionConfig>
  )
}

const providers = [
  { id: 'codex', name: 'Codex', hint: 'OpenAI Codex CLI', icon: <Terminal size={17} /> },
  { id: 'claude', name: 'Claude Code', hint: 'Anthropic Claude Code', icon: <Sparkles size={17} /> },
] as const

/** Agent switch inside the composer: icon button that pops a picker above. */
function ProviderPicker({
  provider,
  available,
  disabled,
  onChange,
}: {
  provider: 'codex' | 'claude'
  available: Record<'codex' | 'claude', boolean>
  disabled: boolean
  onChange: (provider: 'codex' | 'claude') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = providers.find((item) => item.id === provider) ?? providers[0]
  const ready = available[current.id]
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="ac-provider" ref={ref}>
      <AnimatePresence>
        {open && (
          <motion.div
            className="ac-provider-menu"
            role="listbox"
            aria-label="Choose agent"
            style={{ transformOrigin: 'bottom left' }}
            initial={{ opacity: 0, y: 12, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 400, damping: 30, mass: 0.8 }}
          >
            {providers.map((item, index) => (
              <motion.button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === provider}
                className={item.id === provider ? 'selected' : ''}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.04 * index, type: 'spring', stiffness: 400, damping: 28 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => {
                  onChange(item.id)
                  setOpen(false)
                }}
              >
                <span className="ac-provider-icon">{item.icon}</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.hint}</small>
                </span>
                <span className={`ac-provider-tag ${available[item.id] ? 'ready' : ''}`}>
                  {available[item.id] ? 'Ready' : 'Not installed'}
                </span>
                {item.id === provider && <Check size={14} />}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button
        type="button"
        className={`ac-provider-trigger ${ready ? 'is-ready' : 'is-missing'}`}
        disabled={disabled}
        aria-label={`Agent: ${current.name}, ${ready ? 'ready' : 'not found'}. Change agent`}
        title={
          ready
            ? `${current.name} · ready`
            : `${current.name} not found · click to set up`
        }
        whileTap={{ scale: 0.92 }}
        onClick={() => setOpen((value) => !value)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={current.id}
            className="ac-provider-glyph"
            initial={{ opacity: 0, scale: 0.5, rotate: -30 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.5, rotate: 30 }}
            transition={{ type: 'spring', stiffness: 380, damping: 24 }}
          >
            {current.icon}
          </motion.span>
        </AnimatePresence>
        <AnimatePresence>
          {ready && (
            <motion.span
              key={current.id}
              className="ac-provider-halo"
              aria-hidden="true"
              initial={{ opacity: 0.7, scale: 1 }}
              animate={{ opacity: 0, scale: 1.55 }}
              transition={{ duration: 1.1, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  )
}

/** Profile pill that morphs into a list panel (Dropdown Disclosure style). */
function ProfilePicker({
  profiles,
  selectedId,
  disabled,
  manageTo,
  onChange,
}: {
  profiles: { id: string; name: string; skillIds: string[]; model: string | null; projectId: string | null }[]
  selectedId: string
  disabled: boolean
  manageTo: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const options = [
    { id: '', name: 'Default agent', detail: 'No profile · CLI defaults' },
    ...profiles.map((item) => ({
      id: item.id,
      name: item.name,
      detail: `${item.skillIds.length} ${item.skillIds.length === 1 ? 'skill' : 'skills'} · ${item.model ?? 'default model'}${item.projectId ? ' · project' : ''}`,
    })),
  ]
  const current = options.find((item) => item.id === selectedId) ?? options[0]
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pill = (ghost: boolean) => (
    <>
      <motion.span
        className="ac-profile-avatar"
        layoutId={ghost ? undefined : `profile-icon-${current.id || 'default'}`}
      >
        <Bot size={13} />
      </motion.span>
      <motion.span
        className="ac-profile-name"
        layoutId={ghost ? undefined : `profile-name-${current.id || 'default'}`}
      >
        {current.name}
      </motion.span>
      <ChevronDown size={13} className="ac-profile-chevron" />
    </>
  )
  return (
    <div className="ac-profile" ref={ref}>
      <span className="ac-pill ac-profile-ghost" aria-hidden="true">
        {pill(true)}
      </span>
      <MotionConfig transition={{ type: 'spring', stiffness: 260, damping: 28, mass: 1 }}>
        <motion.div
          layout
          className={`ac-profile-shell ${open ? 'open' : ''}`}
          style={{ borderRadius: open ? 18 : 999 }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {open ? (
              <motion.div
                key="panel"
                className="ac-profile-panel"
                role="dialog"
                aria-label="Choose agent profile"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
              >
                <header>
                  <motion.strong layout="position">Choose agent</motion.strong>
                  <button
                    type="button"
                    className="ac-icon-button small"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                  >
                    <X size={13} />
                  </button>
                </header>
                <div className="ac-profile-list">
                  {options.map((item) => (
                    <motion.button
                      key={item.id || 'default'}
                      type="button"
                      className={item.id === current.id ? 'selected' : ''}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => {
                        onChange(item.id)
                        setOpen(false)
                      }}
                    >
                      <motion.span
                        className="ac-profile-avatar"
                        layoutId={`profile-icon-${item.id || 'default'}`}
                      >
                        <Bot size={14} />
                      </motion.span>
                      <span className="ac-profile-text">
                        <motion.span
                          className="ac-profile-name"
                          layoutId={`profile-name-${item.id || 'default'}`}
                        >
                          {item.name}
                        </motion.span>
                        <small>{item.detail}</small>
                      </span>
                      <span className="ac-profile-check">
                        <AnimatePresence>
                          {item.id === current.id && (
                            <motion.span
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                            >
                              <Check size={11} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                    </motion.button>
                  ))}
                </div>
                <NavLink className="ac-profile-manage" to={manageTo}>
                  Manage agents <ArrowRight size={12} />
                </NavLink>
              </motion.div>
            ) : (
              <motion.button
                key="pill"
                type="button"
                className="ac-profile-trigger"
                disabled={disabled}
                aria-haspopup="dialog"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
                onClick={() => setOpen(true)}
              >
                {pill(false)}
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>
      </MotionConfig>
    </div>
  )
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Header status: quiet standby, a live meter while working, a result after. */
function RunStatus({ run, turn }: { run?: Run; turn: number }) {
  const live = run?.status === 'running' || run?.status === 'stopping'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const elapsed = run
    ? formatDuration(
        (run.finishedAt ? Date.parse(run.finishedAt) : now) -
          Date.parse(run.startedAt),
      )
    : ''
  const kind = !run
    ? 'standby'
    : run.status === 'running'
      ? 'working'
      : run.status === 'stopping'
        ? 'stopping'
        : run.status === 'completed'
          ? 'done'
          : run.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
  const label = {
    standby: 'Standing by',
    working: 'Working',
    stopping: 'Stopping',
    done: 'Done',
    cancelled: 'Cancelled',
    failed: run?.status === 'interrupted' ? 'Interrupted' : 'Failed',
  }[kind]
  return (
    <span className={`run-state run-state-${kind}`} role="status" aria-live="polite">
      {kind === 'working' || kind === 'stopping' ? (
        <span className="run-state-meter" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : kind === 'done' ? (
        <Check size={13} strokeWidth={2.75} />
      ) : kind === 'failed' ? (
        <X size={13} strokeWidth={2.75} />
      ) : kind === 'cancelled' ? (
        <Square size={10} />
      ) : (
        <Terminal size={13} />
      )}
      <span className="run-state-label">{label}</span>
      {run && (
        <span className="run-state-meta">
          Turn {String(turn).padStart(2, '0')} · {elapsed}
        </span>
      )}
    </span>
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
                  ? 'Stopping the native CLI…'
                  : 'Waiting for the native CLI…'}
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
                  profile: run.profileSnapshot,
                  project: run.projectSnapshot,
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

const flowSteps = [
  {
    id: 'plan',
    lane: 'app',
    x: 8,
    title: 'Plan the task',
    caption: 'Board & graph',
    detail:
      'Create a task on the board and draw its workflow graph. Each agent node gets its role, skills and checks.',
  },
  {
    id: 'worktree',
    lane: 'app',
    x: 25,
    title: 'Isolated worktree',
    caption: 'Own branch',
    detail:
      'Every coding node gets its own Git branch and worktree, so agents never overwrite each other’s changes.',
  },
  {
    id: 'work',
    lane: 'cli',
    x: 37.5,
    title: 'Agent works',
    caption: 'Real terminal',
    detail:
      'Your installed Codex or Claude Code runs in a real terminal. Sign-in, native commands, permissions and model choice all belong to the CLI.',
    note: 'Your CLI stays interactive — answer its permission prompts right in the terminal.',
  },
  {
    id: 'handback',
    lane: 'cli',
    x: 62.5,
    title: 'Hands back',
    caption: 'Finish / report_done',
    detail:
      'The agent hands work back with agent_report_done or the Finish step. Quiet output or a finished reply does not count as done.',
  },
  {
    id: 'checks',
    lane: 'app',
    x: 75,
    title: 'Checks & review',
    caption: 'Tests · approvals',
    detail:
      'Your test command runs on the result, and again on combined results when needed. Human review gates wait for your approval.',
  },
  {
    id: 'integrate',
    lane: 'app',
    x: 92,
    title: 'Integrate',
    caption: 'Merge → Done',
    detail:
      'You merge into the base branch yourself. Only then does the task move to Done and release the tasks that depend on it.',
  },
] as const

const flowFacts = [
  ['Close a pane', 'detaches the viewer'],
  ['Stop', 'ends the CLI process'],
  ['Reboot', 'ends processes · state & transcripts kept'],
  ['Worktrees', 'isolate code, not OS permissions'],
] as const

function IntegrationNotes() {
  const [selected, setSelected] = useState<string>('plan')
  const [playing, setPlaying] = useState(false)
  const index = Math.max(0, flowSteps.findIndex((item) => item.id === selected))
  const step = flowSteps[index]
  const go = (delta: number) =>
    setSelected(flowSteps[(index + delta + flowSteps.length) % flowSteps.length].id)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return
      if (event.key === 'ArrowRight') {
        setPlaying(false)
        go(1)
      } else if (event.key === 'ArrowLeft') {
        setPlaying(false)
        go(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (!playing) return
    const timer = window.setTimeout(() => {
      if (index === flowSteps.length - 1) setPlaying(false)
      else go(1)
    }, 2600)
    return () => window.clearTimeout(timer)
  })
  return (
    <MotionConfig reducedMotion="user">
      <main className="notes-page flow-page">
        <span className="eyebrow">
          <span className="eyebrow-dot" /> Integration notes
        </span>
        <h1>How it works</h1>
        <p className="notes-intro">
          AgentConstella runs the workflow. Your CLI does the coding. Click a step
          to see what happens there.
        </p>
        <div className="flow-board">
          <div className={`flow-lane flow-lane-app ${step.lane === 'app' ? 'is-active' : ''}`}>
            <span className="flow-lane-label">
              <img className="flow-lane-logo" src={logoUrl} alt="" />
              <span>
                <strong>AgentConstella</strong>
                <small>Plans the work, keeps it isolated, checks and merges it</small>
              </span>
            </span>
          </div>
          <div className={`flow-lane flow-lane-cli ${step.lane === 'cli' ? 'is-active' : ''}`}>
            <span className="flow-lane-label">
              <Terminal size={14} />
              <span>
                <strong>Your coding agent</strong>
                <small>Codex or Claude Code does the coding in a real terminal</small>
              </span>
            </span>
          </div>
          <svg
            className="flow-svg"
            viewBox="0 0 1000 300"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className="flow-path"
              pathLength={100}
              d="M 80 82 L 250 82 C 320 82, 310 222, 375 222 L 625 222 C 690 222, 680 82, 750 82 L 920 82"
            />
            <path
              className="flow-comet"
              pathLength={100}
              d="M 80 82 L 250 82 C 320 82, 310 222, 375 222 L 625 222 C 690 222, 680 82, 750 82 L 920 82"
            />
          </svg>
          {flowSteps.map((item, index) => (
            <motion.button
              key={item.id}
              type="button"
              className={`flow-node ${item.lane} ${selected === item.id ? 'selected' : ''} ${flowSteps.findIndex((other) => other.id === item.id) < index ? 'visited' : ''}`}
              style={{ left: `${item.x}%`, top: item.lane === 'app' ? '27.3%' : '74%' }}
              initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ delay: 0.15 + index * 0.08, type: 'spring', stiffness: 260, damping: 24 }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              aria-pressed={selected === item.id}
              onClick={() => {
                setPlaying(false)
                setSelected(item.id)
              }}
            >
              <span className="flow-num">{String(index + 1).padStart(2, '0')}</span>
              <span className="flow-text">
                <strong>{item.title}</strong>
                <small>{item.caption}</small>
              </span>
            </motion.button>
          ))}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {step && (
            <motion.section
              key={step.id}
              className={`flow-detail ${step.lane}`}
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.22 }}
            >
              <div className="flow-detail-top">
                <span className="flow-detail-tag">
                  Step {index + 1} of {flowSteps.length} ·{' '}
                  {step.lane === 'app' ? 'AgentConstella' : 'Your coding agent'}
                </span>
                <div className="flow-detail-nav">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Previous step"
                    onClick={() => {
                      setPlaying(false)
                      go(-1)
                    }}
                  >
                    <ArrowRight size={15} style={{ transform: 'rotate(180deg)' }} />
                  </button>
                  <button
                    type="button"
                    className="flow-play"
                    onClick={() => {
                      if (!playing && index === flowSteps.length - 1) setSelected(flowSteps[0].id)
                      setPlaying((value) => !value)
                    }}
                  >
                    {playing ? <Square size={11} fill="currentColor" /> : <Activity size={13} />}
                    {playing ? 'Stop' : 'Play walkthrough'}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Next step"
                    onClick={() => {
                      setPlaying(false)
                      go(1)
                    }}
                  >
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              <h2>{step.title}</h2>
              <p>{step.detail}</p>
              {'note' in step && <p className="flow-detail-tip">Tip: {step.note}</p>}
              <div className="flow-detail-dots" aria-hidden="true">
                {flowSteps.map((item, dot) => (
                  <i key={item.id} className={dot === index ? 'now' : dot < index ? 'past' : ''} />
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>
        <div className="flow-facts">
          {flowFacts.map(([term, meaning]) => (
            <div key={term}>
              <strong>{term}</strong>
              <span>{meaning}</span>
            </div>
          ))}
        </div>
        <NavLink to="/playground" className="button secondary">
          Back to the lab
          <ArrowRight size={14} />
        </NavLink>
      </main>
    </MotionConfig>
  )
}
