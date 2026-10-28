import { useEffect, useState } from 'react'
import { CodeXml, Copy, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react'
import type { GraphIdentity } from '../../shared/graph'
import type { TaskReviewContext } from '../../shared/execution'
import { executionAction } from './execution-store'
import { workspaceAction } from './workspace-store'
import { Modal } from './components/Modal'

export function TaskIdeButton({
  identity,
  iconOnly = false,
  label = 'Open task workspace in IDE',
}: {
  identity: GraphIdentity & { nodeId?: string }
  iconOnly?: boolean
  label?: string
}) {
  return (
    <IdeButton
      onOpen={() => executionAction((api) => api.openInIde(identity))}
      iconOnly={iconOnly}
      label={label}
      title="Open this workspace using the IDE command in Project settings"
    />
  )
}

export function ProjectIdeButton({ projectId }: { projectId: string }) {
  return (
    <IdeButton
      onOpen={() => workspaceAction((api) => api.openInIde({ projectId }))}
      label="Open project in IDE"
      title="Open the original project folder in your IDE"
    />
  )
}

function IdeButton({ onOpen, iconOnly = false, label, title }: {
  onOpen: () => Promise<unknown>
  iconOnly?: boolean
  label: string
  title: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function open() {
    setPending(true)
    setError('')
    try {
      await onOpen()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <button
        className={iconOnly ? 'icon-button' : 'button secondary'}
        disabled={pending}
        aria-label={label}
        title={error || title}
        onClick={() => void open()}
      >
        {pending ? (
          <LoaderCircle size={13} className="spin" />
        ) : (
          <CodeXml size={iconOnly ? 14 : 13} />
        )}
        {!iconOnly && 'Open in IDE'}
      </button>
      {error && !iconOnly && <small className="integration-error" role="alert">{error}</small>}
    </>
  )
}

export function TaskReviewButton({
  identity,
  available,
}: {
  identity: GraphIdentity
  available: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="button secondary"
        disabled={!available}
        onClick={() => setOpen(true)}
        title="Inspect the combined task workspace before review or integration"
      >
        <FolderOpen size={14} /> Review task
      </button>
      {open && <TaskReviewDialog identity={identity} onClose={() => setOpen(false)} />}
    </>
  )
}

function TaskReviewDialog({
  identity,
  onClose,
}: {
  identity: GraphIdentity
  onClose: () => void
}) {
  const [context, setContext] = useState<TaskReviewContext>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let alive = true
    setError('')
    void executionAction((api) => api.getReview(identity))
      .then((value) => { if (alive) setContext(value) })
      .catch((error) => { if (alive) setError(String(error)) })
    return () => { alive = false }
  }, [identity.projectId, identity.taskId, refresh])
  async function act(action: () => Promise<unknown>) {
    setPending(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      title="Review task"
      subtitle={context?.taskTitle ?? 'Inspect the combined agent results.'}
      onClose={onClose}
      busy={pending}
      wide
      className="task-review-dialog"
    >
      <div className="task-review-content">
        <p>
          This task has its own workspace. Open it in your IDE to inspect and run
          the combined agent results. Your original project folder stays on its
          current branch until integration.
        </p>
        {!context ? (
          <p><LoaderCircle size={14} className="spin" /> Loading workspace…</p>
        ) : (
          <>
            <dl>
              <dt>Task branch</dt><dd><code>{context.branch}</code></dd>
              <dt>Merge into</dt><dd>{context.targetBranch ?? 'Base branch unavailable'}</dd>
              <dt>Task workspace</dt><dd><code>{context.path}</code></dd>
              <dt>Original project</dt>
              <dd><code>{context.projectPath}</code> · {context.projectBranch}</dd>
            </dl>
            {context.active && (
              <p className="task-review-notice">
                Agents are working on this task. Wait for their results before
                reviewing the combined code.
              </p>
            )}
            <div className="task-review-actions">
              <TaskIdeButton identity={identity} />
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => void act(() => executionAction((api) => api.openWorktree(identity)))}
              >
                <FolderOpen size={13} /> Open task folder
              </button>
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => void act(() => navigator.clipboard.writeText(context.path))}
              >
                <Copy size={13} /> Copy workspace path
              </button>
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => void act(() => navigator.clipboard.writeText(context.branch))}
              >
                <Copy size={13} /> Copy branch name
              </button>
            </div>
            <h3>Run the product</h3>
            {context.runCommand ? (
              <>
                <pre className="task-review-command">{context.runCommand}</pre>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() => void act(() => navigator.clipboard.writeText(context.runCommand!))}
                >
                  <Copy size={13} /> Copy run command
                </button>
              </>
            ) : (
              <p>Set a development command in Project settings, or run your usual commands in this workspace.</p>
            )}
            <p>
              Worktrees start with committed files. Install dependencies and
              configure local environment files in this workspace as needed.
            </p>
            <p className="task-review-next">
              After review, use Integrate branch to merge accepted work into{' '}
              {context.targetBranch ?? 'the base branch'}. The task stays Doing
              until integration succeeds, then moves to Done and releases
              dependent todos.
            </p>
          </>
        )}
        {error && <p className="integration-error" role="alert">{error}</p>}
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} /> Refresh workspace details
        </button>
      </div>
    </Modal>
  )
}
