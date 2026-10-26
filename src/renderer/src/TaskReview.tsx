import { useEffect, useState } from 'react'
import { Copy, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react'
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
            : 'Run an agent node first to create the task folder.'
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
          Open this task folder in your IDE or terminal and run the app there.
          It is already checked out on the task branch, so your main project
          folder can stay on its current branch.
        </p>
        {loading ? (
          <p>
            <LoaderCircle size={14} className="spin" /> Loading task folder…
          </p>
        ) : (
          context && (
            <>
              <dl>
                <dt>Task branch</dt>
                <dd>
                  <code>{context.branch}</code>
                </dd>
                <dt>Task folder</dt>
                <dd>
                  <code>{context.path}</code>
                </dd>
                <dt>Project branch</dt>
                <dd>{context.projectBranch ?? 'Detached checkout'}</dd>
                <dt>Project folder</dt>
                <dd>
                  <code>{context.projectPath}</code>
                </dd>
              </dl>
              {context.active && (
                <p className="task-review-notice">
                  An agent is still working in this folder. Wait for it to
                  finish before making your review decision.
                </p>
              )}
              <div className="task-review-actions">
                <button
                  className="button primary"
                  disabled={pending}
                  onClick={() =>
                    void act(() =>
                      executionAction((api) => api.openWorktree(identity)),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  Open task folder
                </button>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () => navigator.clipboard.writeText(context.path),
                      'Task folder path copied.',
                    )
                  }
                >
                  <Copy size={13} />
                  Copy folder path
                </button>
              </div>
              <h3>Run the product</h3>
              {context.runCommand ? (
                <>
                  <p>
                    Paste this command into a terminal. Prepare dependencies in
                    this task folder if needed.
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
                  settings, or run the project from this task folder using your
                  usual commands.
                </p>
              )}
              <p className="task-review-next">
                After testing the product, approve the human review or request
                changes. When the workflow is complete, use Integrate branch to
                bring the accepted work into{' '}
                {context.projectBranch ?? 'your project branch'} and the project
                folder.
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
          Refresh folder details
        </button>
      </div>
    </Modal>
  )
}
