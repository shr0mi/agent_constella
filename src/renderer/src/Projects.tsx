import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Archive,
  Bot,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  Circle,
  Clock3,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GripVertical,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type { Project, Task, TaskStatus } from '../../shared/workspace'
import { effortSchema, type Effort, type Failure } from '../../shared/contracts'
import type { WorkflowSummary } from '../../shared/workflow'
import { useAppStore } from './store'
import { Modal } from './components/Modal'
import { ManagerChat } from './ManagerChat'
import { ProjectIdeButton, TaskIdeButton } from './TaskReview'
import {
  refreshWorkspace,
  useWorkspaceStore,
  workspaceAction,
} from './workspace-store'

const columns: { id: TaskStatus; title: string; caption: string }[] = [
  { id: 'todo', title: 'To Do', caption: 'Ready to take shape' },
  { id: 'doing', title: 'Doing', caption: 'Work in motion' },
  { id: 'done', title: 'Done', caption: 'Integrated into the base branch' },
]

function taskWorkflowLabel(workflow: WorkflowSummary) {
  if (workflow.running)
    return `${workflow.running} agent${workflow.running === 1 ? '' : 's'} running`
  if (workflow.phase === 'completed')
    return workflow.integration === 'integrated'
      ? 'Integrated'
      : 'Awaiting integration'
  if (workflow.blockers.some((message) => message.startsWith('Waiting for “')))
    return 'Waiting for prerequisites'
  if (workflow.phase === 'waiting')
    return workflow.scheduling === 'manual' && !workflow.blockers.length
      ? 'Choose a ready node'
      : 'Waiting for acceptance / review'
  return workflow.phase
}

function RepositoryButton({ create = false }: { create?: boolean }) {
  const navigate = useNavigate()
  const pending = useWorkspaceStore((state) => state.pending)
  const [opening, setOpening] = useState(false)
  async function open() {
    setOpening(true)
    try {
      const project = await workspaceAction((api) =>
        create ? api.chooseNewProject() : api.chooseRepository(),
      )
      if (project) navigate(`/projects/${project.id}`)
    } catch {
      /* Shared error notice keeps the native picker failure visible. */
    } finally {
      setOpening(false)
    }
  }
  return (
    <button
      className={`button ${create ? 'primary' : 'secondary'}`}
      title={
        create
          ? 'Create a new project folder and initialize Git'
          : 'Open an existing folder and initialize Git if needed'
      }
      disabled={pending > 0}
      onClick={() => void open()}
    >
      {opening ? (
        <LoaderCircle size={15} className="spin" />
      ) : create ? (
        <Plus size={15} />
      ) : (
        <FolderOpen size={15} />
      )}
      {create ? 'Create project' : 'Open folder'}
    </button>
  )
}

function ProjectActions() {
  return (
    <div className="project-entry-actions">
      <RepositoryButton />
      <RepositoryButton create />
    </div>
  )
}

export function ProjectsPage() {
  const { snapshot, loading } = useWorkspaceStore()
  const [search, setSearch] = useState('')
  const projects = snapshot?.projects ?? []
  const visible = projects.filter((project) =>
    `${project.name} ${project.repoPath} ${project.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  const tasks = snapshot?.tasks.filter((task) => !task.archivedAt) ?? []
  return (
    <main className="projects-page">
      <div className="page-heading">
        <div>
          <h1>Your projects</h1>
          <p>A home for each repository. A clear view of the work ahead.</p>
        </div>
        {projects.length > 0 && <ProjectActions />}
      </div>
      <div className="project-overview" aria-label="Workspace summary">
        <div>
          <FolderGit2 size={17} />
          <strong>{projects.length}</strong>
          <span>{projects.length === 1 ? 'repository' : 'repositories'}</span>
        </div>
        <div>
          <Layers3 size={17} />
          <strong>{tasks.length}</strong>
          <span>{tasks.length === 1 ? 'active task' : 'active tasks'}</span>
        </div>
        <div>
          <CheckCheck size={17} />
          <strong>
            {tasks.filter((task) => task.status === 'done').length}
          </strong>
          <span>completed</span>
        </div>
        <span className="local-storage-tag">
          <span className="status-dot green" />
          Saved on this device
        </span>
      </div>
      <div className="projects-toolbar">
        <span>
          Repositories <small>{projects.length}</small>
        </span>
        <label className="workspace-search">
          <Search size={14} />
          <input
            aria-label="Search projects"
            placeholder="Find a project…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {loading && !snapshot ? (
        <LoadingWorkspace />
      ) : !snapshot ? (
        <div className="workspace-empty">
          <h2>Workspace could not be loaded</h2>
          <button
            className="button secondary"
            onClick={() => void refreshWorkspace()}
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="workspace-empty first-project">
          <div className="empty-project-icon">
            <FolderGit2 size={32} />
          </div>
          <h2>Give your next idea a workspace.</h2>
          <p>
            Create a project folder or open one you already have. We’ll set up
            Git and its board so you can start capturing the work.
          </p>
          <ProjectActions />
          <span className="empty-footnote">
            Project files stay in place. Boards and settings are saved locally.
          </span>
        </div>
      ) : (
        <div className="project-cards">
          {visible.length > 0 && (
            <div className="project-list-header" aria-hidden="true">
              <span>Repository</span>
              <span>Workload</span>
              <span />
            </div>
          )}
          {visible.map((project) => {
            const projectTasks = tasks.filter(
              (task) => task.projectId === project.id,
            )
            const done = projectTasks.filter(
              (task) => task.status === 'done',
            ).length
            return (
              <Link
                to={`/projects/${project.id}`}
                key={project.id}
                className="project-card"
              >
                <div className="project-identity">
                  <span className="project-monogram" aria-hidden="true">
                    <FolderGit2 size={20} />
                  </span>
                  <div>
                    <h2>{project.name}</h2>
                    <p className="project-card-path" title={project.repoPath}>
                      <GitBranch size={12} />
                      <span>{project.repoPath}</span>
                    </p>
                    <p className="project-card-description">
                      {project.description ||
                        'Add a project brief in settings to give the work context.'}
                    </p>
                  </div>
                </div>
                <div className="project-card-work">
                  <span>
                    <strong>{projectTasks.length}</strong>{' '}
                    {projectTasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                  <span className="project-completion">{done} done</span>
                  <div className="project-progress" aria-hidden="true">
                    <span
                      style={{
                        transform: `scaleX(${projectTasks.length ? done / projectTasks.length : 0})`,
                      }}
                    />
                  </div>
                </div>
                <span className="project-open" aria-hidden="true">
                  Open project <ArrowRight size={16} />
                </span>
              </Link>
            )
          })}
          {visible.length === 0 && (
            <div className="workspace-empty">
              <h2>No matching projects</h2>
              <p>Try another name or repository path.</p>
            </div>
          )}
        </div>
      )}
    </main>
  )
}

function LoadingWorkspace() {
  return (
    <div className="workspace-loading" role="status">
      <span className="sr-only">Loading your workspace…</span>
      {[0, 1, 2].map((row) => (
        <div className="workspace-skeleton" key={row} aria-hidden="true">
          <span />
          <div>
            <i />
            <i />
          </div>
          <span />
        </div>
      ))}
    </div>
  )
}

export function ProjectBoardPage() {
  const { projectId } = useParams()
  const { snapshot, loading, pending } = useWorkspaceStore()
  const project = snapshot?.projects.find((project) => project.id === projectId)
  const [editor, setEditor] = useState<Task | TaskStatus | null>(null)
  const [settings, setSettings] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropColumn, setDropColumn] = useState<TaskStatus | null>(null)
  const [undo, setUndo] = useState<Task | null>(null)
  useEffect(() => {
    setEditor(null)
    setSettings(false)
    setArchiveOpen(false)
    setSearch('')
    setUndo(null)
    setDragged(null)
  }, [projectId])
  if (loading && !snapshot) return <LoadingWorkspace />
  if (!project)
    return (
      <main className="projects-page">
        <div className="workspace-empty">
          <FolderGit2 size={30} />
          <h2>Project not found</h2>
          <p>Choose a repository from your saved projects.</p>
          <Link className="button secondary" to="/projects">
            <ArrowLeft size={14} />
            All projects
          </Link>
        </div>
      </main>
    )
  const projectTasks = snapshot!.tasks.filter(
    (task) => task.projectId === project.id,
  )
  const activeTasks = projectTasks.filter((task) => !task.archivedAt)
  const archived = projectTasks
    .filter((task) => task.archivedAt)
    .sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!))
  const done = activeTasks.filter((task) => task.status === 'done').length

  async function move(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
  ) {
    try {
      await workspaceAction((api) =>
        api.moveTask({
          projectId: task.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          status,
          beforeTaskId,
        }),
      )
    } catch {
      /* Failed mutations keep the committed board intact. */
    }
  }
  async function archive(task: Task) {
    try {
      const saved = await workspaceAction((api) =>
        api.archiveTask({
          projectId: task.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
        }),
      )
      setUndo(saved)
      setEditor(null)
    } catch {
      /* The shared notice explains why archiving failed. */
    }
  }
  async function restore(task: Task) {
    try {
      await workspaceAction((api) =>
        api.restoreTask({
          projectId: task.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
        }),
      )
      if (undo?.id === task.id) setUndo(null)
    } catch {
      /* The archive remains available after a failed restore. */
    }
  }
  function drop(
    event: DragEvent,
    status: TaskStatus,
    beforeTaskId: string | null = null,
  ) {
    event.preventDefault()
    event.stopPropagation()
    const taskId = event.dataTransfer.getData('application/x-constella-task')
    const task = activeTasks.find((task) => task.id === taskId)
    setDragged(null)
    setDropColumn(null)
    if (task && !pending && task.id !== beforeTaskId)
      void move(task, status, beforeTaskId)
  }

  return (
    <main className="project-board-page">
      <Link to="/projects" className="back-link">
        <ArrowLeft size={13} />
        All projects
      </Link>
      <div className="page-heading board-heading">
        <div>
          <h1>{project.name}</h1>
          <p className="board-repo-path" title={project.repoPath}>
            {project.repoPath}
          </p>
        </div>
        <div className="heading-actions">
          <ManagerChat projectId={project.id} taskId={null} />
          <ProjectIdeButton projectId={project.id} />
          <button
            className="button secondary"
            onClick={() => setSettings(true)}
            disabled={pending > 0}
          >
            <Settings2 size={14} />
            Project settings
          </button>
          <button
            className="button primary"
            onClick={() => setEditor('todo')}
            disabled={pending > 0}
          >
            <Plus size={15} />
            New task
          </button>
        </div>
      </div>
      {project.description && (
        <p className="project-brief">{project.description}</p>
      )}
      <div className="board-toolbar">
        <div className="board-tab">
          <FolderGit2 size={14} />
          Board<span>{activeTasks.length}</span>
        </div>
        <span className="board-progress-text">
          {done} of {activeTasks.length} done
        </span>
        <span className="toolbar-spacer" />
        <Link
          className="button archive-toggle"
          to={`/skills?project=${project.id}`}
        >
          <Zap size={13} />
          Skills
        </Link>
        <Link
          className="button archive-toggle"
          to={`/agents?project=${project.id}`}
        >
          <Bot size={13} />
          Agents
        </Link>
        <label className="workspace-search">
          <Search size={13} />
          <input
            aria-label="Search tasks"
            placeholder="Filter tasks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              className="icon-button"
              onClick={() => setSearch('')}
              aria-label="Clear task filter"
            >
              <X size={12} />
            </button>
          )}
        </label>
        <button
          className={`button archive-toggle ${archiveOpen ? 'active' : ''}`}
          onClick={() => setArchiveOpen((value) => !value)}
        >
          <Archive size={14} />
          Archive<span>{archived.length}</span>
        </button>
      </div>
      <div className="kanban-board">
        {columns.map((column) => {
          const all = activeTasks
            .filter((task) => task.status === column.id)
            .sort((a, b) => a.position - b.position)
          const visible = all.filter((task) =>
            `${task.title} ${task.description} ${task.acceptanceCriteria}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          return (
            <section
              key={column.id}
              className={`kanban-column ${column.id} ${dropColumn === column.id ? 'drop-active' : ''}`}
              aria-label={`${column.title} column`}
              onDragOver={(event) => {
                if (dragged && !search && !pending) {
                  event.preventDefault()
                  setDropColumn(column.id)
                }
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setDropColumn(null)
              }}
              onDrop={(event) => drop(event, column.id)}
            >
              <div className="column-heading">
                <span className="column-dot" />
                <h2>{column.title}</h2>
                <span>{all.length}</span>
                <button
                  className="icon-button"
                  aria-label={`Add task to ${column.title}`}
                  onClick={() => setEditor(column.id)}
                  disabled={pending > 0 || column.id === 'done'}
                  title={
                    column.id === 'done'
                      ? 'Tasks move here after integration'
                      : undefined
                  }
                >
                  <Plus size={15} />
                </button>
              </div>
              <p className="column-caption">{column.caption}</p>
              <div className="column-cards">
                {visible.map((task) => {
                  const index = all.findIndex((row) => row.id === task.id)
                  return (
                    <article
                      key={task.id}
                      className={`task-card ${dragged === task.id ? 'dragging' : ''}`}
                      draggable={!pending && !search}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          'application/x-constella-task',
                          task.id,
                        )
                        event.dataTransfer.effectAllowed = 'move'
                        setDragged(task.id)
                      }}
                      onDragEnd={() => {
                        setDragged(null)
                        setDropColumn(null)
                      }}
                      onDragOver={(event) => {
                        if (dragged && !pending && !search)
                          event.preventDefault()
                      }}
                      onDrop={(event) => drop(event, column.id, task.id)}
                    >
                      <div className="task-card-meta">
                        <span>AC-{task.id.slice(0, 6).toUpperCase()}</span>
                        <GripVertical size={13} />
                      </div>
                      <button
                        className="task-open"
                        onClick={() => setEditor(task)}
                      >
                        <h3>{task.title}</h3>
                        {task.description && <p>{task.description}</p>}
                      </button>
                      {task.acceptanceCriteria && (
                        <span className="task-criteria">
                          <Target size={11} />
                          Acceptance criteria added
                        </span>
                      )}
                      {(() => {
                        const workflow = snapshot?.workflows?.find(
                          (workflow) => workflow.taskId === task.id,
                        )
                        return workflow?.started ? (
                          <div
                            className={`task-workflow-badge ${workflow.phase}`}
                            title={workflow.blockers.join('\n')}
                          >
                            <span>{taskWorkflowLabel(workflow)}</span>
                            <strong>
                              {workflow.accepted}/{workflow.total}
                            </strong>
                            {workflow.blockers[0] && (
                              <small>{workflow.blockers[0]}</small>
                            )}
                            {workflow.integration === 'conflicts' && (
                              <small>Integration conflicts</small>
                            )}
                          </div>
                        ) : null
                      })()}
                      {(task.dependencyIds ?? []).length > 0 && (
                        <p className="task-dependency-note">
                          Depends on:{' '}
                          {task.dependencyIds
                            .map(
                              (id) =>
                                projectTasks.find((other) => other.id === id)
                                  ?.title ?? 'Missing task',
                            )
                            .join(', ')}
                        </p>
                      )}
                      <div className="task-card-actions">
                        <Link
                          className="task-graph-link"
                          to={`/projects/${project.id}/tasks/${task.id}/graph`}
                          aria-label={`Open graph for ${task.title}`}
                        >
                          <GitBranch size={12} />
                          Graph
                        </Link>
                        <div className="task-order-controls">
                          <button
                            className="icon-button"
                            aria-label={`Move ${task.title} up`}
                            disabled={pending > 0 || index === 0 || !!search}
                            onClick={() =>
                              void move(
                                task,
                                task.status,
                                all[index - 1]?.id ?? null,
                              )
                            }
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Move ${task.title} down`}
                            disabled={
                              pending > 0 ||
                              index === all.length - 1 ||
                              !!search
                            }
                            onClick={() =>
                              void move(
                                task,
                                task.status,
                                all[index + 2]?.id ?? null,
                              )
                            }
                          >
                            <ArrowDown size={12} />
                          </button>
                        </div>
                        <select
                          aria-label={`Status for ${task.title}`}
                          value={task.status}
                          disabled={
                            pending > 0 ||
                            !!snapshot?.workflows?.find(
                              (workflow) =>
                                workflow.taskId === task.id && workflow.started,
                            )
                          }
                          title={
                            snapshot?.workflows?.some(
                              (workflow) =>
                                workflow.taskId === task.id && workflow.started,
                            )
                              ? 'Status follows workflow progression. Use the graph to continue or revise.'
                              : undefined
                          }
                          onChange={(event) =>
                            void move(task, event.target.value as TaskStatus)
                          }
                        >
                          {columns.map((option) => (
                            <option
                              key={option.id}
                              value={option.id}
                              disabled={
                                option.id === 'done' && task.status !== 'done'
                              }
                            >
                              {option.title}
                            </option>
                          ))}
                        </select>
                        <TaskIdeButton
                          identity={{ projectId: project.id, taskId: task.id }}
                          iconOnly
                          label={`Open ${task.title} in IDE`}
                        />
                        <button
                          className="icon-button task-archive"
                          aria-label={`Archive ${task.title}`}
                          disabled={pending > 0}
                          onClick={() => void archive(task)}
                        >
                          <Archive size={12} />
                        </button>
                      </div>
                    </article>
                  )
                })}
                {visible.length === 0 && (
                  <div className="empty-column">
                    {column.id === 'done' ? (
                      <CheckCheck size={23} />
                    ) : column.id === 'doing' ? (
                      <Clock3 size={23} />
                    ) : (
                      <Circle size={23} />
                    )}
                    <p>
                      {search
                        ? 'No matching tasks'
                        : column.id === 'todo'
                          ? 'Make space for the next step.'
                          : column.id === 'doing'
                            ? 'Ready when you are.'
                            : 'Your finished work lands here.'}
                    </p>
                  </div>
                )}
              </div>
              <button
                className="column-add"
                disabled={pending > 0 || column.id === 'done'}
                onClick={() => setEditor(column.id)}
              >
                <Plus size={13} />
                Add task
              </button>
            </section>
          )
        })}
      </div>
      <div className="board-footer">
        <span>
          <Check size={12} />
          Changes saved locally
        </span>
        <span>Drag to reorder or move between columns</span>
      </div>
      {archiveOpen && (
        <section className="archive-panel">
          <div className="archive-heading">
            <div>
              <Archive size={16} />
              <h2>Archived tasks</h2>
              <span>{archived.length}</span>
            </div>
            <button
              className="icon-button"
              onClick={() => setArchiveOpen(false)}
              aria-label="Close archive"
            >
              <X size={16} />
            </button>
          </div>
          {archived.length === 0 ? (
            <p className="archive-empty">No archived tasks in this project.</p>
          ) : (
            archived.map((task) => (
              <div className="archive-row" key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <span>
                    {columns.find((column) => column.id === task.status)?.title}{' '}
                    · Archived {new Date(task.archivedAt!).toLocaleDateString()}
                  </span>
                </div>
                <button
                  className="button secondary"
                  disabled={pending > 0}
                  onClick={() => void restore(task)}
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              </div>
            ))
          )}
        </section>
      )}
      {undo && (
        <div className="undo-toast" role="status">
          <Archive size={15} />
          <span>Task archived</span>
          <button disabled={pending > 0} onClick={() => void restore(undo)}>
            Undo
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss undo"
            onClick={() => setUndo(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {editor !== null && (
        <TaskEditor
          key={typeof editor === 'string' ? `new-${editor}` : editor.id}
          project={project}
          task={typeof editor === 'string' ? undefined : editor}
          status={typeof editor === 'string' ? editor : editor.status}
          onClose={() => setEditor(null)}
          onArchive={archive}
        />
      )}
      {settings && (
        <ProjectSettings
          key={project.id}
          project={project}
          onClose={() => setSettings(false)}
        />
      )}
    </main>
  )
}

function TaskEditor({
  project,
  task,
  status,
  onClose,
  onArchive,
}: {
  project: Project
  task?: Task
  status: TaskStatus
  onClose: () => void
  onArchive: (task: Task) => Promise<void>
}) {
  const [failure, setFailure] = useState<Failure>()
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [criteria, setCriteria] = useState(task?.acceptanceCriteria ?? '')
  const [dependencyIds, setDependencyIds] = useState(task?.dependencyIds ?? [])
  const [requiredFiles, setRequiredFiles] = useState(
    (task?.requiredFiles ?? []).join('\n'),
  )
  const snapshot = useWorkspaceStore((state) => state.snapshot)
  const prerequisites =
    snapshot?.tasks.filter(
      (other) =>
        other.projectId === project.id &&
        other.id !== task?.id &&
        (!other.archivedAt || dependencyIds.includes(other.id)),
    ) ?? []
  const busy = useWorkspaceStore((state) => state.pending > 0)
  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      if (task)
        await workspaceAction((api) =>
          api.updateTask({
            projectId: project.id,
            taskId: task.id,
            expectedRevision: task.revision,
            title,
            description,
            acceptanceCriteria: criteria,
            dependencyIds,
            requiredFiles: requiredFiles
              .split('\n')
              .map((path) => path.trim())
              .filter(Boolean),
          }),
        )
      else
        await workspaceAction((api) =>
          api.createTask({
            projectId: project.id,
            title,
            description,
            acceptanceCriteria: criteria,
            dependencyIds,
            requiredFiles: requiredFiles
              .split('\n')
              .map((path) => path.trim())
              .filter(Boolean),
            status,
          }),
        )
      onClose()
    } catch {
      setFailure(useAppStore.getState().error)
    }
  }
  return (
    <Modal
      title={task ? 'Edit task' : 'Create a task'}
      subtitle={`${project.name} / ${columns.find((column) => column.id === status)?.title}`}
      onClose={onClose}
      busy={busy}
    >
      <form className="workspace-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="task-title">
            Title<span>Required</span>
          </label>
          <input
            id="task-title"
            autoFocus
            required
            maxLength={180}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs to happen?"
          />
          <label htmlFor="task-description">Description</label>
          <textarea
            id="task-description"
            maxLength={30000}
            rows={5}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Give this task context: the problem, the goal, and any useful details."
          />
          <label htmlFor="task-criteria">Acceptance criteria</label>
          <textarea
            id="task-criteria"
            maxLength={20000}
            rows={4}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            placeholder="Describe what a successful result should look like."
          />
          <label>Depends on todos</label>
          <div className="task-dependencies">
            {prerequisites.length ? (
              prerequisites.map((other) => (
                <label key={other.id} className="dependency-choice">
                  <input
                    type="checkbox"
                    checked={dependencyIds.includes(other.id)}
                    onChange={(event) =>
                      setDependencyIds((ids) =>
                        event.target.checked
                          ? [...ids, other.id]
                          : ids.filter((id) => id !== other.id),
                      )
                    }
                  />
                  <span>
                    {other.title} ·{' '}
                    {snapshot?.workflows?.some(
                      (workflow) =>
                        workflow.taskId === other.id &&
                        workflow.integration === 'integrated' &&
                        workflow.phase === 'completed',
                    )
                      ? 'Integrated'
                      : 'Awaiting integration'}
                  </span>
                </label>
              ))
            ) : (
              <p className="form-helper">
                Create another todo to select a prerequisite.
              </p>
            )}
          </div>
          <p className="form-helper">
            This task waits until every prerequisite has been integrated. The
            project manager can also set these dependencies.
          </p>
          <label htmlFor="required-files">Required input files</label>
          <textarea
            id="required-files"
            rows={3}
            value={requiredFiles}
            onChange={(event) => setRequiredFiles(event.target.value)}
            placeholder="project_plan.md"
          />
          <p className="form-helper">
            One relative file path per line. A missing file blocks the agent
            before implementation starts.
          </p>
        </fieldset>
        {failure && <FormFailure failure={failure} />}
        <footer>
          {task && (
            <Link
              className="button secondary"
              to={`/projects/${project.id}/tasks/${task.id}/graph`}
            >
              <GitBranch size={13} />
              Open graph
            </Link>
          )}
          {task && (
            <button
              type="button"
              className="button subtle-danger"
              disabled={busy}
              onClick={() =>
                void onArchive(task).then(() =>
                  setFailure(useAppStore.getState().error),
                )
              }
            >
              <Archive size={13} />
              Archive task
            </button>
          )}
          <span />
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}
            {task ? 'Save changes' : 'Create task'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

function ProjectSettings({
  project,
  onClose,
}: {
  project: Project
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [failure, setFailure] = useState<Failure>()
  const [expectedRevision] = useState(project.revision)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [instructions, setInstructions] = useState(project.instructions)
  const [devCommand, setDevCommand] = useState(project.devCommand)
  const [testCommand, setTestCommand] = useState(project.testCommand)
  const [ideCommand, setIdeCommand] = useState(project.ideCommand ?? '')
  const [maxParallelAgents, setMaxParallelAgents] = useState(
    project.maxParallelAgents ?? 4,
  )
  const [defaultProvider, setDefaultProvider] = useState<'codex' | 'claude'>(
    project.defaultProvider ?? 'codex',
  )
  const [defaultModel, setDefaultModel] = useState(project.defaultModel ?? '')
  const [defaultEffort, setDefaultEffort] = useState<Effort | ''>(
    project.defaultEffort ?? '',
  )
  const busy = useWorkspaceStore((state) => state.pending > 0)
  async function deleteProject() {
    setFailure(undefined)
    try {
      const deleted = await workspaceAction((api) =>
        api.deleteProject({ projectId: project.id, expectedRevision }),
      )
      if (deleted) {
        onClose()
        navigate('/projects', { replace: true })
      }
    } catch {
      setFailure(useAppStore.getState().error)
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      await workspaceAction((api) =>
        api.updateProject({
          projectId: project.id,
          expectedRevision,
          name,
          description,
          instructions,
          devCommand,
          testCommand,
          ideCommand,
          maxParallelAgents,
          defaultProvider,
          defaultModel: defaultModel || null,
          defaultEffort: defaultEffort || null,
        }),
      )
      onClose()
    } catch {
      setFailure(useAppStore.getState().error)
    }
  }
  return (
    <Modal
      title="Project settings"
      subtitle="The shared brief for work in this repository."
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="workspace-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="project-name">
            Project name<span>Required</span>
          </label>
          <input
            id="project-name"
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label>Repository</label>
          <div className="settings-repository">
            <FolderGit2 size={15} />
            <code>{project.repoPath}</code>
          </div>
          <label htmlFor="ide-command">IDE command</label>
          <input
            id="ide-command"
            className="command-input"
            maxLength={2000}
            value={ideCommand}
            onChange={(event) => setIdeCommand(event.target.value)}
            placeholder="code --new-window"
          />
          <p className="form-helper">
            Use code, zed, or an executable path with optional arguments. Open
            in IDE appends the workspace path. Quote executable paths containing
            spaces.
          </p>
          <label htmlFor="parallel-agents">Maximum simultaneous agents</label>
          <input
            id="parallel-agents"
            type="number"
            min={1}
            max={8}
            required
            value={maxParallelAgents}
            onChange={(event) =>
              setMaxParallelAgents(Number(event.target.value))
            }
          />
          <label htmlFor="project-default-provider">
            Default agent provider
          </label>
          <select
            id="project-default-provider"
            value={defaultProvider}
            onChange={(event) => {
              setDefaultProvider(event.target.value as 'codex' | 'claude')
              setDefaultModel('')
              setDefaultEffort('')
            }}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code</option>
          </select>
          <p className="form-helper">
            New agent and manager terminals use this CLI. Existing terminals
            keep their provider. Install and sign in to the CLI on this
            computer.
          </p>
          <div className="command-fields">
            <div>
              <label htmlFor="project-default-model">Default model</label>
              <input
                id="project-default-model"
                value={defaultModel}
                maxLength={160}
                placeholder="Use the CLI’s configured default"
                onChange={(event) => {
                  setDefaultModel(event.target.value)
                  setDefaultEffort('')
                }}
              />
            </div>
            <div>
              <label htmlFor="project-default-effort">
                Default reasoning effort
              </label>
              <select
                id="project-default-effort"
                value={defaultEffort}
                disabled={!defaultModel}
                onChange={(event) =>
                  setDefaultEffort(event.target.value as Effort | '')
                }
              >
                <option value="">Use the CLI’s configured default</option>
                {effortSchema.options.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="form-helper">
            Node and profile overrides still apply. Model and effort support is
            validated by your chosen CLI.
          </p>
          <label htmlFor="project-description">Project brief</label>
          <textarea
            id="project-description"
            maxLength={20000}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does this project do? What matters most?"
          />
          <label htmlFor="project-instructions">Project instructions</label>
          <textarea
            id="project-instructions"
            maxLength={40000}
            rows={4}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Conventions, constraints, and context for future agents."
          />
          <div className="command-fields">
            <div>
              <label htmlFor="dev-command">Development command</label>
              <input
                id="dev-command"
                className="command-input"
                maxLength={2000}
                value={devCommand}
                onChange={(event) => setDevCommand(event.target.value)}
                placeholder="npm run dev"
              />
            </div>
            <div>
              <label htmlFor="test-command">Test command</label>
              <input
                id="test-command"
                className="command-input"
                maxLength={2000}
                value={testCommand}
                onChange={(event) => setTestCommand(event.target.value)}
                placeholder="npm test"
              />
            </div>
          </div>
          <p className="form-helper">
            Node runs use the development command as context and execute the
            test command in each agent workspace after successful turns and on
            combined results when needed. Saving settings does not run either
            command.
          </p>
        </fieldset>
        {failure && <FormFailure failure={failure} />}
        <footer>
          <button
            className="button subtle-danger"
            type="button"
            disabled={busy}
            onClick={() => void deleteProject()}
            title="Delete this project's saved app data. A confirmation dialog opens before deletion."
          >
            <Trash2 size={14} />
            Delete project
          </button>
          <span />
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}
            Save settings
          </button>
        </footer>
      </form>
    </Modal>
  )
}

function FormFailure({ failure }: { failure: Failure }) {
  return (
    <div className="form-error" role="alert">
      <strong>{failure.message}</strong>
      <p>{failure.hint}</p>
    </div>
  )
}
