import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CircleStop,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  TriangleAlert,
  Clock3,
  Play,
  X,
} from 'lucide-react'
import {
  makeWorkflowNode,
  type GraphDocument,
  type GraphSnapshot,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '../../shared/graph'
import {
  resolveNodeModel,
  validateGraph,
  validateTopology,
} from '../../shared/graph-validation'
import type { AgentProfile, CatalogSnapshot } from '../../shared/catalog'
import type { Effort, ModelOption } from '../../shared/contracts'
import { useCatalog } from './catalog-store'
import { SkillSelector } from './components/CatalogSelectors'
import { refreshDiagnostics, unwrap, useAppStore } from './store'
import { useWorkspaceStore } from './workspace-store'
import { useExecutionSnapshot } from './execution-store'
import { NodeWorkspace, nodeStatus } from './NodeWorkspace'
import { ReviewPanel, WorkflowControls } from './WorkflowControls'
import {
  workflowStatusLabel,
  type WorkflowNodeStatus,
} from '../../shared/workflow'

const kinds = {
  start: { label: 'Start', icon: GitBranch, color: '#8accae' },
  agent: { label: 'Agent task', icon: Bot, color: '#b7a0ed' },
  review: { label: 'Human review', icon: UserRound, color: '#e2bc85' },
  end: { label: 'End', icon: CircleStop, color: '#8db8dd' },
}
type CanvasNode = Node<
  {
    node: WorkflowNode
    subtitle: string
    issueCount: number
    status: WorkflowNodeStatus
  },
  'workflow'
>
function WorkflowCard({
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasNode>) {
  const { node } = data
  const kind = kinds[node.type],
    Icon = kind.icon
  const StatusIcon =
    data.status === 'completed'
      ? Check
      : data.status === 'failed'
        ? TriangleAlert
        : data.status === 'running'
          ? LoaderCircle
          : data.status === 'ready'
            ? Play
            : Clock3
  return (
    <div
      className={`workflow-node ${node.type} state-${data.status} ${selected ? 'selected' : ''} ${data.issueCount ? 'has-issues' : ''}`}
    >
      {node.type !== 'start' && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
        />
      )}
      <div className="workflow-node-type">
        <Icon size={14} />
        {kind.label}
        <span>{data.issueCount ? `${data.issueCount} to fix` : null}</span>
      </div>
      <strong>{node.data.title || 'Untitled node'}</strong>
      <p>{data.subtitle}</p>
      <div className="workflow-node-state">
        <StatusIcon
          size={12}
          className={data.status === 'running' ? 'spin' : ''}
        />
        {workflowStatusLabel[data.status]}
      </div>
      {node.type !== 'end' && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
        />
      )}
    </div>
  )
}
const nodeTypes = { workflow: WorkflowCard }

export function TaskGraphPage() {
  const { projectId, taskId } = useParams()
  if (!projectId || !taskId) return null
  return (
    <ReactFlowProvider key={`${projectId}:${taskId}`}>
      <GraphEditor projectId={projectId} taskId={taskId} />
    </ReactFlowProvider>
  )
}

function GraphEditor({
  projectId,
  taskId,
}: {
  projectId: string
  taskId: string
}) {
  const [saved, setSaved] = useState<GraphSnapshot>()
  const [draft, setDraft] = useState<GraphDocument>()
  const [selectedNode, setSelectedNode] = useState<string>()
  const [selectedEdge, setSelectedEdge] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [externalChange, setExternalChange] = useState(false)
  const [openNode, setOpenNode] = useState<string>()
  const { snapshot: execution } = useExecutionSnapshot(
    { projectId, taskId },
    (api) => api.getTask({ projectId, taskId }),
    `${projectId}:${taskId}`,
  )
  const taskActive = execution?.active?.taskId === taskId
  const workflow = execution?.workflow
  // React Flow measurements are view state. Retain them across controlled-node
  // updates without storing library-specific fields in the graph document.
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({})
  const { snapshot: catalog } = useCatalog(projectId)
  const models = useAppStore((state) => state.state?.diagnostics?.models)
  const task = useWorkspaceStore((state) =>
    state.snapshot?.tasks.find((task) => task.id === taskId),
  )
  const flow = useReactFlow<CanvasNode>()
  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(saved?.document)
  const refs = useRef({ saved, draft, dirty, alive: true })
  refs.current = { saved, draft, dirty, alive: true }
  const requestNumber = useRef(0)
  const refresh = useCallback(
    async (discard = false) => {
      const request = ++requestNumber.current
      try {
        const api = window.constella?.graphs
        if (!api)
          throw new Error(
            'The graph bridge is unavailable. Quit Electron and restart npm run dev.',
          )
        const next = await unwrap(api.get({ projectId, taskId }))
        if (!refs.current.alive || request !== requestNumber.current) return
        if (discard || !refs.current.draft || !refs.current.dirty) {
          setSaved(next)
          setDraft(next.document)
          setExternalChange(false)
        } else if (next.revision !== refs.current.saved?.revision)
          setExternalChange(true)
        else setSaved(next)
      } catch (error) {
        if (!useAppStore.getState().error)
          useAppStore.getState().setError({
            code: 'GRAPH_LOAD',
            message: String(error),
            hint: 'Open this graph from its project board and retry.',
          })
      } finally {
        if (refs.current.alive) setLoading(false)
      }
    },
    [projectId, taskId],
  )
  useEffect(() => {
    refs.current.alive = true
    void refresh()
    const unsubscribe = window.constella?.graphs?.onChange((identity) => {
      if (identity.projectId === projectId && identity.taskId === taskId)
        void refresh()
    })
    return () => {
      refs.current.alive = false
      requestNumber.current++
      unsubscribe?.()
    }
  }, [refresh, projectId, taskId])
  useEffect(() => {
    if (catalog) void refresh()
  }, [catalog?.revision, task?.revision, models, refresh])
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (refs.current.dirty) event.preventDefault()
    }
    const preventNavigation = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest('a') : null
      if (
        refs.current.dirty &&
        link?.hash &&
        link.hash !== location.hash &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        setNotice('Save your draft or reload the saved graph before leaving.')
      }
    }
    window.addEventListener('beforeunload', prevent)
    document.addEventListener('click', preventNavigation, true)
    return () => {
      window.removeEventListener('beforeunload', prevent)
      document.removeEventListener('click', preventNavigation, true)
    }
  }, [])
  const validation = useMemo(
    () =>
      draft && catalog
        ? validateGraph(draft, {
            catalog,
            models: models ?? [],
            archived: !!(task?.archivedAt ?? saved?.task.archivedAt),
          })
        : undefined,
    [draft, catalog, models, saved?.task.archivedAt, task?.archivedAt],
  )
  const editable =
    !busy &&
    !taskActive &&
    !!catalog &&
    !(task?.archivedAt ?? saved?.task.archivedAt)
  const runBlockers = [
    ...(dirty
      ? [
          'There are unsaved graph changes. Return to the graph and click Save graph.',
        ]
      : []),
    ...(externalChange
      ? [
          'A newer graph revision is saved. Reload the saved graph before running this node.',
        ]
      : []),
    ...(!validation
      ? ['Graph settings are still loading.']
      : validation.issues.map((issue) => {
          const title = draft?.nodes.find((node) => node.id === issue.nodeId)
            ?.data.title
          return title && !issue.message.includes(title)
            ? `${title}: ${issue.message}`
            : issue.message
        })),
  ]
  const node = draft?.nodes.find((node) => node.id === selectedNode)
  const edge = draft?.edges.find((edge) => edge.id === selectedEdge)
  function runtimeStatus(node: WorkflowNode): WorkflowNodeStatus {
    const state = workflow?.nodes[node.id]
    const previous = execution?.nodeStates.find(
      (state) => state.nodeId === node.id,
    )
    if (!workflow?.startedAt && node.type === 'agent' && previous)
      return previous.status === 'completed'
        ? 'awaiting-acceptance'
        : previous.status === 'failed'
          ? 'failed'
          : previous.status === 'cancelled'
            ? 'stopped'
            : previous.status === 'interrupted'
              ? 'interrupted'
              : 'running'
    return state?.status ?? 'pending'
  }
  function inspect(id: string) {
    setSelectedNode(id)
    setSelectedEdge(undefined)
    const node = saved?.document.nodes.find((node) => node.id === id)
    if (node?.type === 'agent') setOpenNode(id)
  }
  const canvasNodes: CanvasNode[] = (draft?.nodes ?? []).map((node) => ({
    id: node.id,
    type: 'workflow',
    position: node.position,
    measured: measurements[node.id],
    selected: node.id === selectedNode,
    data: {
      node,
      status: runtimeStatus(node),
      subtitle:
        node.type === 'agent'
          ? (catalog?.profiles.find(
              (profile) => profile.id === node.data.profileId,
            )?.name ??
              (node.data.profileId ? 'Unavailable profile' : 'Default Codex')) +
            (execution?.nodeStates.find((state) => state.nodeId === node.id)
              ? ` · ${nodeStatus(execution.nodeStates.find((state) => state.nodeId === node.id)!.status)}`
              : '')
          : node.type === 'review'
            ? 'Waits for your decision'
            : node.type === 'start'
              ? 'Workflow entry point'
              : 'All required work accepted',
      issueCount:
        validation?.issues.filter((issue) => issue.nodeId === node.id).length ??
        0,
    },
  }))
  const canvasEdges: Edge[] = (draft?.edges ?? []).map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdge,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    style:
      workflow?.nodes[edge.source]?.status === 'completed'
        ? { stroke: '#70bf95' }
        : workflow?.nodes[edge.source]?.status === 'failed'
          ? { stroke: '#dc7b7b', strokeDasharray: '5 4' }
          : undefined,
    ariaLabel: `Connection from ${draft?.nodes.find((node) => node.id === edge.source)?.data.title} to ${draft?.nodes.find((node) => node.id === edge.target)?.data.title}`,
  }))
  function edit(update: (document: GraphDocument) => GraphDocument) {
    if (!editable) return
    setDraft((current) => (current ? update(current) : current))
    setNotice('')
  }
  function updateNode(next: WorkflowNode) {
    edit((document) => ({
      ...document,
      nodes: document.nodes.map((node) => (node.id === next.id ? next : node)),
    }))
  }
  function removeNode(id: string) {
    edit((document) => ({
      ...document,
      nodes: document.nodes.filter((node) => node.id !== id),
      edges: document.edges.filter(
        (edge) => edge.source !== id && edge.target !== id,
      ),
    }))
    setSelectedNode(undefined)
    setSelectedEdge(undefined)
  }
  function connect(connection: Connection, replacing?: string) {
    if (!draft || !editable) return
    if (!replacing && draft.edges.length >= 400) {
      setConnectionError('A workflow can have at most 400 connections.')
      return
    }
    const edge: WorkflowEdge = {
      id: replacing ?? crypto.randomUUID(),
      source: connection.source,
      target: connection.target,
    }
    const next = {
      ...draft,
      edges: [...draft.edges.filter((edge) => edge.id !== replacing), edge],
    }
    const result = validateTopology(next)
    if (!result.canSave) {
      setConnectionError(
        result.issues
          .filter((issue) => issue.blocksSave)
          .map((issue) => issue.message)
          .join(' '),
      )
      return
    }
    edit(() => next)
    setConnectionError('')
    setSelectedEdge(edge.id)
    setSelectedNode(undefined)
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setNotice('')
    useAppStore.getState().setError(undefined)
    try {
      await action()
    } catch (error) {
      if (!useAppStore.getState().error)
        useAppStore.getState().setError({
          code: 'GRAPH',
          message: String(error),
          hint: 'Your draft is retained. Check the graph and retry.',
        })
    } finally {
      if (refs.current.alive) setBusy(false)
    }
  }
  async function save() {
    if (!draft || !saved) return
    await perform(async () => {
      const next = await unwrap(
        window.constella!.graphs.save({
          projectId,
          taskId,
          expectedRevision: saved.revision,
          commandId: crypto.randomUUID(),
          document: { ...draft, viewport: flow.getViewport() },
        }),
      )
      if (!refs.current.alive) return
      setSaved(next)
      setDraft(next.document)
      setExternalChange(false)
      setNotice(`Graph saved · revision ${next.revision}`)
    })
  }
  async function prepare() {
    if (!saved || dirty) return
    await perform(async () => {
      const result = await unwrap(
        window.constella!.graphs.prepareStart({
          projectId,
          taskId,
          expectedRevision: saved.revision,
        }),
      )
      if (!refs.current.alive) return
      setNotice(
        `Revision ${result.revision} passed readiness checks. Select an agent node and open Conversation & runs to execute it.`,
      )
      await refresh()
    })
  }
  function addNode(type: WorkflowNodeType) {
    const center = flow.screenToFlowPosition({
      x: window.innerWidth * 0.52,
      y: window.innerHeight * 0.47,
    })
    const next = makeWorkflowNode(type, crypto.randomUUID(), {
      x: Math.round(center.x),
      y: Math.round(center.y),
    })
    edit((document) => ({ ...document, nodes: [...document.nodes, next] }))
    setSelectedNode(next.id)
    setSelectedEdge(undefined)
  }
  if (!draft || !saved)
    return (
      <main className="graph-loading">
        <LoaderCircle size={22} className={loading ? 'spin' : ''} />
        <p>
          {loading ? 'Opening task graph…' : 'The graph could not be opened.'}
        </p>
        <button className="button secondary" onClick={() => void refresh()}>
          Retry
        </button>
        <Link to={`/projects/${projectId}`}>Back to board</Link>
      </main>
    )
  return (
    <main className="graph-page">
      <header className="graph-heading">
        <div>
          <Link
            className="graph-back"
            to={`/projects/${projectId}`}
            onClick={(event) => {
              if (dirty) {
                event.preventDefault()
                setNotice(
                  'Save your draft or reload the saved graph before leaving.',
                )
              }
            }}
          >
            <ArrowLeft size={13} />
            {saved.project.name} / Board
          </Link>
          <h1>{saved.task.title}</h1>
          <p>
            Task workflow <span>·</span> Revision {saved.revision}{' '}
            <span>·</span>{' '}
            {dirty
              ? 'Unsaved draft'
              : saved.prepared
                ? 'Readiness checked'
                : 'Saved on this device'}
          </p>
        </div>
        <div className="graph-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refresh(true)}
            title={
              dirty
                ? 'Discard this draft and load the saved graph'
                : 'Reload the saved graph'
            }
          >
            <RefreshCw size={14} />
            {dirty ? 'Discard draft & reload' : 'Reload'}
          </button>
          <button
            className="button secondary"
            disabled={!editable || !dirty || !validation?.canSave}
            onClick={() => void save()}
          >
            <Save size={14} />
            Save graph
          </button>
          <button
            className="button primary"
            disabled={busy || dirty || externalChange || !validation?.valid}
            onClick={() => void prepare()}
            title={
              dirty
                ? 'Save this draft first'
                : 'Validate the saved graph and its current assignments'
            }
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <ShieldCheck size={14} />
            )}
            Check readiness
          </button>
        </div>
      </header>
      <WorkflowControls
        workflow={workflow}
        graphRevision={saved.revision}
        blocked={dirty || !validation?.valid || externalChange || taskActive}
        onInspect={inspect}
      />
      {(notice || externalChange || saved.task.archivedAt || taskActive) && (
        <div className="graph-notice" role="status">
          {taskActive
            ? 'A node is active in this task. Graph editing is paused until its attempt settles.'
            : externalChange
              ? 'A newer graph revision is saved. Your draft is retained; reload to review the saved version.'
              : saved.task.archivedAt
                ? 'This task is archived. Restore it on the board to edit its graph.'
                : notice}
        </div>
      )}
      <div className="graph-workspace">
        <section className="graph-surface" aria-label="Workflow graph editor">
          <div className="graph-palette">
            <span>ADD NODE</span>
            {(Object.keys(kinds) as WorkflowNodeType[]).map((type) => {
              const Icon = kinds[type].icon
              return (
                <button
                  key={type}
                  disabled={
                    !editable ||
                    draft.nodes.length >= 100 ||
                    ((type === 'start' || type === 'end') &&
                      draft.nodes.some((node) => node.type === type))
                  }
                  onClick={() => addNode(type)}
                >
                  <Icon size={14} />
                  {kinds[type].label}
                  <Plus size={11} />
                </button>
              )
            })}
          </div>
          <div className="graph-canvas">
            <ReactFlow<CanvasNode>
              nodes={canvasNodes}
              edges={canvasEdges}
              nodeTypes={nodeTypes}
              defaultViewport={draft.viewport}
              minZoom={0.1}
              maxZoom={2.5}
              colorMode="dark"
              nodesDraggable={!!editable}
              nodesConnectable={!!editable}
              edgesReconnectable={!!editable}
              deleteKeyCode={null}
              onNodesChange={(changes) => {
                const dimensions = changes.filter(
                  (change) => change.type === 'dimensions' && change.dimensions,
                )
                if (dimensions.length)
                  setMeasurements((current) => {
                    const next = { ...current }
                    for (const change of dimensions)
                      if (change.type === 'dimensions' && change.dimensions)
                        next[change.id] = change.dimensions
                    return next
                  })
                if (changes.some((change) => change.type === 'position'))
                  edit((document) => ({
                    ...document,
                    nodes: document.nodes.map((node) => {
                      const change = changes.find(
                        (change) =>
                          change.type === 'position' && change.id === node.id,
                      )
                      return change?.type === 'position' && change.position
                        ? { ...node, position: change.position }
                        : node
                    }),
                  }))
              }}
              onMoveEnd={(event, viewport) => {
                if (event) edit((document) => ({ ...document, viewport }))
              }}
              onNodeClick={(_, node) => {
                setSelectedNode(node.id)
                setSelectedEdge(undefined)
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdge(edge.id)
                setSelectedNode(undefined)
              }}
              onPaneClick={() => {
                setSelectedNode(undefined)
                setSelectedEdge(undefined)
              }}
              onConnect={(connection) => connect(connection)}
              onReconnect={(edge, connection) => connect(connection, edge.id)}
              onInit={(instance) => {
                if (saved.revision === 1)
                  void instance.fitView({ padding: 0.2, maxZoom: 1 })
              }}
              proOptions={{ hideAttribution: false }}
            >
              <Background color="#34303e" gap={22} size={1} />
              <Controls showInteractive={false} />
              <MiniMap<CanvasNode>
                nodeColor={(node) =>
                  node.data.status === 'completed'
                    ? '#70bf95'
                    : node.data.status === 'failed'
                      ? '#dc7b7b'
                      : node.data.status === 'running'
                        ? '#bd9df2'
                        : '#645b72'
                }
                pannable
                zoomable
              />
            </ReactFlow>
            <div className="graph-canvas-tip">
              Drag nodes to arrange · Connect right handle → left handle ·
              Select a node to configure
            </div>
            {connectionError && (
              <div className="graph-connection-error" role="alert">
                <span>{connectionError}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss connection error"
                  onClick={() => setConnectionError('')}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          <section className="graph-validation" aria-label="Graph validation">
            <header>
              <strong>
                {validation?.valid
                  ? 'Graph is valid'
                  : `${validation?.issues.length ?? '…'} items to resolve`}
              </strong>
              <span>
                {dirty
                  ? 'Save before checking readiness'
                  : 'Select an agent to open its conversation'}
              </span>
            </header>
            {validation?.issues.length ? (
              <ul>
                {validation.issues.map((issue, index) => (
                  <li key={`${issue.code}:${index}`}>
                    <button
                      onClick={() => {
                        setSelectedNode(issue.nodeId)
                        setSelectedEdge(issue.edgeId)
                        if (issue.nodeId)
                          void flow.fitView({
                            nodes: [{ id: issue.nodeId }],
                            maxZoom: 1,
                            duration: 200,
                          })
                      }}
                    >
                      <span className={issue.blocksSave ? 'hard-issue' : ''}>
                        {issue.blocksSave ? 'Fix' : 'Draft'}
                      </span>
                      {issue.message}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Every node is on a path from Start to End. Current assignments
                are valid.
              </p>
            )}
          </section>
        </section>
        <aside className="graph-details" aria-label="Node details">
          <header>
            <div>
              <span>WORKFLOW / DETAILS</span>
              <h2>
                {node
                  ? kinds[node.type].label
                  : edge
                    ? 'Connection'
                    : 'Your workflow'}
              </h2>
            </div>
            <GitBranch size={18} />
          </header>
          {node?.type === 'review' && workflow && (
            <ReviewPanel
              key={`review:${node.id}`}
              workflow={workflow}
              nodeId={node.id}
              onInspect={inspect}
              disabled={runBlockers.length > 0}
            />
          )}
          {node?.type === 'agent' && (
            <div className="graph-node-work">
              <button
                className="button primary"
                disabled={
                  !saved.document.nodes.some((item) => item.id === node.id)
                }
                onClick={() => setOpenNode(node.id)}
              >
                <Bot size={14} />
                Conversation & runs
              </button>
              <p>
                {!saved.document.nodes.some((item) => item.id === node.id)
                  ? 'Save this new node first.'
                  : 'Run, stop, request revisions, and inspect tests and diffs.'}
              </p>
            </div>
          )}
          {node && catalog ? (
            <NodeSettings
              key={`settings:${node.id}`}
              node={node}
              catalog={catalog}
              models={models ?? []}
              disabled={!editable}
              onChange={updateNode}
              onRemove={() => removeNode(node.id)}
            />
          ) : edge ? (
            <div className="graph-settings">
              <EdgeSettings
                key={edge.id}
                edge={edge}
                nodes={draft.nodes}
                disabled={!editable}
                onChange={(connection) => connect(connection, edge.id)}
                onRemove={() => {
                  edit((document) => ({
                    ...document,
                    edges: document.edges.filter((item) => item.id !== edge.id),
                  }))
                  setSelectedEdge(undefined)
                }}
              />
            </div>
          ) : (
            <div className="graph-settings">
              <p className="graph-intro">
                Give the work a path. Add agent tasks, connect dependencies, and
                put a human decision wherever it matters.
              </p>
              <p className="helper">
                Select a node for its prompt and assignments. All incoming
                dependencies must be accepted before a node can proceed.
              </p>
              <div className="graph-task-brief">
                <strong>Task brief</strong>
                <p>{saved.task.description || 'No description yet.'}</p>
                {saved.task.acceptanceCriteria && (
                  <>
                    <strong>Acceptance criteria</strong>
                    <p>{saved.task.acceptanceCriteria}</p>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="graph-structure">
            <h3>
              Nodes <span>{draft.nodes.length}</span>
            </h3>
            {draft.nodes.map((node) => {
              const Icon = kinds[node.type].icon
              return (
                <button
                  key={node.id}
                  className={node.id === selectedNode ? 'selected' : ''}
                  onClick={() => {
                    setSelectedNode(node.id)
                    setSelectedEdge(undefined)
                    void flow.fitView({
                      nodes: [{ id: node.id }],
                      maxZoom: 1,
                      duration: 200,
                    })
                  }}
                >
                  <Icon size={13} />
                  <span>{node.data.title || 'Untitled node'}</span>
                  <small>{kinds[node.type].label}</small>
                </button>
              )
            })}
            <h3>
              Connections <span>{draft.edges.length}</span>
            </h3>
            {draft.edges.map((edge) => (
              <button
                key={edge.id}
                className={edge.id === selectedEdge ? 'selected' : ''}
                onClick={() => {
                  setSelectedEdge(edge.id)
                  setSelectedNode(undefined)
                }}
              >
                <span>
                  {
                    draft.nodes.find((node) => node.id === edge.source)?.data
                      .title
                  }
                </span>
                <ArrowRight size={12} />
                <span>
                  {
                    draft.nodes.find((node) => node.id === edge.target)?.data
                      .title
                  }
                </span>
              </button>
            ))}
            <ConnectionForm
              nodes={draft.nodes}
              disabled={!editable || draft.edges.length >= 400}
              onConnect={(connection) => connect(connection)}
            />
          </div>
        </aside>
      </div>
      {(() => {
        const node = saved.document.nodes.find((node) => node.id === openNode)
        return node?.type === 'agent' ? (
          <NodeWorkspace
            key={node.id}
            graph={saved}
            node={node}
            runBlockers={runBlockers}
            onClose={() => setOpenNode(undefined)}
          />
        ) : null
      })()}
    </main>
  )
}

function NodeSettings({
  node,
  catalog,
  models,
  disabled,
  onChange,
  onRemove,
}: {
  node: WorkflowNode
  catalog: CatalogSnapshot
  models: ModelOption[]
  disabled: boolean
  onChange: (node: WorkflowNode) => void
  onRemove: () => void
}) {
  const profile =
    node.type === 'agent'
      ? catalog.profiles.find((profile) => profile.id === node.data.profileId)
      : undefined
  return (
    <div className="graph-settings">
      <fieldset disabled={disabled}>
        <label htmlFor="graph-node-title">Title</label>
        <input
          id="graph-node-title"
          maxLength={180}
          value={node.data.title}
          onChange={(event) => {
            const next = structuredClone(node)
            next.data.title = event.target.value
            onChange(next)
          }}
        />
        {node.type === 'agent' && (
          <>
            <label htmlFor="graph-node-profile">Agent profile (optional)</label>
            <select
              id="graph-node-profile"
              value={node.data.profileId ?? ''}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, profileId: event.target.value || null },
                })
              }
            >
              <option value="">Default Codex</option>
              {node.data.profileId && (!profile || profile.removedAt) && (
                <option value={node.data.profileId}>Unavailable profile</option>
              )}
              {catalog.profiles
                .filter((profile) => !profile.removedAt)
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.projectId ? 'Project' : 'Global'}
                  </option>
                ))}
            </select>
            {!node.data.profileId && (
              <p className="helper">
                Default Codex adds no custom role or profile skills. It uses
                your task and project context, with model and effort defaults
                unless overridden below.
              </p>
            )}
            <Link
              className="graph-catalog-link"
              to={`/agents?project=${catalog.projectId}`}
            >
              Manage agent profiles <ArrowRight size={11} />
            </Link>
            {profile && (
              <details className="graph-inherited">
                <summary>Profile instructions & style guide</summary>
                <pre>{profile.roleInstructions}</pre>
                {profile.styleGuide && <pre>{profile.styleGuide}</pre>}
              </details>
            )}
            <label htmlFor="graph-node-prompt">Initial prompt</label>
            <textarea
              id="graph-node-prompt"
              rows={6}
              maxLength={32000}
              value={node.data.prompt}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, prompt: event.target.value },
                })
              }
              placeholder="What should this agent accomplish?"
            />
            <label htmlFor="graph-node-criteria">Acceptance criteria</label>
            <textarea
              id="graph-node-criteria"
              rows={4}
              maxLength={20000}
              value={node.data.acceptanceCriteria}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    acceptanceCriteria: event.target.value,
                  },
                })
              }
              placeholder="What must be true when this work is complete?"
            />
            <NodeModelFields
              node={node}
              profile={profile}
              models={models}
              onChange={onChange}
            />
            <label htmlFor="graph-node-acceptance">Acceptance</label>
            <select
              id="graph-node-acceptance"
              value={node.data.acceptance}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    acceptance: event.target.value as 'auto' | 'manual',
                  },
                })
              }
            >
              <option value="manual">Accept manually</option>
              <option value="auto">Auto accept successful work</option>
            </select>
            <p className="helper">
              Auto accept applies to this agent's successful result. Human
              review gates always require your decision.
            </p>
            <label>Skills</label>
            <SkillSelector
              skills={catalog.skills}
              selected={[
                ...new Set([
                  ...(profile?.skillIds ?? []),
                  ...node.data.skillIds,
                ]),
              ]}
              requiredIds={profile?.skillIds ?? []}
              onChange={(ids) =>
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    skillIds: ids.filter(
                      (id) => !profile?.skillIds.includes(id),
                    ),
                  },
                })
              }
              disabled={disabled}
            />
          </>
        )}
        {node.type === 'review' && (
          <>
            <label htmlFor="graph-review-instructions">
              Review instructions
            </label>
            <textarea
              id="graph-review-instructions"
              rows={7}
              maxLength={20000}
              value={node.data.instructions}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, instructions: event.target.value },
                })
              }
            />
            <div className="graph-human-note">
              <UserRound size={15} />
              <p>
                This gate requires a human to approve or request changes. It
                cannot auto accept.
              </p>
            </div>
          </>
        )}
        {node.type === 'start' && (
          <p className="helper">
            One entry point per workflow. Connect Start to the first tasks.
          </p>
        )}
        {node.type === 'end' && (
          <p className="helper">
            One finish point per workflow. End waits for every incoming
            dependency to be accepted.
          </p>
        )}
        <button
          className="button subtle-danger graph-delete"
          onClick={onRemove}
        >
          <Trash2 size={13} />
          Delete node & its connections
        </button>
      </fieldset>
    </div>
  )
}

function NodeModelFields({
  node,
  profile,
  models,
  onChange,
}: {
  node: Extract<WorkflowNode, { type: 'agent' }>
  profile?: AgentProfile
  models: ModelOption[]
  onChange: (node: WorkflowNode) => void
}) {
  const effective = resolveNodeModel(node, profile)
  const option = models.find((model) => model.id === effective.model)
  const modelValue =
    node.data.model === undefined
      ? '__inherit__'
      : (node.data.model ?? '__default__')
  const effortValue =
    node.data.effort === undefined
      ? '__inherit__'
      : (node.data.effort ?? '__default__')
  return (
    <>
      <label htmlFor="graph-node-model">Model</label>
      <select
        id="graph-node-model"
        value={modelValue}
        onChange={(event) =>
          onChange({
            ...node,
            data: {
              ...node.data,
              model:
                event.target.value === '__inherit__'
                  ? undefined
                  : event.target.value === '__default__'
                    ? null
                    : event.target.value,
              effort: undefined,
            },
          })
        }
      >
        <option value="__inherit__">
          Use agent default ({profile?.model ?? 'configured default'})
        </option>
        <option value="__default__">Configured default</option>
        {node.data.model &&
          !models.some((model) => model.id === node.data.model) && (
            <option value={node.data.model}>
              {node.data.model} (unavailable)
            </option>
          )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <label htmlFor="graph-node-effort">Reasoning effort</label>
      <select
        id="graph-node-effort"
        value={effortValue}
        onChange={(event) =>
          onChange({
            ...node,
            data: {
              ...node.data,
              effort:
                event.target.value === '__inherit__'
                  ? undefined
                  : event.target.value === '__default__'
                    ? null
                    : (event.target.value as Effort),
            },
          })
        }
      >
        <option value="__inherit__">
          Use agent default when model matches
        </option>
        <option value="__default__">Model default</option>
        {node.data.effort && !option?.efforts.includes(node.data.effort) && (
          <option value={node.data.effort}>
            {node.data.effort} (unavailable)
          </option>
        )}
        {option?.efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <p className="helper">
        Effective: {effective.model ?? 'configured default'} /{' '}
        {effective.effort ?? 'model default'}
      </p>
      <button
        className="graph-catalog-link"
        type="button"
        onClick={() => void refreshDiagnostics()}
      >
        <RefreshCw size={11} />
        Refresh model options
      </button>
    </>
  )
}

function EdgeSettings({
  edge,
  nodes,
  disabled,
  onChange,
  onRemove,
}: {
  edge: WorkflowEdge
  nodes: WorkflowNode[]
  disabled: boolean
  onChange: (connection: Connection) => void
  onRemove: () => void
}) {
  return (
    <fieldset disabled={disabled}>
      <p className="helper">
        The target waits for the source to complete and be accepted. Multiple
        incoming edges require all predecessors.
      </p>
      <label htmlFor="graph-edge-source">From</label>
      <select
        id="graph-edge-source"
        value={edge.source}
        onChange={(event) =>
          onChange({
            source: event.target.value,
            target: edge.target,
            sourceHandle: null,
            targetHandle: null,
          })
        }
      >
        {nodes
          .filter((node) => node.type !== 'end')
          .map((node) => (
            <option key={node.id} value={node.id}>
              {node.data.title || 'Untitled node'}
            </option>
          ))}
      </select>
      <label htmlFor="graph-edge-target">To</label>
      <select
        id="graph-edge-target"
        value={edge.target}
        onChange={(event) =>
          onChange({
            source: edge.source,
            target: event.target.value,
            sourceHandle: null,
            targetHandle: null,
          })
        }
      >
        {nodes
          .filter((node) => node.type !== 'start')
          .map((node) => (
            <option key={node.id} value={node.id}>
              {node.data.title || 'Untitled node'}
            </option>
          ))}
      </select>
      <button className="button subtle-danger graph-delete" onClick={onRemove}>
        <Trash2 size={13} />
        Delete connection
      </button>
    </fieldset>
  )
}
function ConnectionForm({
  nodes,
  disabled,
  onConnect,
}: {
  nodes: WorkflowNode[]
  disabled: boolean
  onConnect: (connection: Connection) => void
}) {
  const [source, setSource] = useState(''),
    [target, setTarget] = useState('')
  return (
    <form
      className="graph-connect-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (
          nodes.some((node) => node.id === source) &&
          nodes.some((node) => node.id === target)
        )
          onConnect({ source, target, sourceHandle: null, targetHandle: null })
      }}
    >
      <fieldset disabled={disabled}>
        <label htmlFor="graph-connect-source">Add connection</label>
        <select
          id="graph-connect-source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">From…</option>
          {nodes
            .filter((node) => node.type !== 'end')
            .map((node) => (
              <option key={node.id} value={node.id}>
                {node.data.title || 'Untitled node'}
              </option>
            ))}
        </select>
        <select
          aria-label="Connection target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">To…</option>
          {nodes
            .filter((node) => node.type !== 'start')
            .map((node) => (
              <option key={node.id} value={node.id}>
                {node.data.title || 'Untitled node'}
              </option>
            ))}
        </select>
        <button
          type="submit"
          className="button secondary"
          disabled={!source || !target || disabled}
        >
          <Plus size={12} />
          Connect
        </button>
      </fieldset>
    </form>
  )
}
