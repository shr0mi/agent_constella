import { Codex, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { WorkspaceDatabase } from '../db/database'
import { nodeRuns, nodeThreads, tasks } from '../db/schema'
import { toActivity, type CodexClient } from '../codex/service'
import { resolvePrompt } from '../codex/skills'
import { applicationFailure, ApplicationError } from './errors'
import type { CatalogService } from './catalog-service'
import type { GraphService } from './graph-service'
import type { Failure } from '../../shared/contracts'
import {
  fileDiffSchema,
  isActiveNodeRun,
  nodeIdentitySchema,
  runIdentitySchema,
  startNodeSchema,
  type NodeIdentity,
  type NodeRun,
  type NodeExecutionSnapshot,
  type StartNodeInput,
} from '../../shared/execution'
import { graphIdentitySchema, type GraphIdentity } from '../../shared/graph'
import type { TaskExecutionSnapshot } from '../../shared/execution'
import { TaskWorktreeService } from './task-worktrees'
import { runChecks } from './run-checks'

interface Active {
  run: NodeRun
  controller: AbortController
  done?: Promise<void>
}
interface ExecutionHooks {
  admit(input: StartNodeInput): {
    dependencyResults: NodeRun['dependencyResults']
    prompt?: string
  }
  started(run: NodeRun): void
  settled(run: NodeRun): void
}
const clip = (text: string, limit = 24_000) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated in app]` : text
export class NodeExecutionService {
  private active = new Map<string, Active>()
  private listeners = new Set<(identity: GraphIdentity) => void>()
  private volatile = new Map<string, NodeRun>()
  private persistenceError?: Failure
  private initialized = false
  private hooks?: ExecutionHooks
  setWorkflowHooks(hooks: ExecutionHooks) {
    this.hooks = hooks
  }
  activeProject(projectId: string) {
    const run = this.active.get(projectId)?.run
    return run
      ? {
          projectId: run.projectId,
          taskId: run.taskId,
          nodeId: run.nodeId,
          runId: run.id,
          status: run.status,
        }
      : null
  }
  readonly worktrees: TaskWorktreeService
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly graphs: GraphService,
    private readonly catalog: CatalogService,
    appData: string,
    private readonly client: CodexClient = new Codex(),
    private readonly checkTimeoutMs = 120_000,
  ) {
    this.worktrees = new TaskWorktreeService(database, appData)
    graphs.setExecutionGuard((identity) => this.hasActiveTask(identity))
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
        console.error('Node execution notification failed:', error)
      }
    }
  }
  hasActiveTask(identity: GraphIdentity) {
    const active = this.active.get(identity.projectId)
    return !!active && active.run.taskId === identity.taskId
  }
  private taskScope(identity: GraphIdentity) {
    const task = this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, identity.taskId),
          eq(tasks.projectId, identity.projectId),
        ),
      )
      .get()
    if (!task)
      throw new ApplicationError(
        'NODE_SCOPE',
        'This node/task does not belong to the selected project.',
        'Open the node from its project board.',
      )
    return task
  }
  private thread(identity: NodeIdentity) {
    const row = this.db
      .select()
      .from(nodeThreads)
      .where(eq(nodeThreads.nodeId, identity.nodeId))
      .get()
    if (
      row &&
      (row.taskId !== identity.taskId || row.projectId !== identity.projectId)
    )
      throw new ApplicationError(
        'NODE_SCOPE',
        'This conversation belongs to another task.',
        'Select a node in the current task.',
      )
    return row
  }
  private history(identity: NodeIdentity): NodeRun[] {
    const saved = this.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.projectId, identity.projectId),
          eq(nodeRuns.taskId, identity.taskId),
          eq(nodeRuns.nodeId, identity.nodeId),
        ),
      )
      .orderBy(desc(sql`rowid`))
      .limit(20)
      .all()
      .map((row) => this.volatile.get(row.id) ?? row.document)
      .reverse()
    return saved
  }
  getTask(raw: unknown): TaskExecutionSnapshot {
    const identity = graphIdentitySchema.parse(raw)
    this.taskScope(identity)
    const latest = new Map<
      string,
      TaskExecutionSnapshot['nodeStates'][number]
    >()
    const rows = this.db
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        status: sql<
          NodeRun['status']
        >`json_extract(${nodeRuns.document}, '$.status')`,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.projectId, identity.projectId),
          eq(nodeRuns.taskId, identity.taskId),
        ),
      )
      .orderBy(desc(sql`rowid`))
      .all()
    for (const row of rows)
      if (!latest.has(row.nodeId))
        latest.set(row.nodeId, {
          nodeId: row.nodeId,
          runId: row.id,
          status: this.volatile.get(row.id)?.status ?? row.status,
        })
    const active = this.active.get(identity.projectId)?.run
    return {
      ...identity,
      worktree: this.worktrees.get(identity.taskId),
      nodeStates: [...latest.values()],
      active: active
        ? {
            projectId: active.projectId,
            taskId: active.taskId,
            nodeId: active.nodeId,
            runId: active.id,
            status: active.status,
          }
        : null,
      persistenceError: this.persistenceError,
    }
  }
  get(raw: unknown): NodeExecutionSnapshot {
    const identity = nodeIdentitySchema.parse(raw)
    this.taskScope(identity)
    const graph = this.graphs.get({
      projectId: identity.projectId,
      taskId: identity.taskId,
    })
    const node = graph.document.nodes.find(
      (node) => node.id === identity.nodeId,
    )
    if (!node || node.type !== 'agent')
      throw new ApplicationError(
        'AGENT_NODE_REQUIRED',
        'Select an agent task node to open a Codex conversation.',
        'Start, End, and Human Review do not execute Codex turns.',
      )
    const active = this.active.get(identity.projectId)?.run
    return {
      ...identity,
      worktree: this.worktrees.get(identity.taskId),
      threadId: this.thread(identity)?.threadId ?? undefined,
      runs: structuredClone(this.history(identity)),
      active: active
        ? {
            projectId: active.projectId,
            taskId: active.taskId,
            nodeId: active.nodeId,
            runId: active.id,
            status: active.status,
          }
        : null,
      persistenceError: this.persistenceError,
    }
  }
  getRun(raw: unknown): NodeRun {
    const input = runIdentitySchema.parse(raw)
    this.taskScope(input)
    const row = this.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.id, input.runId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.projectId, input.projectId),
        ),
      )
      .get()
    if (!row)
      throw new ApplicationError(
        'NODE_RUN_NOT_FOUND',
        'This attempt does not belong to the selected node.',
        'Select a saved attempt in this conversation.',
      )
    return structuredClone(this.volatile.get(row.id) ?? row.document)
  }
  async getDiff(raw: unknown) {
    const input = fileDiffSchema.parse(raw),
      run = this.getRun({
        projectId: input.projectId,
        taskId: input.taskId,
        nodeId: input.nodeId,
        runId: input.runId,
      })
    if (!run.changes || !run.worktree)
      throw new ApplicationError(
        'DIFF_UNAVAILABLE',
        'File snapshots are not available for this attempt yet.',
        'Wait for the run to settle, then inspect its results or collection error.',
      )
    return this.worktrees.diff(run.worktree, run.changes, input.path)
  }
  private persist(run: NodeRun) {
    try {
      this.database.sqlite
        .transaction(() => {
          this.db
            .insert(nodeRuns)
            .values({
              id: run.id,
              nodeId: run.nodeId,
              projectId: run.projectId,
              taskId: run.taskId,
              startedAt: run.startedAt,
              document: run,
            })
            .onConflictDoUpdate({ target: nodeRuns.id, set: { document: run } })
            .run()
          if (run.threadId)
            this.db
              .update(nodeThreads)
              .set({ threadId: run.threadId })
              .where(eq(nodeThreads.nodeId, run.nodeId))
              .run()
        })
        .immediate()
      this.volatile.delete(run.id)
      if (!this.volatile.size) this.persistenceError = undefined
    } catch (error) {
      this.volatile.set(run.id, structuredClone(run))
      this.persistenceError = applicationFailure(error)
      this.emit(run)
      throw error
    }
    this.emit(run)
  }
  async initialize() {
    // Recover only recorded active attempts; never resume a process automatically.
    for (const { document: run } of this.db.select().from(nodeRuns).all())
      if (isActiveNodeRun(run.status)) {
        run.status = 'interrupted'
        run.finishedAt = new Date().toISOString()
        run.error = {
          code: 'INTERRUPTED',
          message: 'The app closed while this attempt was active.',
          hint: 'Inspect the retained worktree and explicitly retry or continue the saved conversation.',
        }
        if (run.tests.status === 'running') run.tests.status = 'cancelled'
        this.persist(run)
        if (run.before && run.worktree) {
          try {
            run.changes = await this.worktrees.changes(run.worktree, run.before)
          } catch (error) {
            run.inspectionError = applicationFailure(error)
          }
          this.persist(run)
        }
      }
    this.initialized = true
  }
  start(raw: unknown): { runId: string } {
    const input = startNodeSchema.parse(raw)
    if (!this.initialized)
      throw new ApplicationError(
        'EXECUTION_STARTING',
        'Node execution is still recovering saved attempts.',
        'Wait for startup recovery to finish.',
      )
    if (this.persistenceError)
      throw new ApplicationError(
        'STORAGE',
        'An attempt could not be persisted.',
        'Restore app data access and restart before starting more work. The current worktree is retained.',
      )
    if (this.active.has(input.projectId))
      throw new ApplicationError(
        'PROJECT_BUSY',
        'Another node is active in this project.',
        'Stop or wait for that attempt before starting more code-writing work.',
      )
    const snapshot = this.get({
      projectId: input.projectId,
      taskId: input.taskId,
      nodeId: input.nodeId,
    })
    const graph = this.graphs.get({
      projectId: input.projectId,
      taskId: input.taskId,
    })
    if (graph.revision !== input.expectedGraphRevision)
      throw new ApplicationError(
        'STALE_GRAPH',
        'The graph changed before this run was requested.',
        'Reload the saved graph before starting work.',
      )
    if (!graph.validation.valid)
      throw new ApplicationError(
        'GRAPH_NOT_READY',
        graph.validation.issues.map((issue) => issue.message).join('\n'),
        'Fix graph settings and assignments, then save before running a node.',
      )
    const node = graph.document.nodes.find((node) => node.id === input.nodeId)!
    if (node.type !== 'agent') throw new Error('Expected agent node')
    const last = snapshot.runs.at(-1)
    if (input.mode === 'followup' && (!input.message || !snapshot.threadId))
      throw new ApplicationError(
        'THREAD_REQUIRED',
        'A follow-up needs a message and an existing Codex thread.',
        'Start this node, or retry an attempt that did not create a thread.',
      )
    if (
      input.mode === 'retry' &&
      (!last || !['failed', 'cancelled', 'interrupted'].includes(last.status))
    )
      throw new ApplicationError(
        'RETRY_UNAVAILABLE',
        'Only a failed, stopped, or interrupted attempt can be retried.',
        'Send a follow-up to request another revision of completed work.',
      )
    if (input.mode === 'run' && last)
      throw new ApplicationError(
        'NODE_ALREADY_STARTED',
        'This node already has attempt history.',
        'Continue its conversation, retry the last attempt, or explicitly start a new conversation.',
      )
    const admission = this.hooks?.admit(input)
    const prompt =
      input.mode === 'followup'
        ? input.message!
        : input.mode === 'retry'
          ? last!.prompt
          : node.data.prompt
    const run: NodeRun = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      nodeId: input.nodeId,
      mode: input.mode,
      graphRevision: graph.revision,
      prompt: admission?.prompt ?? prompt,
      resolvedPrompt: '',
      options: {
        profileId: node.data.profileId ?? undefined,
        skillIds: node.data.skillIds,
        model: node.data.model,
        effort: node.data.effort,
        sandbox: 'workspace-write',
      },
      nodeSnapshot: structuredClone(node),
      taskSnapshot: graph.task,
      projectContext: graph.project,
      dependencyResults: [],
      skillSnapshots: [],
      startedAt: new Date().toISOString(),
      status: 'preparing',
      items: [],
      events: [],
      tests: {
        command: graph.project.testCommand,
        status: 'not-run',
        output: '',
        exitCode: null,
        truncated: false,
      },
      threadId:
        input.mode === 'restart'
          ? undefined
          : input.mode === 'retry'
            ? last?.threadId
            : snapshot.threadId,
    }
    for (const edge of graph.document.edges.filter(
      (edge) => edge.target === node.id,
    )) {
      const previous = this.history({ ...input, nodeId: edge.source }).at(-1)
      if (previous)
        run.dependencyResults.push({
          nodeId: edge.source,
          runId: previous.id,
          status: previous.status,
          summary: clip(
            previous.items
              .filter((item) => item.type === 'agent_message')
              .map((item) => item.text)
              .join('\n'),
            8000,
          ),
        })
    }
    if (admission) run.dependencyResults = admission.dependencyResults
    const active: Active = { run, controller: new AbortController() }
    if (last)
      run.previousAttempt = {
        id: last.id,
        status: last.status,
        error: last.error,
        tests: structuredClone(last.tests),
      }
    this.active.set(input.projectId, active)
    try {
      this.db
        .insert(nodeThreads)
        .values({
          nodeId: input.nodeId,
          taskId: input.taskId,
          projectId: input.projectId,
          threadId: run.threadId ?? null,
        })
        .onConflictDoUpdate({
          target: nodeThreads.nodeId,
          set: { threadId: run.threadId ?? null },
        })
        .run()
      this.persist(run)
      this.hooks?.started(run)
    } catch (error) {
      this.active.delete(input.projectId)
      run.status = 'failed'
      run.finishedAt = new Date().toISOString()
      run.error = applicationFailure(error)
      try {
        this.persist(run)
      } catch {
        /* The storage error is already exposed. */
      }
      throw error
    }
    active.done = this.execute(active).finally(() => {
      if (this.active.get(input.projectId) === active)
        this.active.delete(input.projectId)
      try {
        this.hooks?.settled(structuredClone(run))
      } catch (error) {
        this.persistenceError = applicationFailure(error)
      }
      this.emit(input)
    })
    return { runId: run.id }
  }
  private async execute(active: Active) {
    const { run, controller } = active,
      signal = controller.signal
    let streamCompleted = false
    try {
      await this.graphs.prepareStart({
        projectId: run.projectId,
        taskId: run.taskId,
        expectedRevision: run.graphRevision,
      })
      signal.throwIfAborted()
      run.worktree = await this.worktrees.ensure(
        run.projectContext,
        run.taskSnapshot,
        signal,
      )
      this.persist(run)
      const prepared = await this.catalog.resolveRun(
        { ...run.options, prompt: run.prompt },
        run.worktree.path,
        run.id,
        run.projectId,
        { stageInWorkspace: false },
      )
      run.profileSnapshot = prepared.profileSnapshot
      run.projectSnapshot = prepared.projectSnapshot
      run.skillSnapshots = prepared.skillSnapshots
      run.tests.command =
        prepared.projectSnapshot?.testCommand ?? run.tests.command
      run.options.model = prepared.model
      run.options.effort = prepared.effort
      run.options.skillIds = prepared.skillSnapshots.map((skill) => skill.id)
      const context = `Task: ${run.taskSnapshot.title}\n${run.taskSnapshot.description}\n\nTask acceptance criteria:\n${run.taskSnapshot.acceptanceCriteria}\n\nNode: ${run.nodeSnapshot.data.title}\nNode acceptance criteria:\n${run.nodeSnapshot.data.acceptanceCriteria}\nGraph revision: ${run.graphRevision}\n\nAvailable predecessor results (context only; acceptance is managed separately):\n${JSON.stringify(run.dependencyResults)}\n\nThis is an explicitly requested node attempt. Do not run or approve other workflow nodes. Read applicable AGENTS.md/README guidance in this worktree.\n\n${run.mode === 'retry' ? 'The previous attempt did not succeed. Inspect the current files and correct the problem; earlier partial changes are retained.\n' : ''}User request:\n${run.prompt}`
      run.resolvedPrompt = resolvePrompt(
        `${context}\n\nPrevious attempt and test results:\n${JSON.stringify(run.previousAttempt ?? null)}`,
        run.skillSnapshots,
        prepared,
        'task',
      )
      signal.throwIfAborted()
      run.before = await this.worktrees.capture(
        run.worktree.path,
        `AgentConstella before attempt ${run.id}`,
        signal,
      )
      this.persist(run)
      signal.throwIfAborted()
      const current = this.graphs.get({
        projectId: run.projectId,
        taskId: run.taskId,
      })
      if (current.task.archivedAt || current.revision !== run.graphRevision)
        throw new ApplicationError(
          'RUN_CONTEXT_CHANGED',
          'The task was archived or its graph changed during preparation.',
          'Review the saved graph before retrying.',
        )
      run.status = 'running'
      this.persist(run)
      const options: ThreadOptions = {
        workingDirectory: run.worktree.path,
        skipGitRepoCheck: false,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        model: run.options.model ?? undefined,
        modelReasoningEffort: run.options.effort ?? undefined,
      }
      const thread = run.threadId
        ? this.client.resumeThread(run.threadId, options)
        : this.client.startThread(options)
      const { events } = await thread.runStreamed(run.resolvedPrompt, {
        signal,
      })
      for await (const event of events) {
        this.applyEvent(run, event)
        this.persist(run)
        if (event.type === 'turn.completed') streamCompleted = true
        if (event.type === 'turn.failed') throw new Error(event.error.message)
        if (event.type === 'error') throw new Error(event.message)
      }
      if (signal.aborted) {
        run.status = 'cancelled'
        return
      }
      if (!streamCompleted)
        throw new Error('The SDK stream ended without a turn.completed event.')
      run.status = 'testing'
      this.persist(run)
      run.tests = await runChecks(
        run.tests.command,
        run.worktree.path,
        signal,
        (result) => {
          run.tests = result
          try {
            this.persist(run)
          } catch {
            controller.abort()
          }
        },
        this.checkTimeoutMs,
      )
      if (signal.aborted) run.status = 'cancelled'
      else if (['failed', 'timed-out'].includes(run.tests.status)) {
        run.status = 'failed'
        run.error = {
          code: 'TEST_FAILED',
          message:
            run.tests.status === 'timed-out'
              ? 'The configured test command exceeded its time limit.'
              : `The configured test command exited with ${run.tests.exitCode}.`,
          hint: 'Inspect the test output and request a revision or retry. Partial code changes remain in the task worktree.',
        }
      } else run.status = 'completed'
    } catch (error) {
      run.status = signal.aborted ? 'cancelled' : 'failed'
      if (!signal.aborted) {
        run.error = applicationFailure(error)
        if (run.error.code === 'EXECUTION')
          run.error.hint =
            'Inspect this attempt and diagnostics. Retry or continue the saved node conversation; New conversation explicitly starts a fresh thread while retaining code and history.'
      }
    } finally {
      if (run.before && run.worktree) {
        try {
          run.changes = await this.worktrees.changes(run.worktree, run.before)
        } catch (error) {
          run.inspectionError = applicationFailure(error)
          if (run.status === 'completed') {
            run.status = 'failed'
            run.error = run.inspectionError
          }
        }
      }
      if (signal.aborted) run.status = 'cancelled'
      run.finishedAt = new Date().toISOString()
      try {
        this.persist(run)
      } catch {
        /* Volatile snapshot and storage error remain visible. */
      }
    }
  }
  private applyEvent(run: NodeRun, event: ThreadEvent) {
    run.events.push({
      type: event.type,
      at: new Date().toISOString(),
      detail: clip(JSON.stringify(event)),
    })
    run.events = run.events.slice(-300)
    if (event.type === 'thread.started') run.threadId = event.thread_id
    if ('item' in event) {
      const item = toActivity(event.item),
        index = run.items.findIndex((existing) => existing.id === item.id)
      if (index === -1) run.items.push(item)
      else run.items[index] = item
      run.items = run.items.slice(-500)
    }
    if (event.type === 'turn.completed') run.usage = event.usage
  }
  async stop(raw: unknown): Promise<void> {
    const input = nodeIdentitySchema.parse(raw)
    this.taskScope(input)
    this.thread(input)
    const active = this.active.get(input.projectId)
    if (
      !active ||
      active.run.nodeId !== input.nodeId ||
      active.run.taskId !== input.taskId
    )
      return
    active.controller.abort()
    active.run.status = 'stopping'
    this.persist(active.run)
  }
  async stopTask(identity: GraphIdentity) {
    const active = this.active.get(identity.projectId)
    if (active?.run.taskId === identity.taskId) {
      await this.stop({ ...identity, nodeId: active.run.nodeId })
      await active.done
    }
  }
  async waitForIdle(projectId?: string) {
    if (projectId) await this.active.get(projectId)?.done
    else
      await Promise.all([...this.active.values()].map((active) => active.done))
  }
  async shutdown() {
    for (const active of this.active.values()) {
      active.controller.abort()
      active.run.status = 'stopping'
      try {
        this.persist(active.run)
      } catch {
        /* Recovery will mark persisted active runs interrupted. */
      }
    }
    await this.waitForIdle()
  }
}
