import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  LoaderCircle,
  Play,
  RotateCcw,
  Square,
  TriangleAlert,
} from 'lucide-react'
import type { Failure } from '../../shared/contracts'
import type { NodeIdentity, StartNodeInput } from '../../shared/execution'
import type { GraphSnapshot, WorkflowNode } from '../../shared/graph'
import { workflowStatusLabel } from '../../shared/workflow'
import {
  executionAction,
  useExecutionSnapshot,
  workflowAction,
} from './execution-store'
import { useAppStore } from './store'
import { Modal } from './components/Modal'
import { TerminalPane } from './components/TerminalPane'
import { TaskIdeButton } from './TaskReview'

export const nodeStatus = (status?: string) =>
  status === 'completed'
    ? 'Result ready'
    : status === 'cancelled'
      ? 'Stopped'
      : status
        ? status[0].toUpperCase() + status.slice(1)
        : 'Not started'

export function NodeWorkspace({
  graph,
  node,
  runBlockers,
  onClose,
}: {
  graph: GraphSnapshot
  node: Extract<WorkflowNode, { type: 'agent' }>
  runBlockers: string[]
  onClose: () => void
}) {
  const identity: NodeIdentity = {
    projectId: graph.project.id,
    taskId: graph.task.id,
    nodeId: node.id,
  }
  const { snapshot, loading, refresh } = useExecutionSnapshot(
    identity,
    (api) => api.get(identity),
    node.id,
  )
  const [message, setMessage] = useState('')
  const [revising, setRevising] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const runs = snapshot?.runs ?? [],
    last = runs.at(-1)
  const workflow = snapshot?.workflow,
    workflowNode = workflow?.nodes[node.id]
  const blockedParents = workflow
    ? graph.document.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => workflow.nodes[edge.source])
        .filter(
          (parent) =>
            parent &&
            !(parent.status === 'completed' && parent.acceptanceId) &&
            !(parent.type === 'start' && !workflow.startedAt),
        )
    : []
  const reasons = [
    ...runBlockers,
    ...(workflow?.summary.blockers.filter((message) =>
      message.startsWith('Waiting for “'),
    ) ?? []),
    ...(blockedParents.length
      ? [
          `Waiting for accepted predecessors: ${blockedParents.map((parent) => `${parent.title} (${workflowStatusLabel[parent.status]})`).join(', ')}.`,
        ]
      : []),
    ...(workflow?.phase === 'archived'
      ? ['Restore this archived task before running it.']
      : []),
    ...(workflow?.phase === 'integrating'
      ? ['Wait for branch integration to finish.']
      : []),
  ]
  const ownActive =
    snapshot?.active?.nodeId === node.id &&
    snapshot.active.taskId === graph.task.id
  const blocked =
    pending ||
    !!snapshot?.active ||
    reasons.length > 0 ||
    !!snapshot?.persistenceError
  const terminalId = snapshot?.threadId?.startsWith('terminal:')
    ? snapshot.threadId.slice(9)
    : undefined
  const status = ownActive
    ? nodeStatus(snapshot?.active?.status)
    : workflow?.startedAt && workflowNode
      ? workflowStatusLabel[workflowNode.status]
      : nodeStatus(last?.status)
  const currentFailure =
    failure ??
    snapshot?.persistenceError ??
    (last?.status === 'failed'
      ? (last.error ?? last.inspectionError)
      : undefined)

  async function act(action: () => Promise<unknown>) {
    setPending(true)
    setFailure(undefined)
    useAppStore.getState().setError(undefined)
    try {
      await action()
      if (alive.current) await refresh()
    } catch (error) {
      if (alive.current)
        setFailure(
          useAppStore.getState().error ?? {
            code: 'NODE_EXECUTION',
            message: String(error),
            hint: 'Retry or request a revision.',
          },
        )
    } finally {
      if (alive.current) setPending(false)
    }
  }
  async function start(mode: StartNodeInput['mode']) {
    await act(async () => {
      await executionAction((api) =>
        api.start({
          ...identity,
          expectedGraphRevision: graph.revision,
          mode,
          ...(mode === 'followup' ? { message } : {}),
        }),
      )
      if (alive.current) {
        setMessage('')
        setRevising(false)
      }
    })
  }
  const controls = (
    <>
      <TaskIdeButton identity={identity} label="Open agent workspace in IDE" />
      {workflow &&
        workflowNode?.status === 'awaiting-acceptance' &&
        last?.id === workflowNode.runId && (
          <button
            className="button primary accept-node"
            disabled={
              pending || reasons.length > 0 || !!snapshot?.persistenceError
            }
            onClick={() =>
              void act(() =>
                workflowAction((api) =>
                  api.accept({
                    ...identity,
                    runId: workflowNode.runId!,
                    expectedRevision: workflow.revision,
                  }),
                ),
              )
            }
          >
            Accept latest result
          </button>
        )}
      {ownActive ? (
        <button
          className="button stop"
          disabled={pending || snapshot?.active?.status === 'stopping'}
          onClick={() =>
            void act(() => executionAction((api) => api.stop(identity)))
          }
        >
          <Square size={12} />
          Stop
        </button>
      ) : !last ? (
        <button
          className="button primary"
          disabled={blocked || loading}
          onClick={() => void start('run')}
        >
          <Play size={13} />
          Run node
        </button>
      ) : (
        <>
          {['failed', 'cancelled', 'interrupted'].includes(last.status) && (
            <button
              className="button primary"
              disabled={blocked}
              onClick={() => void start('retry')}
            >
              <RotateCcw size={13} />
              Retry last attempt
            </button>
          )}
          {snapshot?.threadId && (
            <button
              className="button secondary"
              disabled={blocked}
              aria-expanded={revising}
              onClick={() => setRevising((value) => !value)}
            >
              {revising ? 'Cancel revision' : 'Request revision'}
            </button>
          )}
          <details className="node-session-menu">
            <summary>Session</summary>
            <button
              className="button secondary"
              disabled={blocked}
              onClick={() => void start('restart')}
            >
              <Bot size={13} />
              New conversation
            </button>
          </details>
        </>
      )}
    </>
  )
  return (
    <Modal
      title={node.data.title || 'Agent task'}
      subtitle={`${graph.project.name} / ${graph.task.title}`}
      onClose={onClose}
      wide
      className="node-workspace"
    >
      {!terminalId && (
        <div className="node-workspace-bar">
          <div>
            <span className={`status-dot ${ownActive ? 'green pulse' : ''}`} />
            <strong>{status}</strong>
          </div>
          <div>{controls}</div>
        </div>
      )}
      {currentFailure && (
        <div
          className="node-latest-failure"
          role="alert"
          aria-label="Latest attempt failure"
        >
          <TriangleAlert size={16} aria-hidden="true" />
          <div>
            <strong>{currentFailure.message}</strong>
            <p>{currentFailure.hint}</p>
          </div>
        </div>
      )}
      {reasons.length > 0 && (
        <div
          className="node-run-blockers"
          role="status"
          aria-label="Why this node cannot run"
        >
          <span>{reasons.join(' ')}</span>
          <button className="button secondary" onClick={onClose}>
            Back to graph
          </button>
        </div>
      )}
      <div className="node-workspace-content">
        {terminalId ? (
          <TerminalPane
            sessionId={terminalId}
            disabled={!ownActive || snapshot?.active?.status !== 'running'}
            toolbarActions={controls}
            statusLabel={status}
            showCaption={false}
            showCloseControl={false}
          />
        ) : (
          <div className="node-chat">
            {loading ? (
              <div className="node-empty">
                <LoaderCircle className="spin" size={22} />
                Loading terminal…
              </div>
            ) : !runs.length ? (
              <div className="node-empty">
                <Bot size={28} />
                <h3>Ready to start</h3>
                <p>{node.data.prompt}</p>
              </div>
            ) : (
              runs.map((run, index) => (
                <section className="node-turn" key={run.id}>
                  <header>
                    Attempt {index + 1}
                    <span>{nodeStatus(run.status)}</span>
                  </header>
                  <div className="node-user-message">
                    <strong>You</strong>
                    <p>{run.prompt}</p>
                  </div>
                  {run.items
                    .filter((item) => item.type === 'agent_message')
                    .map((item) => (
                      <div className="node-agent-message" key={item.id}>
                        <strong>Agent</strong>
                        <p>{item.text}</p>
                      </div>
                    ))}
                  {ownActive && run.id === last?.id && (
                    <p className="node-preparing">
                      <LoaderCircle size={14} className="spin" />
                      {status}…
                    </p>
                  )}
                </section>
              ))
            )}
          </div>
        )}
      </div>
      {revising && !ownActive && (
        <footer className="node-workspace-footer">
          <form
            className="node-composer"
            onSubmit={(event) => {
              event.preventDefault()
              if (message.trim() && !blocked && snapshot?.threadId)
                void start('followup')
            }}
          >
            <label className="sr-only" htmlFor="node-followup">
              Request a revision
            </label>
            <textarea
              id="node-followup"
              rows={2}
              autoFocus
              placeholder="What should the agent change?"
              maxLength={32000}
              value={message}
              disabled={blocked || !snapshot?.threadId}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <button
              className="send-button"
              disabled={blocked || !message.trim() || !snapshot?.threadId}
              aria-label="Send node follow-up"
            >
              <ArrowUp size={16} />
            </button>
          </form>
        </footer>
      )}
    </Modal>
  )
}
