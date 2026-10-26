import { useEffect, useState } from 'react'
import {
  Copy,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { GraphIdentity } from '../../shared/graph'
import type { TaskReviewContext } from '../../shared/execution'
import { executionAction } from './execution-store'
import { Modal } from './components/Modal'

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
        title={
          available
            ? 'Open and run the task code before approving or integrating it.'
            : 'Run an agent node first to create the task branch.'
        }
        onClick={() => setOpen(true)}
      >
        <FolderOpen size={14} />
        Review task
      </button>
      {open && (
        <TaskReviewDialog identity={identity} onClose={() => setOpen(false)} />
      )}
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
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setContext(undefined)
    setError('')
    void executionAction((api) => {
      if (!api.getReview)
        throw new Error('Restart the desktop app to load task review controls.')
      return api.getReview(identity)
    })
      .then((context) => {
        if (alive) setContext(context)
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [identity.projectId, identity.taskId, refresh])
  async function act(action: () => Promise<unknown>, message?: string) {
    setPending(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (message) setNotice(message)
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      title="Review task"
      subtitle={
        context?.taskTitle ?? 'Inspect the task code before approving it.'
      }
      onClose={onClose}
      busy={pending}
      wide
      className="task-review-dialog"
    >
      <div className="task-review-content">
        <p>
          Use your existing project directory and IDE window. Select this task’s
          branch in your IDE, or switch to it below, then run the product as
          usual.
        </p>
        {loading ? (
          <p>
            <LoaderCircle size={14} className="spin" /> Loading task branch…
          </p>
        ) : (
          context && (
            <>
              <dl>
                <dt>Task branch</dt>
                <dd>
                  <code>{context.branch}</code>
                </dd>
                <dt>Current branch</dt>
                <dd>{context.projectBranch ?? 'Detached checkout'}</dd>
                <dt>Merge into</dt>
                <dd>{context.targetBranch ?? 'Base branch unavailable'}</dd>
                <dt>Project directory</dt>
                <dd>
                  <code>{context.projectPath}</code>
                </dd>
              </dl>
              {context.active && (
                <p className="task-review-notice">
                  An agent is still working in this project. Wait for it to
                  finish before making your review decision.
                </p>
              )}
              <div className="task-review-actions">
                <button
                  className="button primary"
                  disabled={
                    pending ||
                    context.active ||
                    context.projectBranch === context.branch
                  }
                  onClick={() =>
                    void act(async () => {
                      await executionAction((api) => api.checkoutTask(identity))
                      setRefresh((value) => value + 1)
                    })
                  }
                >
                  <GitBranch size={14} />
                  {context.projectBranch === context.branch
                    ? 'Task branch selected'
                    : 'Switch to task branch'}
                </button>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () => navigator.clipboard.writeText(context.branch),
                      'Branch name copied.',
                    )
                  }
                >
                  <Copy size={13} />
                  Copy branch name
                </button>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() =>
                    void act(() =>
                      executionAction((api) => api.openWorktree(identity)),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  Open project folder
                </button>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () => navigator.clipboard.writeText(context.path),
                      'Project directory copied.',
                    )
                  }
                >
                  <Copy size={13} />
                  Copy project path
                </button>
              </div>
              <h3>Run the product</h3>
              {context.runCommand ? (
                <>
                  <p>
                    Paste this command into a terminal to select the task branch
                    and run the project. You can also select the branch in your
                    IDE.
                  </p>
                  <pre className="task-review-command">
                    {context.runCommand}
                  </pre>
                  <button
                    className="button secondary"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        () =>
                          navigator.clipboard.writeText(context.runCommand!),
                        'Run command copied.',
                      )
                    }
                  >
                    <Copy size={13} />
                    Copy run command
                  </button>
                </>
              ) : (
                <p>
                  No development command is configured. Set it in Project
                  settings, or select the task branch and run the project using
                  your usual commands.
                </p>
              )}
              <p className="task-review-next">
                After testing the product, approve the human review or request
                changes. When the workflow is complete, use Integrate branch to
                merge the accepted work into{' '}
                {context.targetBranch ?? 'the base branch'}. The app then leaves
                your project directory on that branch.
              </p>
            </>
          )
        )}
        {error && (
          <p className="integration-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="task-review-notice" role="status">
            {notice}
          </p>
        )}
        <button
          className="button secondary"
          disabled={loading || pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
          Refresh branch details
        </button>
      </div>
    </Modal>
  )
}
