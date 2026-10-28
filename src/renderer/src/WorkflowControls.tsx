import { useState } from 'react'
import {
  Check,
  GitMerge,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import type { GraphIdentity } from '../../shared/graph'
import type { IntegrationPlan, WorkflowSnapshot } from '../../shared/workflow'
import { workflowStatusLabel } from '../../shared/workflow'
import { workflowAction } from './execution-store'
import { useAppStore } from './store'
import { Modal } from './components/Modal'
import { TaskIdeButton, TaskReviewButton } from './TaskReview'

export function WorkflowControls({
  workflow,
  graphRevision,
  blocked,
  onInspect,
  worktreeReady = false,
}: {
  workflow?: WorkflowSnapshot
  graphRevision: number
  blocked: boolean
  onInspect: (id: string) => void
  worktreeReady?: boolean
}) {
  const [pending, setPending] = useState(false),
    [integrationOpen, setIntegrationOpen] = useState(false)
  async function act(action: () => Promise<unknown>) {
    setPending(true)
    useAppStore.getState().setError(undefined)
    try {
      await action()
    } catch {
      /* The shared failure notice includes the actual blocker. */
    } finally {
      setPending(false)
    }
  }
  if (!workflow)
    return (
      <div className="workflow-controls">
        <LoaderCircle size={14} className="spin" />
        Loading workflow…
      </div>
    )
  const identity = { projectId: workflow.projectId, taskId: workflow.taskId },
    issue = Object.values(workflow.nodes).find((node) =>
      ['failed', 'stopped', 'interrupted'].includes(node.status),
    )
  const waiting = Object.values(workflow.nodes).find((node) =>
    ['awaiting-acceptance', 'waiting-review'].includes(node.status),
  )
  const paused = ['paused', 'blocked'].includes(workflow.phase)
  const manual = workflow.scheduling === 'manual'
  const active =
    workflow.phase === 'running' || (workflow.phase === 'waiting' && !manual)
  return (
    <>
      <section
        className={`workflow-controls phase-${workflow.phase}`}
        aria-label="Workflow progression"
      >
        <div className="workflow-progress">
          <strong>
            {workflow.phase === 'idle'
              ? 'Workflow ready to start'
              : workflow.phase === 'completed'
                ? workflow.integration?.status === 'integrated'
                  ? 'Integrated'
                  : 'Awaiting integration'
              : workflow.phase === 'waiting'
                ? waiting?.status === 'waiting-review'
                  ? 'Waiting for human review'
                  : waiting
                    ? 'Waiting for acceptance'
                    : 'Choose a ready node'
                : workflow.phase[0].toUpperCase() + workflow.phase.slice(1)}
          </strong>
          <span>
            {workflow.summary.accepted} / {workflow.summary.total} required
            nodes accepted
          </span>
          <div>
            <i
              style={{
                transform: `scaleX(${workflow.summary.total ? workflow.summary.accepted / workflow.summary.total : 0})`,
              }}
            />
          </div>
        </div>
        <div className="workflow-control-actions">
          <TaskIdeButton identity={identity} />
          <TaskReviewButton identity={identity} available={worktreeReady} />
          {issue ? (
            <button
              className="button secondary"
              onClick={() => onInspect(issue.id)}
            >
              <TriangleAlert size={13} />
              Inspect {issue.title}
            </button>
          ) : (
            waiting && (
              <button
                className="button secondary"
                onClick={() => onInspect(waiting.id)}
              >
                <UserRound size={13} />
                {waiting.status === 'waiting-review'
                  ? 'Open review'
                  : 'Inspect result'}
              </button>
            )
          )}
          {workflow.phase === 'completed' && workflow.completionSnapshot && (
            <button
              className="button primary"
              disabled={pending || blocked}
              onClick={() => setIntegrationOpen(true)}
            >
              <GitMerge size={14} />
              {workflow.integration?.status === 'integrated'
                ? 'Integration receipt'
                : 'Integrate branch'}
            </button>
          )}
          {active ? (
            <button
              className="button secondary"
              disabled={pending}
              onClick={() =>
                void act(() => workflowAction((api) => api.pause(identity)))
              }
            >
              {pending ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Pause size={13} />
              )}
              Pause & edit
            </button>
          ) : (
            (['idle', 'paused', 'blocked'].includes(workflow.phase) ||
              (manual && workflow.phase === 'waiting')) && (
              <button
                className="button primary"
                disabled={pending || blocked || !!issue}
                onClick={() =>
                  void act(() =>
                    workflowAction((api) =>
                      api.start({
                        ...identity,
                        expectedGraphRevision: graphRevision,
                      }),
                    ),
                  )
                }
              >
                {pending ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Play size={13} />
                )}
                {paused
                  ? 'Resume workflow'
                  : manual
                    ? 'Run workflow'
                    : 'Start workflow'}
              </button>
            )
          )}
        </div>
        {workflow.phase === 'idle' && !worktreeReady && (
          <p className="workflow-integration-hint">
            New tasks start from the base branch. If this task needs files from
            another completed task, integrate that task’s branch first.
          </p>
        )}
        {workflow.phase === 'completed' && (
          <p className="workflow-integration-hint">
            {workflow.integration?.status === 'integrated'
              ? 'Accepted work has been merged into the base branch.'
              : 'Work accepted in the task workspace. Use Integrate branch to merge it into the base branch and move this task to Done and release dependent todos.'}
          </p>
        )}
        {workflow.summary.blockers.filter((message) => message.startsWith('Waiting for “')).map((message) => <p className="workflow-blocker" key={message}>{message}</p>)}
        {(workflow.error || issue || workflow.phase === 'paused') && (
          <p className="workflow-blocker">
            {workflow.error?.message ??
              (issue
                ? `${issue.title}: ${issue.reason ?? workflowStatusLabel[issue.status]}. Open the node to retry or request a revision.`
                : 'Scheduling is paused. Save your edits, then resume explicitly.')}
          </p>
        )}
        {workflow.integration &&
          ['conflicts', 'blocked', 'failed', 'interrupted'].includes(
            workflow.integration.status,
          ) && (
            <p className="workflow-blocker">
              Integration: {workflow.integration.message}
            </p>
          )}
      </section>
      {integrationOpen && (
        <IntegrationDialog
          workflow={workflow}
          onClose={() => setIntegrationOpen(false)}
        />
      )}
    </>
  )
}

export function ReviewPanel({
  workflow,
  nodeId,
  onInspect,
  disabled = false,
  worktreeReady = false,
}: {
  workflow: WorkflowSnapshot
  nodeId: string
  onInspect: (id: string) => void
  disabled?: boolean
  worktreeReady?: boolean
}) {
  const [note, setNote] = useState(''),
    [target, setTarget] = useState(''),
    [pending, setPending] = useState(false)
  const node = workflow.nodes[nodeId],
    evidence = workflow.evidence[nodeId] ?? []
  const manual = workflow.scheduling === 'manual'
  async function decide(decision: 'approve' | 'changes') {
    setPending(true)
    useAppStore.getState().setError(undefined)
    try {
      await workflowAction((api) =>
        api.review({
          projectId: workflow.projectId,
          taskId: workflow.taskId,
          nodeId,
          expectedRevision: workflow.revision,
          decision,
          note,
          ...(decision === 'changes' ? { targetNodeId: target } : {}),
        }),
      )
      if (decision === 'changes') setNote('')
    } catch {
      /* Shared notice keeps stale decisions and scope failures visible. */
    } finally {
      setPending(false)
    }
  }
  if (!node) return null
  return (
    <section className={`workflow-review state-${node.status}`} aria-label="Human review decision">
      <header>
        <UserRound size={17} />
        <strong>{workflowStatusLabel[node.status]}</strong>
      </header>
      <p>
        {node.status === 'completed'
          ? 'You approved this review. A new upstream revision will invalidate this approval.'
          : node.status === 'waiting-review'
            ? 'Inspect the accepted upstream results, then approve or request a revision. This gate always waits for your decision.'
            : 'Every upstream dependency must complete and be accepted before this review can be decided.'}
      </p>
      <TaskReviewButton
        identity={{ projectId: workflow.projectId, taskId: workflow.taskId }}
        available={worktreeReady}
      />
      {evidence.map((result) => (
        <details key={result.nodeId}>
          <summary>
            {result.title}
            <small>
              {workflowStatusLabel[
                result.status as keyof typeof workflowStatusLabel
              ] ?? result.status}
            </small>
          </summary>
          <p>Checks: {result.checks}</p>
          <pre>{result.summary || 'No assistant summary recorded.'}</pre>
          <button
            className="button secondary"
            onClick={() => onInspect(result.nodeId)}
          >
            Inspect conversation & diffs
          </button>
        </details>
      ))}
      {node.status === 'waiting-review' && (
        <fieldset disabled={pending || disabled}>
          <label htmlFor="review-note">Review note / requested changes</label>
          <textarea
            id="review-note"
            rows={4}
            maxLength={8000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Describe what needs to change, or add an approval note."
          />
          <label htmlFor="review-target">Agent to revise</label>
          <select
            id="review-target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Choose an upstream agent…</option>
            {evidence
              .filter((result) => result.status === 'completed')
              .map((result) => (
                <option key={result.nodeId} value={result.nodeId}>
                  {result.title}
                </option>
              ))}
          </select>
          <p className="helper">
            {manual
              ? "Request changes continues this agent's conversation. Run affected downstream nodes individually or choose Run workflow afterward."
              : "Request changes continues this agent's conversation, reruns affected downstream nodes, and returns to this review."}
          </p>
          <button
            className="button primary"
            onClick={() => void decide('approve')}
          >
            <Check size={13} />
            Approve review
          </button>
          <button
            className="button secondary"
            disabled={!target || !note.trim() || pending}
            onClick={() => void decide('changes')}
          >
            Request changes & revise
          </button>
        </fieldset>
      )}
    </section>
  )
}

function IntegrationDialog({
  workflow,
  onClose,
}: {
  workflow: WorkflowSnapshot
  onClose: () => void
}) {
  const [plan, setPlan] = useState<IntegrationPlan | undefined>(
    workflow.integration?.status === 'integrated'
      ? workflow.integration
      : undefined,
  )
  const [pending, setPending] = useState(false),
    [error, setError] = useState('')
  const identity: GraphIdentity = {
    projectId: workflow.projectId,
    taskId: workflow.taskId,
  }
  async function preview() {
    setPending(true)
    setError('')
    try {
      const fresh = await workflowAction((api) => api.get(identity))
      setPlan(
        await workflowAction((api) =>
          api.previewIntegration({
            ...identity,
            expectedRevision: fresh.revision,
          }),
        ),
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  async function apply() {
    if (!plan?.targetBranch || plan.status !== 'ready') return
    setPending(true)
    setError('')
    try {
      setPlan(
        await workflowAction((api) =>
          api.integrate({
            ...identity,
            expectedRevision: plan.workflowRevision,
            targetBranch: plan.targetBranch!,
            targetHead: plan.targetHead,
          }),
        ),
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      title="Integrate task branch"
      subtitle="Preview the accepted snapshot against your project branch."
      onClose={onClose}
      busy={pending}
      wide
      className="integration-dialog"
    >
      <div className="integration-content">
        <p>
          Integration merges the accepted task result into its saved base branch
          and selects that branch in your project directory. The task branch
          stays available in your IDE.
        </p>
        <button
          className="button secondary"
          disabled={pending || plan?.status === 'integrated'}
          onClick={() => void preview()}
        >
          {pending ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Preview integration
        </button>
        {error && (
          <p className="integration-error" role="alert">
            {error}
          </p>
        )}
        {plan && (
          <div className={`integration-plan ${plan.status}`} role="status">
            <strong>
              {plan.status === 'ready'
                ? 'Ready to integrate'
                : plan.status[0].toUpperCase() + plan.status.slice(1)}
            </strong>
            <p>{plan.message}</p>
            <dl>
              <dt>Target branch</dt>
              <dd>{plan.targetBranch ?? 'No named branch checked out'}</dd>
              <dt>Current commit</dt>
              <dd>{plan.targetHead ?? 'No commits yet'}</dd>
              {plan.commit && (
                <>
                  <dt>Integrated commit</dt>
                  <dd>{plan.commit}</dd>
                </>
              )}
            </dl>
            {plan.conflicts.length > 0 && (
              <>
                <h3>Conflicting paths</h3>
                <ul>
                  {plan.conflicts.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {plan.status === 'ready' && (
              <button
                className="button primary"
                disabled={pending}
                onClick={() => void apply()}
              >
                <GitMerge size={14} />
                Integrate into {plan.targetBranch}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
