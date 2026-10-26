import { and, eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import type { WorkspaceDatabase } from '../db/database'
import { workflows, workflowDecisions, workspaceMeta } from '../db/schema'
import {
  graphIdentitySchema,
  type GraphIdentity,
  type GraphSnapshot,
} from '../../shared/graph'
import {
  acceptNodeSchema,
  reviewNodeSchema,
  workflowStartSchema,
  integrationPreviewSchema,
  integrationApplySchema,
  summarizeWorkflow,
  type IntegrationPlan,
  type WorkflowRecord,
  type WorkflowSnapshot,
  type WorkflowNodeState,
  type WorkflowDecision,
  type HumanOrigin,
} from '../../shared/workflow'
import {
  startNodeSchema,
  type NodeRun,
  type StartNodeInput,
} from '../../shared/execution'
import { ApplicationError, applicationFailure } from './errors'
import type { GraphService } from './graph-service'
import type { CatalogService } from './catalog-service'
import type { NodeExecutionService } from './node-execution-service'
import type { WorkspaceService } from './workspace-service'
import { BranchIntegrationService } from './branch-integration'

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
export class WorkflowService {
  private listeners = new Set<(identity: GraphIdentity) => void>()
  private pumping = new Map<string, Promise<void>>()
  private syncing = new Set<string>()
  private operations = new Set<string>()
  private stopping = false
  hasActiveProject(projectId: string) {
    return (
      this.operations.has(projectId) ||
      this.pumping.has(projectId) ||
      !!this.execution.activeProject(projectId)
    )
  }
  constructor(
    private readonly database: WorkspaceDatabase,
    readonly graphs: GraphService,
    private readonly catalog: CatalogService,
    readonly execution: NodeExecutionService,
    private readonly workspace: WorkspaceService,
  ) {
    execution.setWorkflowHooks({
      admit: (input) => this.admit(input),
      started: (run) => this.started(run),
      settled: (run) => this.settled(run),
    })
    graphs.setExecutionGuard(
      (identity) =>
        execution.hasActiveTask(identity) ||
        this.operations.has(identity.projectId),
    )
    graphs.subscribe((identity) => this.configurationChanged(identity))
    catalog.subscribe(() => {
      for (const row of this.database.db.select().from(workflows).all())
        this.configurationChanged(row.document)
    })
    workspace.subscribe(() => {
      for (const row of this.database.db.select().from(workflows).all())
        this.configurationChanged(row.document)
    })
  }
  private get db() {
    return this.database.db
  }
  subscribe(listener: (identity: GraphIdentity) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(identity: GraphIdentity) {
    for (const listener of this.listeners) {
      try {
        listener(identity)
      } catch (error) {
        console.error('Workflow notification failed:', error)
      }
    }
  }
  private row(identity: GraphIdentity) {
    const row = this.db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.taskId, identity.taskId),
          eq(workflows.projectId, identity.projectId),
        ),
      )
      .get()
    return row ? structuredClone(row.document) : undefined
  }
  private signatures(graph: GraphSnapshot) {
    const catalog = this.catalog.getSnapshot({ projectId: graph.project.id })
    return Object.fromEntries(
      graph.document.nodes.map((node) => {
        const parents = graph.document.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => edge.source)
          .sort()
        const profile =
          node.type === 'agent'
            ? catalog.profiles.find(
                (profile) => profile.id === node.data.profileId,
              )
            : undefined
        const skills =
          node.type === 'agent'
            ? [
                ...new Set([
                  ...(profile?.skillIds ?? []),
                  ...node.data.skillIds,
                ]),
              ]
                .sort()
                .map(
                  (id) => catalog.skills.find((skill) => skill.id === id) ?? id,
                )
            : []
        return [
          node.id,
          hash({
            type: node.type,
            data: node.data,
            parents,
            ...(node.type === 'agent'
              ? {
                  profile,
                  skills,
                  project: {
                    name: graph.project.name,
                    description: graph.project.description,
                    instructions: graph.project.instructions,
                    devCommand: graph.project.devCommand,
                    testCommand: graph.project.testCommand,
                    defaultModel: graph.project.defaultModel,
                    defaultEffort: graph.project.defaultEffort,
                  },
                  task: {
                    title: graph.task.title,
                    description: graph.task.description,
                    acceptanceCriteria: graph.task.acceptanceCriteria,
                  },
                }
              : {}),
          }),
        ]
      }),
    )
  }
  private fresh(graph: GraphSnapshot): WorkflowRecord {
    const signatures = this.signatures(graph)
    return {
      projectId: graph.project.id,
      taskId: graph.task.id,
      revision: 0,
      graphRevision: graph.revision,
      phase: graph.task.archivedAt ? 'archived' : 'idle',
      nodes: Object.fromEntries(
        graph.document.nodes.map((node) => [
          node.id,
          {
            id: node.id,
            type: node.type,
            title: node.data.title,
            signature: signatures[node.id],
            status: 'pending',
          },
        ]),
      ),
      updatedAt: now(),
    }
  }
  private persist(record: WorkflowRecord, decision?: WorkflowDecision) {
    record.revision++
    record.updatedAt = now()
    this.syncing.add(record.taskId)
    try {
      this.database.sqlite
        .transaction(() => {
          this.db
            .insert(workflows)
            .values({
              taskId: record.taskId,
              projectId: record.projectId,
              document: record,
            })
            .onConflictDoUpdate({
              target: workflows.taskId,
              set: { document: record },
            })
            .run()
          if (decision)
            this.db
              .insert(workflowDecisions)
              .values({
                id: decision.id,
                taskId: record.taskId,
                projectId: record.projectId,
                document: decision,
              })
              .run()
          if (record.startedAt && record.phase !== 'archived')
            this.workspace.setWorkflowStatus(
              record,
              record.phase === 'completed' || record.phase === 'integrating'
                ? 'done'
                : 'doing',
            )
          this.db
            .update(workspaceMeta)
            .set({ revision: sql`${workspaceMeta.revision} + 1` })
            .where(eq(workspaceMeta.id, 1))
            .run()
        })
        .immediate()
      this.workspace.notify()
      this.emit(record)
    } finally {
      this.syncing.delete(record.taskId)
    }
  }
  private accepted(record: WorkflowRecord, id: string) {
    const node = record.nodes[id]
    return node?.status === 'completed' && !!node.acceptanceId
  }
  private parents(graph: GraphSnapshot, id: string) {
    return graph.document.edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.source)
  }
  private allParents(record: WorkflowRecord, graph: GraphSnapshot, id: string) {
    const parents = this.parents(graph, id)
    return (
      parents.length > 0 && parents.every((id) => this.accepted(record, id))
    )
  }
  private descendants(graph: GraphSnapshot, roots: string[]) {
    const found = new Set(roots),
      pending = [...roots]
    while (pending.length) {
      const id = pending.pop()!
      for (const edge of graph.document.edges.filter(
        (edge) => edge.source === id,
      ))
        if (!found.has(edge.target)) {
          found.add(edge.target)
          pending.push(edge.target)
        }
    }
    return found
  }
  private invalidate(
    record: WorkflowRecord,
    graph: GraphSnapshot,
    roots: string[],
    reason: string,
  ) {
    for (const id of this.descendants(graph, roots)) {
      const node = record.nodes[id]
      if (!node) continue
      const worked =
        node.runId ||
        node.acceptanceId ||
        [
          'running',
          'awaiting-acceptance',
          'waiting-review',
          'failed',
          'stopped',
          'interrupted',
          'stale',
        ].includes(node.status)
      if (node.status === 'running') node.invalidated = true
      else node.status = worked ? 'stale' : 'pending'
      delete node.acceptanceId
      delete node.acceptedAt
      delete node.acceptedBy
      node.reason = reason
    }
    if (record.integration?.status === 'integrated')
      record.integrationHistory = [
        ...(record.integrationHistory ?? []),
        record.integration,
      ].slice(-50)
    delete record.completedAt
    delete record.completionSnapshot
    delete record.integration
  }
  private complete(node: WorkflowNodeState, by: 'auto' | 'human' | 'system') {
    node.status = 'completed'
    node.acceptanceId = randomUUID()
    node.acceptedAt = now()
    node.acceptedBy = by
    delete node.reason
    delete node.invalidated
    delete node.pendingMessage
  }
  private advance(record: WorkflowRecord, graph: GraphSnapshot) {
    if (
      !record.startedAt ||
      ['paused', 'archived', 'integrating'].includes(record.phase)
    )
      return
    for (const id of graph.validation.topologicalOrder) {
      const node = record.nodes[id]
      if (
        !node ||
        [
          'completed',
          'running',
          'awaiting-acceptance',
          'failed',
          'stopped',
          'interrupted',
        ].includes(node.status)
      )
        continue
      if (node.type === 'start') this.complete(node, 'system')
      else if (this.allParents(record, graph, id)) {
        if (node.type === 'review') {
          node.status = 'waiting-review'
          node.reason = 'Requires your approval or request for changes.'
        } else if (node.type === 'end') {
          if (
            Object.values(record.nodes)
              .filter((node) => node.type !== 'end')
              .every((node) => this.accepted(record, node.id))
          ) {
            this.complete(node, 'system')
            record.phase = 'completed'
            record.completedAt = now()
            record.completionSnapshot = record.lastSnapshot
            delete record.error
          }
        } else if (node.status !== 'stale') {
          node.status = 'ready'
          delete node.reason
        }
      } else if (node.status !== 'stale') {
        node.status = 'pending'
        node.reason =
          'Waiting for every predecessor to complete and be accepted.'
      }
    }
    if (
      Object.values(record.nodes).some(
        (node) => node.type === 'end' && this.accepted(record, node.id),
      ) &&
      Object.values(record.nodes).every((node) =>
        this.accepted(record, node.id),
      )
    ) {
      record.phase = 'completed'
      record.completedAt ??= now()
      record.completionSnapshot = record.lastSnapshot
      delete record.error
    }
  }
  private reconcile(identity: GraphIdentity): {
    record: WorkflowRecord
    graph: GraphSnapshot
  } {
    const graph = this.graphs.get({
      projectId: identity.projectId,
      taskId: identity.taskId,
    })
    let record = this.row(identity)
    if (!record) {
      record = this.fresh(graph)
      this.persist(record)
      return { record, graph }
    }
    const signatures = this.signatures(graph),
      before = JSON.stringify(record)
    const changed = graph.document.nodes
      .filter(
        (node) => record!.nodes[node.id]?.signature !== signatures[node.id],
      )
      .map((node) => node.id)
    const removed = Object.keys(record.nodes).filter((id) => !signatures[id])
    if (
      changed.length ||
      removed.length ||
      record.graphRevision !== graph.revision
    ) {
      for (const node of graph.document.nodes)
        if (!record.nodes[node.id])
          record.nodes[node.id] = {
            id: node.id,
            title: node.data.title,
            type: node.type,
            signature: signatures[node.id],
            status: 'pending',
          }
      this.invalidate(
        record,
        graph,
        changed,
        'Configuration or a prerequisite changed. Revalidation is required.',
      )
      for (const id of removed) delete record.nodes[id]
      for (const node of graph.document.nodes) {
        record.nodes[node.id].signature = signatures[node.id]
        record.nodes[node.id].title = node.data.title
        record.nodes[node.id].type = node.type
      }
      record.graphRevision = graph.revision
      if (record.startedAt) {
        record.phase = 'paused'
        record.error = {
          code: 'WORKFLOW_CHANGED',
          message: 'Workflow configuration changed. Scheduling is paused.',
          hint: 'Save a valid graph and explicitly resume to rerun stale nodes. Existing code is retained.',
        }
      }
    }
    if (graph.task.archivedAt) record.phase = 'archived'
    else if (record.phase === 'archived') {
      record.phase = record.completedAt ? 'completed' : 'paused'
      if (!record.completedAt)
        record.error = {
          code: 'WORKFLOW_RESTORED',
          message: 'The task was restored. Resume explicitly to continue.',
          hint: 'Code changes and prior results are retained.',
        }
    }
    if (JSON.stringify(record) !== before) this.persist(record)
    return { record, graph }
  }
  private configurationChanged(identity: GraphIdentity) {
    if (this.syncing.has(identity.taskId) || !this.row(identity)) return
    this.syncing.add(identity.taskId)
    try {
      this.reconcile(identity)
    } catch (error) {
      console.error('Workflow configuration reconciliation failed:', error)
    } finally {
      this.syncing.delete(identity.taskId)
    }
  }
  private snapshot(
    record: WorkflowRecord,
    graph: GraphSnapshot,
  ): WorkflowSnapshot {
    const evidence: WorkflowSnapshot['evidence'] = {}
    for (const node of graph.document.nodes.filter(
      (node) => node.type === 'review',
    )) {
      const ancestors = new Set<string>(),
        pending = this.parents(graph, node.id)
      while (pending.length) {
        const id = pending.pop()!
        if (ancestors.has(id)) continue
        ancestors.add(id)
        pending.push(...this.parents(graph, id))
      }
      evidence[node.id] = [...ancestors].flatMap((id) => {
        const state = record.nodes[id]
        if (state?.type !== 'agent' || !state.runId) return []
        const run = this.execution.getRun({
          projectId: record.projectId,
          taskId: record.taskId,
          nodeId: id,
          runId: state.runId,
        })
        return [
          {
            nodeId: id,
            title: state.title,
            runId: run.id,
            status: state.status,
            summary: run.items
              .filter((item) => item.type === 'agent_message')
              .map((item) => item.text)
              .join('\n')
              .slice(0, 12000),
            checks: run.tests.command ? run.tests.status : 'not configured',
          },
        ]
      })
    }
    return { ...record, summary: summarizeWorkflow(record), evidence }
  }
  get(raw: unknown): WorkflowSnapshot {
    const identity = graphIdentitySchema.parse(raw)
    const { record, graph } = this.reconcile(identity)
    return this.snapshot(record, graph)
  }
  private validate(graph: GraphSnapshot, expectedGraphRevision: number) {
    if (graph.revision !== expectedGraphRevision)
      throw new ApplicationError(
        'STALE_GRAPH',
        'The graph changed before this workflow action.',
        'Reload the saved graph and retry.',
      )
    if (!graph.validation.valid)
      throw new ApplicationError(
        'GRAPH_NOT_READY',
        graph.validation.issues.map((issue) => issue.message).join('\n'),
        'Fix and save the graph before starting or resuming.',
      )
  }
  private activate(
    identity: GraphIdentity,
    expectedGraphRevision: number,
    scheduling: 'automatic' | 'manual',
  ) {
    const { record, graph } = this.reconcile(identity)
    this.validate(graph, expectedGraphRevision)
    if (this.operations.has(identity.projectId))
      throw new ApplicationError(
        'PROJECT_BUSY',
        'Branch integration is active in this project.',
        'Wait for integration to finish.',
      )
    if (record.phase === 'integrating')
      throw new ApplicationError(
        'INTEGRATION_ACTIVE',
        'This task is being integrated.',
        'Wait for integration to finish.',
      )
    record.startedAt ??= now()
    record.scheduling = scheduling
    record.phase = 'running'
    delete record.error
    this.advance(record, graph)
    this.persist(record)
    return { record, graph }
  }
  start(raw: unknown): WorkflowSnapshot {
    const input = workflowStartSchema.parse(raw)
    const { record, graph } = this.activate(
      input,
      input.expectedGraphRevision,
      'automatic',
    )
    this.wake(input.projectId)
    return this.snapshot(record, graph)
  }
  startNode(raw: unknown) {
    const input = startNodeSchema.parse(raw)
    const { record, graph } = this.reconcile(input)
    this.validate(graph, input.expectedGraphRevision)
    if (
      !record.nodes[input.nodeId] ||
      record.nodes[input.nodeId].type !== 'agent'
    )
      throw new ApplicationError(
        'AGENT_NODE_REQUIRED',
        'Only agent task nodes execute Codex.',
        'Select an agent node.',
      )
    // Check before activation so a rejected downstream request cannot start the workflow.
    const draft = structuredClone(record)
    draft.startedAt ??= now()
    draft.phase = 'running'
    this.advance(draft, graph)
    if (!this.allParents(draft, graph, input.nodeId))
      throw new ApplicationError(
        'PREDECESSORS_BLOCKED',
        'Every predecessor must complete and be accepted before this node can run.',
        'Accept successful predecessors or release their human review gates first.',
      )
    if (
      this.execution.activeProject(input.projectId) ||
      this.operations.has(input.projectId)
    )
      throw new ApplicationError(
        'PROJECT_BUSY',
        'Another operation is active in this project.',
        'Wait or stop the active node first.',
      )
    this.activate(input, input.expectedGraphRevision, 'manual')
    return this.execution.start(input)
  }
  private admit(input: StartNodeInput) {
    const { record, graph } = this.reconcile(input)
    if (
      this.stopping ||
      this.operations.has(input.projectId) ||
      !['running', 'completed'].includes(record.phase)
    )
      throw new ApplicationError(
        'WORKFLOW_PAUSED',
        'Start or resume this workflow before running a node.',
        'Use the workflow controls in the graph.',
      )
    if (!this.allParents(record, graph, input.nodeId))
      throw new ApplicationError(
        'PREDECESSORS_BLOCKED',
        'Every predecessor must complete and be accepted.',
        'Inspect the upstream blockers.',
      )
    // An explicit revision may reopen completed work. The started hook revokes
    // this node's and its descendants' acceptance before any new SDK work.
    const dependencyResults = this.parents(graph, input.nodeId).map((id) => {
      const state = record.nodes[id]
      let summary =
        state.type === 'review'
          ? 'Explicitly approved by the human user.'
          : 'Workflow entry completed.'
      if (state.type === 'agent' && state.runId)
        summary = this.execution
          .getRun({
            projectId: record.projectId,
            taskId: record.taskId,
            nodeId: id,
            runId: state.runId,
          })
          .items.filter((item) => item.type === 'agent_message')
          .map((item) => item.text)
          .join('\n')
          .slice(0, 12000)
      return {
        nodeId: id,
        runId: state.runId ?? state.acceptanceId!,
        status: 'completed and accepted',
        summary,
      }
    })
    const selected = graph.document.nodes.find(
      (node) => node.id === input.nodeId,
    )
    return {
      dependencyResults,
      ...(record.nodes[input.nodeId]?.pendingMessage &&
      selected?.type === 'agent' &&
      input.mode !== 'followup'
        ? {
            prompt: `${selected.data.prompt}\n\nHuman revision request:\n${record.nodes[input.nodeId].pendingMessage}`,
          }
        : {}),
    }
  }
  private started(run: NodeRun) {
    const { record, graph } = this.reconcile(run)
    this.invalidate(
      record,
      graph,
      [run.nodeId],
      'A prerequisite is being revised; its earlier acceptance is stale.',
    )
    const node = record.nodes[run.nodeId]
    node.status = 'running'
    node.runId = run.id
    delete node.invalidated
    delete node.reason
    delete node.pendingMessage
    record.phase = 'running'
    delete record.error
    this.persist(record)
  }
  private settled(run: NodeRun) {
    const { record, graph } = this.reconcile(run),
      node = record.nodes[run.nodeId]
    if (!node || node.runId !== run.id) {
      this.wake(run.projectId)
      return
    }
    if (run.changes) record.lastSnapshot = run.changes.after
    if (node.invalidated) {
      node.status = 'stale'
      delete node.invalidated
      node.reason =
        'Configuration changed during this attempt. Resume to run the current settings.'
      record.phase = 'paused'
    } else if (
      run.status === 'completed' &&
      !run.error &&
      !run.inspectionError &&
      (run.tests.status === 'passed' ||
        (!run.tests.command && run.tests.status === 'not-run'))
    ) {
      if (run.nodeSnapshot.data.acceptance === 'auto')
        this.complete(node, 'auto')
      else {
        node.status = 'awaiting-acceptance'
        node.reason = 'Successful result requires your acceptance.'
      }
    } else {
      node.status =
        run.status === 'cancelled'
          ? 'stopped'
          : run.status === 'interrupted'
            ? 'interrupted'
            : 'failed'
      node.reason =
        run.error?.message ??
        'The attempt stopped before successful completion.'
      if (!['paused', 'archived'].includes(record.phase))
        record.phase = 'blocked'
    }
    if (record.phase !== 'archived') this.advance(record, graph)
    this.waitForManualChoice(record)
    this.persist(record)
    this.wake(run.projectId)
  }
  private human(origin?: HumanOrigin) {
    if (origin !== 'desktop-human')
      throw new ApplicationError(
        'HUMAN_ONLY',
        'Only an explicit human action can accept results or release a human review gate.',
        'Use the desktop acceptance or review controls. Agent and manager requests cannot approve work.',
      )
  }
  private waitForManualChoice(record: WorkflowRecord) {
    if (
      record.scheduling === 'manual' &&
      record.phase === 'running' &&
      !Object.values(record.nodes).some((node) => node.status === 'running')
    )
      record.phase = 'waiting'
  }
  private version(record: WorkflowRecord, expected: number) {
    if (record.revision !== expected)
      throw new ApplicationError(
        'STALE_WORKFLOW',
        'The workflow changed before this decision.',
        'Refresh and inspect the current results before deciding again.',
      )
  }
  accept(raw: unknown, origin?: HumanOrigin) {
    this.human(origin)
    const input = acceptNodeSchema.parse(raw),
      { record, graph } = this.reconcile(input)
    this.version(record, input.expectedRevision)
    const node = record.nodes[input.nodeId]
    if (
      graph.task.archivedAt ||
      node?.type !== 'agent' ||
      node.status !== 'awaiting-acceptance' ||
      node.runId !== input.runId ||
      !this.allParents(record, graph, node.id)
    )
      throw new ApplicationError(
        'ACCEPTANCE_UNAVAILABLE',
        'This result is no longer awaiting acceptance or its prerequisites changed.',
        'Inspect the latest node result.',
      )
    const run = this.execution.getRun({
      projectId: input.projectId,
      taskId: input.taskId,
      nodeId: input.nodeId,
      runId: input.runId,
    })
    if (run.status !== 'completed' || run.error || run.inspectionError)
      throw new ApplicationError(
        'RUN_NOT_SUCCESSFUL',
        'Only successful results can be accepted.',
        'Retry the failed or interrupted attempt first.',
      )
    this.complete(node, 'human')
    if (record.phase === 'waiting') record.phase = 'running'
    this.advance(record, graph)
    this.waitForManualChoice(record)
    this.persist(record, {
      ...input,
      id: randomUUID(),
      action: 'accept',
      actor: 'human',
      note: '',
      at: now(),
    })
    this.wake(input.projectId)
    return this.snapshot(record, graph)
  }
  review(raw: unknown, origin?: HumanOrigin) {
    this.human(origin)
    const input = reviewNodeSchema.parse(raw),
      { record, graph } = this.reconcile(input)
    this.version(record, input.expectedRevision)
    const node = record.nodes[input.nodeId]
    if (
      graph.task.archivedAt ||
      node?.type !== 'review' ||
      node.status !== 'waiting-review' ||
      !this.allParents(record, graph, node.id)
    )
      throw new ApplicationError(
        'REVIEW_UNAVAILABLE',
        'This review is not ready or its prerequisites changed.',
        'Wait for every predecessor to complete and be accepted.',
      )
    if (input.decision === 'approve') this.complete(node, 'human')
    else {
      const evidence = this.snapshot(record, graph).evidence[node.id]
      if (
        !input.note ||
        !input.targetNodeId ||
        !evidence.some(
          (item) =>
            item.nodeId === input.targetNodeId &&
            record.nodes[item.nodeId].status === 'completed',
        )
      )
        throw new ApplicationError(
          'REVISION_TARGET',
          'Choose an accepted upstream agent and describe the requested changes.',
          'The revision will continue that agent conversation and invalidate downstream acceptance.',
        )
      this.invalidate(
        record,
        graph,
        [input.targetNodeId],
        `Changes requested by the human reviewer: ${input.note}`,
      )
      record.nodes[input.targetNodeId].pendingMessage = input.note
      record.phase = 'running'
    }
    if (record.phase === 'waiting') record.phase = 'running'
    this.advance(record, graph)
    this.waitForManualChoice(record)
    this.persist(record, {
      ...input,
      id: randomUUID(),
      action: input.decision,
      actor: 'human',
      note: input.note,
      at: now(),
    })
    if (input.decision === 'changes' && record.scheduling === 'manual') {
      const history = this.execution.get({
        projectId: input.projectId,
        taskId: input.taskId,
        nodeId: input.targetNodeId!,
      })
      this.startNode({
        projectId: input.projectId,
        taskId: input.taskId,
        nodeId: input.targetNodeId!,
        expectedGraphRevision: graph.revision,
        mode: history.threadId
          ? 'followup'
          : history.runs.length
            ? 'restart'
            : 'run',
        ...(history.threadId ? { message: input.note } : {}),
      })
      return this.get({ projectId: input.projectId, taskId: input.taskId })
    }
    this.wake(input.projectId)
    return this.snapshot(record, graph)
  }
  async pause(raw: unknown) {
    const identity = graphIdentitySchema.parse(raw),
      { record } = this.reconcile(identity)
    if (record.phase === 'integrating')
      throw new ApplicationError(
        'INTEGRATION_ACTIVE',
        'Wait for branch integration to settle.',
        'Integration cannot be interrupted by starting code work.',
      )
    record.phase = 'paused'
    this.persist(record)
    await this.execution.stopTask(identity)
    return this.get(identity)
  }
  async archive(identity: GraphIdentity) {
    if (this.operations.has(identity.projectId))
      throw new ApplicationError(
        'INTEGRATION_ACTIVE',
        'Wait for integration before archiving this task.',
        'Your task and code are retained.',
      )
    const { record } = this.reconcile(identity)
    if (record.startedAt && record.phase !== 'completed')
      record.phase = 'paused'
    this.persist(record)
    await this.execution.stopTask(identity)
  }
  private integrationContext(
    identity: GraphIdentity,
    expectedRevision: number,
  ) {
    const { record, graph } = this.reconcile(identity)
    this.version(record, expectedRevision)
    if (
      record.phase !== 'completed' ||
      graph.task.archivedAt ||
      !record.completionSnapshot ||
      !Object.values(record.nodes).every((node) =>
        this.accepted(record, node.id),
      )
    )
      throw new ApplicationError(
        'INTEGRATION_NOT_READY',
        'The workflow must reach End with accepted code before integration.',
        'Complete and accept all required work. Restore an archived task before integration.',
      )
    const worktree = this.execution.worktrees.get(identity.taskId)
    if (!worktree)
      throw new ApplicationError(
        'WORKTREE_MISSING',
        'There is no task worktree to integrate.',
        'Run an agent node to create code changes first.',
      )
    return { record, graph, worktree }
  }
  private reserve(projectId: string) {
    if (
      this.operations.has(projectId) ||
      this.execution.activeProject(projectId)
    )
      throw new ApplicationError(
        'PROJECT_BUSY',
        'A node or integration operation is active in this project.',
        'Wait until it settles before integrating.',
      )
    this.operations.add(projectId)
  }
  async previewIntegration(raw: unknown): Promise<IntegrationPlan> {
    const input = integrationPreviewSchema.parse(raw),
      { record, graph, worktree } = this.integrationContext(
        input,
        input.expectedRevision,
      )
    if (record.integration?.status === 'integrated')
      return { ...record.integration, workflowRevision: record.revision }
    this.reserve(input.projectId)
    try {
      const integration = new BranchIntegrationService(this.execution.worktrees)
      let plan: IntegrationPlan
      try {
        plan = await integration.preview(
          graph.project,
          worktree,
          record.completionSnapshot!,
          record.revision,
        )
      } catch (error) {
        plan = {
          status: 'failed',
          workflowRevision: record.revision,
          targetBranch: null,
          targetHead: null,
          conflicts: [],
          message: applicationFailure(error).message,
          checkedAt: now(),
        }
      }
      const current = this.reconcile(input).record
      this.version(current, record.revision)
      plan.workflowRevision = current.revision + 1
      current.integration = plan
      this.persist(current)
      return plan
    } finally {
      this.operations.delete(input.projectId)
      this.wake(input.projectId)
    }
  }
  async integrate(
    raw: unknown,
    origin?: HumanOrigin,
  ): Promise<IntegrationPlan> {
    this.human(origin)
    const input = integrationApplySchema.parse(raw),
      { record, graph, worktree } = this.integrationContext(
        input,
        input.expectedRevision,
      )
    if (record.integration?.status === 'integrated') return record.integration
    this.reserve(input.projectId)
    record.phase = 'integrating'
    this.persist(record)
    const integratingRevision = record.revision
    try {
      const integration = new BranchIntegrationService(this.execution.worktrees)
      const plan = await integration.apply(
        graph.project,
        worktree,
        record.completionSnapshot!,
        input,
        record.revision,
        () => {
          const current = this.reconcile(input).record
          if (
            current.revision !== integratingRevision ||
            current.phase !== 'integrating'
          )
            throw new ApplicationError(
              'INTEGRATION_CHANGED',
              'Workflow configuration changed during integration.',
              'Review the workflow and preview again before integrating.',
            )
        },
      )
      const current = this.row(input)!
      plan.workflowRevision = current.revision + 1
      current.integration = plan
      if (current.phase === 'integrating') current.phase = 'completed'
      this.persist(current)
      plan.workflowRevision = current.revision
      return plan
    } catch (error) {
      const current = this.row(input)!,
        failure = applicationFailure(error)
      if (current.phase === 'integrating') current.phase = 'completed'
      current.integration = {
        status: 'failed',
        workflowRevision: current.revision + 1,
        targetBranch: input.targetBranch,
        targetHead: input.targetHead,
        conflicts: [],
        message: failure.message,
        checkedAt: now(),
      }
      this.persist(current)
      return { ...current.integration, workflowRevision: current.revision }
    } finally {
      this.operations.delete(input.projectId)
      this.wake(input.projectId)
    }
  }
  private wake(projectId: string) {
    if (this.stopping || this.pumping.has(projectId)) return
    const promise = Promise.resolve()
      .then(() => this.pump(projectId))
      .catch((error) => {
        for (const row of this.db
          .select()
          .from(workflows)
          .where(eq(workflows.projectId, projectId))
          .all())
          if (row.document.phase === 'running') {
            const record = row.document
            record.phase = 'blocked'
            record.error = applicationFailure(error)
            this.persist(record)
          }
      })
      .finally(() => this.pumping.delete(projectId))
    this.pumping.set(projectId, promise)
  }
  private pump(projectId: string) {
    if (
      this.stopping ||
      this.operations.has(projectId) ||
      this.execution.activeProject(projectId)
    )
      return
    for (const row of this.db
      .select()
      .from(workflows)
      .where(eq(workflows.projectId, projectId))
      .all()
      .sort((a, b) =>
        (a.document.startedAt ?? '').localeCompare(b.document.startedAt ?? ''),
      )) {
      let { record, graph } = this.reconcile(row.document)
      if (record.scheduling === 'manual') continue
      if (!['running', 'waiting'].includes(record.phase)) continue
      if (!graph.validation.valid) {
        record.phase = 'blocked'
        record.error = {
          code: 'GRAPH_NOT_READY',
          message: graph.validation.issues
            .map((issue) => issue.message)
            .join('\n'),
          hint: 'Fix the graph and resume explicitly.',
        }
        this.persist(record)
        continue
      }
      this.advance(record, graph)
      if (record.phase === 'completed') {
        this.persist(record)
        continue
      }
      const failed = Object.values(record.nodes).some((node) =>
        ['failed', 'stopped', 'interrupted'].includes(node.status),
      )
      if (failed) {
        record.phase = 'blocked'
        this.persist(record)
        continue
      }
      const next = graph.validation.topologicalOrder
        .map((id) => record.nodes[id])
        .find(
          (node) =>
            node?.type === 'agent' &&
            ['ready', 'stale'].includes(node.status) &&
            this.allParents(record, graph, node.id),
        )
      if (!next) {
        record.phase = 'waiting'
        this.persist(record)
        continue
      }
      record.phase = 'running'
      this.persist(record)
      const history = this.execution.get({
          projectId,
          taskId: record.taskId,
          nodeId: next.id,
        }),
        last = history.runs.at(-1)
      const mode =
        next.pendingMessage && history.threadId
          ? 'followup'
          : last
            ? 'restart'
            : 'run'
      this.execution.start({
        projectId,
        taskId: record.taskId,
        nodeId: next.id,
        expectedGraphRevision: graph.revision,
        mode,
        ...(mode === 'followup' ? { message: next.pendingMessage } : {}),
      })
      return
    }
  }
  async initialize() {
    for (const row of this.db.select().from(workflows).all()) {
      const record = row.document
      if (record.phase === 'integrating') {
        record.phase = 'completed'
        record.integration = {
          ...record.integration!,
          status: 'interrupted',
          message:
            'The app closed during integration. Inspect the project branch before retrying.',
          checkedAt: now(),
        }
      } else if (['running', 'waiting'].includes(record.phase)) {
        record.phase = 'paused'
        record.error = {
          code: 'WORKFLOW_INTERRUPTED',
          message: 'Workflow recovery is paused. No work was rerun.',
          hint: 'Review results and resume explicitly. Interrupted nodes need an explicit retry.',
        }
      }
      for (const node of Object.values(record.nodes))
        if (node.status === 'running') {
          node.status = 'interrupted'
          node.reason = 'The app closed during this attempt.'
        }
      this.persist(record)
      this.configurationChanged(record)
    }
  }
  async waitForIdle() {
    await Promise.all([...this.pumping.values()])
    await this.execution.waitForIdle()
    await Promise.all([...this.pumping.values()])
  }
  async shutdown() {
    this.stopping = true
    await Promise.all([...this.pumping.values()])
    await this.execution.shutdown()
  }
}
