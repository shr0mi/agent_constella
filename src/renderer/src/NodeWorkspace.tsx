import { TaskIdeButton } from './TaskReview'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowUp,
  Bot,
  FileDiff as FileDiffIcon,
  GitBranch,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import type { Failure } from '../../shared/contracts'
import type {
  FileDiff,
  NodeIdentity,
  NodeRun,
  StartNodeInput,
} from '../../shared/execution'
import { isActiveNodeRun } from '../../shared/execution'
import type { GraphSnapshot, WorkflowNode } from '../../shared/graph'
import {
  executionAction,
  useExecutionSnapshot,
  workflowAction,
} from './execution-store'
import { workflowStatusLabel } from '../../shared/workflow'
import { useAppStore } from './store'
import { Modal } from './components/Modal'

const NodeDiff = lazy(() => import('./components/NodeDiff'))
export const nodeStatus = (status?: string) =>
  status === 'completed'
    ? 'Result ready'
    : status === 'cancelled'
      ? 'Stopped'
      : status
        ? status[0].toUpperCase() + status.slice(1)
        : 'Not started'
function FailureCard({ failure }: { failure: Failure }) {
  return (
    <div className="node-failure" role="alert">
      <TriangleAlert size={15} />
      <div>
        <strong>{failure.code.replaceAll('_', ' ')}</strong>
        <pre>{failure.message}</pre>
        <p>{failure.hint}</p>
      </div>
    </div>
  )
}

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
  const [tab, setTab] = useState<
    'conversation' | 'activity' | 'files' | 'tests' | 'snapshot'
  >('conversation')
  const [message, setMessage] = useState(''),
    [pending, setPending] = useState(false),
    [failure, setFailure] = useState<Failure>()
  const [attemptId, setAttemptId] = useState(''),
    [file, setFile] = useState(''),
    [diff, setDiff] = useState<FileDiff>(),
    [diffLoading, setDiffLoading] = useState(false)
  const runs = snapshot?.runs ?? [],
    last = runs.at(-1)
  const selected = runs.find((run) => run.id === attemptId) ?? last
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
    ...(workflow?.summary.blockers.filter((message) => message.startsWith('Waiting for “')) ?? []),
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
  const end = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (follow.current && tab === 'conversation')
      end.current?.scrollIntoView({ block: 'end' })
  }, [
    last?.items.length,
    last?.items.map((item) => item.text.length).join(','),
    last?.status,
    tab,
  ])
  useEffect(() => {
    setFile('')
    setDiff(undefined)
  }, [selected?.id])
  useEffect(() => {
    let alive = true
    if (!file || !selected) {
      setDiff(undefined)
      return
    }
    setDiffLoading(true)
    setDiff(undefined)
    void executionAction((api) =>
      api.getDiff({ ...identity, runId: selected.id, path: file }),
    )
      .then((diff) => {
        if (alive) setDiff(diff)
      })
      .catch(() => {
        if (alive) setFailure(useAppStore.getState().error)
      })
      .finally(() => {
        if (alive) setDiffLoading(false)
      })
    return () => {
      alive = false
    }
  }, [file, selected?.id])
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
            hint: 'Inspect this attempt and retry explicitly.',
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
        setAttemptId('')
        setTab('conversation')
        follow.current = true
      }
    })
  }
  return (
    <Modal
      title={node.data.title || 'Agent task'}
      subtitle={`${graph.project.name} / ${graph.task.title}`}
      onClose={onClose}
      wide
      className="node-workspace"
    >
      <div className="node-workspace-bar">
        <div>
          <span className={`status-dot ${ownActive ? 'green pulse' : ''}`} />
          <strong>
            {ownActive
              ? nodeStatus(snapshot?.active?.status)
              : workflow?.startedAt && workflowNode
                ? workflowStatusLabel[workflowNode.status]
                : nodeStatus(last?.status)}
          </strong>
          <span>
            {snapshot?.threadId
              ? `Thread ${snapshot.threadId.slice(0, 12)}…`
              : 'New Codex conversation'}
          </span>
        </div>
        <div>
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
              <button
                className="button secondary"
                disabled={blocked}
                title="Starts a fresh thread using current saved node settings. Existing code and attempt history are retained."
                onClick={() => void start('restart')}
              >
                <PlusConversation />
                New conversation
              </button>
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
            </>
          )}
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => void refresh()}
            aria-label="Refresh node execution"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="node-context-note">
        Run controls execute only this node. All prerequisites must be completed
        and accepted. Use Run workflow on the graph to schedule ready nodes
        automatically.
      </div>
      {graph.project.testCommand.trim() && (
        <div className="node-context-note">
          Checks after each successful turn:{' '}
          <code>{graph.project.testCommand}</code>
        </div>
      )}
      {failure && <FailureCard failure={failure} />}
      {snapshot?.persistenceError && (
        <FailureCard failure={snapshot.persistenceError} />
      )}
      {reasons.length > 0 && (
        <div
          className="node-context-note node-run-blockers"
          role="status"
          aria-label="Why this node cannot run"
        >
          <strong>Before running this node</strong>
          <ul>
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          <button className="button secondary" onClick={onClose}>
            Back to graph
          </button>
        </div>
      )}
      <div className="node-tabs">
        {(
          ['conversation', 'activity', 'files', 'tests', 'snapshot'] as const
        ).map((tabName) => (
          <button
            key={tabName}
            className={tabName === tab ? 'selected' : ''}
            onClick={() => setTab(tabName)}
          >
            {tabName === 'activity' ? (
              <Activity size={13} />
            ) : tabName === 'files' ? (
              <FileDiffIcon size={13} />
            ) : tabName === 'tests' ? (
              <Terminal size={13} />
            ) : tabName === 'snapshot' ? (
              <GitBranch size={13} />
            ) : (
              <Bot size={13} />
            )}
            {tabName === 'files'
              ? 'Files & diffs'
              : tabName === 'snapshot'
                ? 'Run snapshot'
                : tabName}
          </button>
        ))}
        <span />
        {tab !== 'conversation' && (
          <select
            aria-label="Execution attempt"
            value={selected?.id ?? ''}
            onChange={(event) => setAttemptId(event.target.value)}
          >
            {runs.map((run, index) => (
              <option key={run.id} value={run.id}>
                Attempt {index + 1} · {nodeStatus(run.status)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="node-workspace-content">
        {tab === 'conversation' ? (
          <div
            className="node-chat"
            ref={scroll}
            onScroll={() => {
              const element = scroll.current!
              follow.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                120
            }}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {loading && (
              <div className="node-empty">
                <LoaderCircle className="spin" size={22} />
                Loading conversation…
              </div>
            )}
            {!loading && !runs.length && (
              <div className="node-empty">
                <Bot size={32} />
                <h3>Put this node to work.</h3>
                <p>
                  Run its saved prompt in its own agent workspace. Independent
                  agents can work simultaneously. Ask for revisions here to
                  continue the same conversation.
                </p>
                <p className="node-seed-prompt">{node.data.prompt}</p>
              </div>
            )}
            {runs.map((run, index) => (
              <section className="node-turn" key={run.id}>
                <header>
                  ATTEMPT {index + 1}
                  <span>
                    {run.mode} · {nodeStatus(run.status)} ·{' '}
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </header>
                <div className="node-user-message">
                  <strong>You</strong>
                  <p>{run.prompt}</p>
                </div>
                {run.items
                  .filter((item) => item.type === 'agent_message')
                  .map((item) => (
                    <div className="node-agent-message" key={item.id}>
                      <strong>
                        <Bot size={14} />
                        Codex
                      </strong>
                      <p>{item.text}</p>
                    </div>
                  ))}
                <div className="node-turn-tools">
                  {run.items
                    .filter((item) => item.type !== 'agent_message')
                    .slice(-4)
                    .map((item) => (
                      <details key={item.id}>
                        <summary>
                          <Terminal size={12} />
                          <span>{item.title}</span>
                          <small>{item.status}</small>
                        </summary>
                        <pre>{item.text}</pre>
                      </details>
                    ))}
                </div>
                {isActiveNodeRun(run.status) && (
                  <p className="node-working">
                    <LoaderCircle size={13} className="spin" />
                    {run.status === 'preparing'
                      ? 'Preparing the agent worktree and recording its snapshot…'
                      : run.status === 'testing'
                        ? 'Running the configured checks…'
                        : run.status === 'stopping'
                          ? 'Stopping and recording partial changes…'
                          : 'Codex is working…'}
                  </p>
                )}
                {run.error && <FailureCard failure={run.error} />}
                {run.inspectionError && (
                  <FailureCard failure={run.inspectionError} />
                )}
                {!isActiveNodeRun(run.status) && (
                  <div className="node-turn-result">
                    <span>{run.changes?.files.length ?? 0} changed files</span>
                    <span>
                      Tests:{' '}
                      {run.tests.command ? run.tests.status : 'not configured'}
                    </span>
                    <button
                      onClick={() => {
                        setAttemptId(run.id)
                        setTab('files')
                      }}
                    >
                      Inspect result <FileDiffIcon size={12} />
                    </button>
                  </div>
                )}
              </section>
            ))}
            <div ref={end} />
          </div>
        ) : tab === 'activity' ? (
          <div className="node-scroll">
            {selected ? (
              <>
                <p className="node-limit-note">
                  SDK item events are shown as received. Nested tools and
                  incremental command output may be absent from this transport.
                </p>
                {selected.items.map((item) => (
                  <details
                    className="node-activity"
                    key={item.id}
                    open={item.type === 'command_execution'}
                  >
                    <summary>
                      {item.type} · {item.title}
                      <span>{item.status}</span>
                    </summary>
                    <pre>{item.text}</pre>
                  </details>
                ))}
                <details className="node-raw-events">
                  <summary>
                    Raw events ({selected.events.length} retained)
                  </summary>
                  {selected.events.map((event, index) => (
                    <pre key={index}>
                      {event.at} · {event.type}
                      {'\n'}
                      {event.detail}
                    </pre>
                  ))}
                </details>
              </>
            ) : (
              <div className="node-empty">Run this node to see activity.</div>
            )}
          </div>
        ) : tab === 'files' ? (
          <div className="node-files">
            <div className="node-file-list">
              <p>
                {selected?.changes
                  ? `${selected.changes.files.length} files changed in this attempt`
                  : ownActive
                    ? 'File snapshots are collected when the attempt settles.'
                    : 'No file snapshots for this attempt.'}
              </p>
              {selected?.inspectionError && (
                <FailureCard failure={selected.inspectionError} />
              )}
              {selected?.changes?.files.map((changed) => (
                <button
                  key={changed.path}
                  className={changed.path === file ? 'selected' : ''}
                  onClick={() => setFile(changed.path)}
                >
                  <span>{changed.status.slice(0, 1).toUpperCase()}</span>
                  {changed.path}
                </button>
              ))}
              {!!selected?.changes?.omittedFiles && (
                <p>
                  {selected.changes.omittedFiles} additional files are retained
                  in the Git snapshots.
                </p>
              )}
            </div>
            <div className="node-diff-panel">
              {file && (
                <header>
                  <strong>{file}</strong>
                  <span>Before this attempt → After this attempt</span>
                </header>
              )}
              {diffLoading ? (
                <div className="node-empty">
                  <LoaderCircle size={20} className="spin" />
                  Loading recorded diff…
                </div>
              ) : diff ? (
                <Suspense
                  fallback={
                    <div className="node-empty">Loading diff editor…</div>
                  }
                >
                  <NodeDiff diff={diff} />
                </Suspense>
              ) : (
                <div className="node-empty">
                  <FileDiffIcon size={27} />
                  <p>Select a changed file to compare its recorded contents.</p>
                </div>
              )}
            </div>
          </div>
        ) : tab === 'tests' ? (
          <div className="node-scroll">
            {selected ? (
              <>
                <div className="node-check-heading">
                  <strong>
                    {selected.tests.command
                      ? nodeStatus(selected.tests.status)
                      : 'No test command configured'}
                  </strong>
                  <span>
                    {selected.tests.exitCode !== null
                      ? `Exit ${selected.tests.exitCode}`
                      : ''}
                  </span>
                </div>
                <code className="node-command">
                  {selected.tests.command ||
                    'Set a test command in Project settings for future attempts.'}
                </code>
                <p className="node-limit-note">
                  The saved project test command runs in this agent’s isolated
                  workspace after a successful turn. Output is
                  retained up to 64 KB; timeout is two minutes.
                </p>
                <pre className="node-test-output">
                  {selected.tests.output ||
                    (selected.tests.status === 'not-run'
                      ? 'This attempt did not run checks.'
                      : 'No output.')}
                  {selected.tests.truncated ? '\n[output truncated]' : ''}
                </pre>
                {selected.integrationTests && <>
                  <h3>Combined result checks: {selected.integrationTests.status}</h3>
                  <pre className="node-test-output">{selected.integrationTests.output || 'No output.'}</pre>
                </>}
              </>
            ) : (
              <div className="node-empty">
                Run this node to collect test results.
              </div>
            )}
          </div>
        ) : (
          <div className="node-scroll">
            {selected ? (
              <RunSnapshot run={selected} />
            ) : (
              <div className="node-empty">
                Each attempt records its resolved prompt, settings, skill
                contents, and code revisions.
              </div>
            )}
          </div>
        )}
      </div>
      <footer className="node-workspace-footer">
        <div className="node-worktree-path">
          <GitBranch size={13} />
          <span title={snapshot?.worktree?.path ?? graph.project.repoPath}>
            {snapshot?.worktree?.branch ??
              'An isolated agent workspace will be created'}{' '}
            · {snapshot?.worktree?.path ?? graph.project.repoPath}
          </span>
          <TaskIdeButton identity={identity} />
          {snapshot?.worktree && (
            <button
              className="icon-button"
              onClick={() =>
                void navigator.clipboard.writeText(snapshot?.worktree?.path ?? graph.project.repoPath)
              }
              aria-label="Copy agent workspace path"
            >
              Copy path
            </button>
          )}
        </div>
        {tab === 'conversation' && (
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
              placeholder={
                snapshot?.threadId
                  ? 'Request a revision in this conversation…'
                  : 'Run this node to start its conversation…'
              }
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
        )}
        <p className="node-limit-note">
          Workspace writes · approval prompts unavailable · Stop retains code
          changes.{' '}
          {workflowNode?.status === 'completed'
            ? 'This result is accepted. A new revision invalidates affected downstream acceptance.'
            : 'Only completed, accepted predecessors unblock successors. Human review requires your explicit decision.'}
        </p>
      </footer>
    </Modal>
  )
}
function PlusConversation() {
  return <Bot size={13} />
}
function RunSnapshot({ run }: { run: NodeRun }) {
  return (
    <div className="node-snapshot">
      <h3>Saved execution context</h3>
      <p>
        Graph revision {run.graphRevision} · Attempt {run.id}
      </p>
      <p>
        Thread: {run.threadId ?? 'not created'} · {nodeStatus(run.status)}
      </p>
      <details open>
        <summary>Resolved prompt</summary>
        <pre>{run.resolvedPrompt || 'Preparation did not complete.'}</pre>
      </details>
      <details>
        <summary>Profile, skills, task & runtime options</summary>
        <pre>
          {JSON.stringify(
            {
              node: run.nodeSnapshot,
              task: run.taskSnapshot,
              project: run.projectSnapshot,
              profile: run.profileSnapshot,
              skills: run.skillSnapshots,
              options: run.options,
              dependencies: run.dependencyResults,
              previousAttempt: run.previousAttempt,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <details>
        <summary>Worktree and Git snapshots</summary>
        <pre>
          {JSON.stringify(
            {
              worktree: run.worktree,
              before: run.before,
              after: run.changes?.after,
              combinedTaskResult: run.taskResult,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  )
}
