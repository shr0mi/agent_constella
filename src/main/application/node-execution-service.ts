import type { AgentClient, ThreadEvent, ThreadOptions } from '../terminal/types'
import { NativeCliClient } from '../terminal/client'
import { terminalHost } from '../terminal/host'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { WorkspaceDatabase } from '../db/database'
import {
  nodeRuns,
  nodeThreads,
  projects,
  tasks,
  taskGraphs,
  workflows,
} from '../db/schema'
import { toActivity } from '../codex/service'
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
  type NodeSession,
  type StartNodeInput,
} from '../../shared/execution'
import { graphIdentitySchema, type GraphIdentity } from '../../shared/graph'
import type {
  TaskExecutionSnapshot,
  TaskReviewContext,
} from '../../shared/execution'
import { taskGit, TaskWorktreeService } from './task-worktrees'
import { runChecks } from './run-checks'
import { z } from 'zod'
import { terminalAttentionLabel, type TerminalAttention } from '../../shared/terminal'
import { launchIde, ideArguments, effectiveIdeCommand } from './ide-launcher'

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
  private mcpConnection?: (
    identity: GraphIdentity & { taskId: string; nodeId: string },
  ) => {
    client: AgentClient
    release: () => void
  }
  setMcpConnection(
    connect: NonNullable<NodeExecutionService['mcpConnection']>,
  ) {
    this.mcpConnection = connect
  }
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
    const run = [...this.active.values()].find(
      (active) => active.run.projectId === projectId,
    )?.run
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
  activeRuns(projectId: string, taskId?: string) {
    return [...this.active.values()]
      .map(({ run }) => run)
      .filter(
        (run) =>
          run.projectId === projectId && (!taskId || run.taskId === taskId),
      )
      .map((run) => ({
        projectId,
        taskId: run.taskId,
        nodeId: run.nodeId,
        runId: run.id,
        status: run.status,
      }))
  }
  hasCapacity(projectId: string) {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    return this.activeRuns(projectId).length < (project?.maxParallelAgents ?? 4)
  }
  private assertTaskDependencies(projectId: string, taskId: string) {
    const task = this.taskScope({ projectId, taskId })
    const commits: Record<string, string> = {}
    for (const id of task.dependencyIds ?? []) {
      const result = this.db
        .select()
        .from(workflows)
        .where(eq(workflows.taskId, id))
        .get()?.document
      if (
        result?.phase !== 'completed' ||
        result.integration?.status !== 'integrated' ||
        !result.integration.commit
      ) {
        const dependency = this.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, id))
          .get()
        throw new ApplicationError(
          'TASK_DEPENDENCIES',
          `Waiting for “${dependency?.title ?? id}” to be integrated.`,
          'Integrate the prerequisite task before starting this agent.',
        )
      }
      commits[id] = result.integration.commit
    }
    return commits
  }
  assertRunDependencies(run: NodeRun) {
    const current = this.assertTaskDependencies(run.projectId, run.taskId)
    if (
      JSON.stringify(current) !==
      JSON.stringify(run.todoDependencyCommits ?? {})
    )
      throw new ApplicationError(
        'TASK_DEPENDENCIES_CHANGED',
        'A todo prerequisite changed after this attempt was prepared.',
        'Run a revision with the current integrated prerequisite before accepting or integrating this result.',
      )
  }
  readonly worktrees: TaskWorktreeService
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly graphs: GraphService,
    private readonly catalog: CatalogService,
    appData: string,
    private readonly client: AgentClient = new NativeCliClient(),
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
    return this.activeRuns(identity.projectId, identity.taskId).length > 0
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
  listSessions(): NodeSession[] {
    // Fetch only the latest attempt per node, without loading transcripts.
    const rows = this.db
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        taskId: tasks.id,
        projectId: projects.id,
        projectName: projects.name,
        taskTitle: tasks.title,
        graph: taskGraphs.document,
        workflow: workflows.document,
        status: sql<NodeRun['status']>`json_extract(${nodeRuns.document}, '$.status')`,
        attention: sql<TerminalAttention | null>`json_extract(${nodeRuns.document}, '$.attention')`,
        updatedAt: sql<string>`coalesce(json_extract(${nodeRuns.document}, '$.finishedAt'), ${nodeRuns.startedAt})`,
      })
      .from(nodeRuns)
      .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(taskGraphs, eq(taskGraphs.taskId, tasks.id))
      .leftJoin(workflows, eq(workflows.taskId, tasks.id))
      .where(
        sql`${tasks.archivedAt} is null and ${nodeRuns.id} in (
          select id from node_runs where rowid in (
            select max(rowid) from node_runs group by node_id
          )
        )`,
      )
      .all()
    const sessions: NodeSession[] = []
    const runningLabels: Partial<Record<NodeRun['status'], string>> = {
      preparing: 'Preparing',
      testing: 'Running checks',
      stopping: 'Stopping',
    }
    for (const row of rows) {
      const node = row.graph.nodes.find((node) => node.id === row.nodeId)
      if (node?.type !== 'agent') continue
      const run = this.active.get(row.nodeId)?.run ?? this.volatile.get(row.id)
      const status = run?.status ?? row.status
      const attention = status === 'running' ? (run ? run.attention : row.attention) : undefined
      const workflowNode = row.workflow?.nodes[row.nodeId]
      const completed = status === 'completed'
      const accepted =
        workflowNode?.status === 'completed' &&
        workflowNode.runId === row.id &&
        !!workflowNode.acceptanceId
      const state = attention
        ? 'attention'
        : isActiveNodeRun(status)
          ? 'running'
          : completed && accepted
            ? 'done'
            : 'attention'
      const detail =
        attention
          ? terminalAttentionLabel[attention]
          : state === 'done'
            ? 'Done'
            : state === 'running'
              ? (runningLabels[status] ?? 'Running')
              : completed
                ? workflowNode?.status === 'failed'
                  ? 'Checks failed'
                  : workflowNode?.status === 'stale'
                    ? 'Stale result'
                    : 'Awaiting acceptance'
                : status === 'cancelled'
                  ? 'Stopped'
                  : status[0].toUpperCase() + status.slice(1)
      sessions.push({
        projectId: row.projectId,
        taskId: row.taskId,
        nodeId: row.nodeId,
        title: node.data.title || 'Untitled node',
        projectName: row.projectName,
        taskTitle: row.taskTitle,
        state,
        detail,
        updatedAt: run?.finishedAt ?? row.updatedAt,
      })
    }
    const priority = { attention: 0, running: 1, done: 2 }
    sessions.sort(
      (a, b) =>
        priority[a.state] - priority[b.state] ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.nodeId.localeCompare(b.nodeId),
    )
    let recent = 0
    return sessions.filter((session) => session.state !== 'done' || recent++ < 8)
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
        attention: sql<TerminalAttention | null>`json_extract(${nodeRuns.document}, '$.attention')`,
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
          attention: (this.active.get(row.nodeId)?.run ?? this.volatile.get(row.id))?.attention ?? row.attention ?? undefined,
        })
    const active = [...this.active.values()].find(
      ({ run }) =>
        run.projectId === identity.projectId && run.taskId === identity.taskId,
    )?.run
    return {
      ...identity,
      worktree: this.worktrees.get(identity.taskId),
      nodeStates: [...latest.values()],
      activeRuns: this.activeRuns(identity.projectId, identity.taskId),
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
  async getReview(raw: unknown): Promise<TaskReviewContext> {
    const identity = graphIdentitySchema.parse(raw)
    const task = this.taskScope(identity)
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, identity.projectId))
      .get()!
    const worktree = await this.worktrees.adopt(project, task)
    if (!worktree || worktree.state !== 'ready')
      throw new ApplicationError(
        'TASK_REVIEW_UNAVAILABLE',
        'The task branch is not ready yet.',
        'Use Open in IDE to create the task workspace, or run an agent node first.',
      )
    if (worktree.projectId !== identity.projectId)
      throw new ApplicationError(
        'TASK_REVIEW_SCOPE',
        'This task branch belongs to another project.',
        'Open the task from its project board.',
      )
    await this.worktrees.verify(worktree, project.repoPath, false)
    const projectBranch = await taskGit(project.repoPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
      .then((value) => value.trim())
      .catch(() => null)
    const devCommand = project.devCommand.trim()
    const quotedPath =
      process.platform === 'win32'
        ? `'${worktree.path.replaceAll("'", "''")}'`
        : `'${worktree.path.replaceAll("'", "'\\''")}'`
    const checkoutCommand =
      process.platform === 'win32'
        ? `Set-Location -LiteralPath ${quotedPath} -ErrorAction Stop`
        : `cd -- ${quotedPath}`
    const runCommand = !devCommand
      ? null
      : process.platform === 'win32'
        ? `& {\n${checkoutCommand}\n${devCommand}\n}`
        : `${checkoutCommand} && (\n${devCommand}\n)`
    return {
      ...identity,
      taskTitle: task.title,
      path: worktree.path,
      branch: worktree.branch,
      projectPath: project.repoPath,
      projectBranch,
      devCommand,
      ideCommand: project.ideCommand,
      runCommand,
      active: this.hasActiveTask(identity),
      targetBranch: worktree.sourceBranch,
      checkoutCommand,
    }
  }
  async checkoutTask(raw: unknown) {
    const identity = graphIdentitySchema.parse(raw)
    const task = this.taskScope(identity)
    if (this.hasActiveTask(identity))
      throw new ApplicationError(
        'PROJECT_BUSY',
        'An agent is working in this project.',
        'Wait for it to finish before switching branches.',
      )
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, identity.projectId))
      .get()!
    await this.worktrees.ensure(project, task, undefined, {
      preserveLocalChanges: true,
    })
    this.emit(identity)
  }
  async openInIde(raw: unknown, launch: typeof launchIde = launchIde) {
    const identity = graphIdentitySchema
      .extend({ nodeId: z.uuid().optional() })
      .strict()
      .parse(raw)
    const task = this.taskScope(identity)
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, identity.projectId))
      .get()!
    ideArguments(effectiveIdeCommand(project.ideCommand))
    if (identity.nodeId) this.get({ ...identity, nodeId: identity.nodeId })
    const agentWorkspace = identity.nodeId
      ? this.worktrees.getNode(identity.nodeId)
      : null
    const workspace =
      agentWorkspace ??
      this.worktrees.get(task.id) ??
      (await this.worktrees.ensure(project, task))
    // Opening the IDE must remain available for restoring an externally changed branch.
    await this.worktrees.verify(workspace, project.repoPath, false)
    await launch(project.ideCommand, workspace.path)
    this.emit(identity)
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
        'Select an agent task node to open an agent terminal.',
        'Start, End, and Human Review do not execute agent sessions.',
      )
    const active = this.active.get(identity.nodeId)?.run
    return {
      ...identity,
      worktree:
        this.worktrees.getNode(identity.nodeId) ??
        this.worktrees.get(identity.taskId),
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
    return this.worktrees.diff(
      this.worktrees.get(input.taskId) ?? run.worktree,
      run.changes,
      input.path,
    )
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
        if (
          this.client instanceof NativeCliClient &&
          run.threadId?.startsWith('terminal:') &&
          run.status === 'running'
        ) {
          const live = (await terminalHost().list()).find(
            (session) =>
              session.id === run.threadId!.slice(9) &&
              session.state !== 'exited',
          )
          if (live) {
            this.active.set(run.nodeId, {
              run,
              controller: new AbortController(),
            })
            continue
          }
        }
        run.status = 'interrupted'
        run.finishedAt = new Date().toISOString()
        run.error = {
          code: 'INTERRUPTED',
          message: 'The app closed while this attempt was active.',
          hint: 'Inspect the project branch and explicitly retry or continue the saved conversation.',
        }
        if (run.tests.status === 'running') run.tests.status = 'cancelled'
        this.persist(run)
        if (run.before && run.worktree) {
          try {
            run.changes = await this.worktrees.changes(
              run.worktree,
              run.before,
              false,
            )
          } catch (error) {
            run.inspectionError = applicationFailure(error)
          }
          this.persist(run)
        }
      }
    this.initialized = true
  }
  reconnect() {
    for (const active of this.active.values()) {
      if (active.done) continue
      active.done = this.execute(active, true).finally(() => {
        this.active.delete(active.run.nodeId)
        if (active.controller.signal.reason !== 'detach')
          this.hooks?.settled(structuredClone(active.run))
        this.emit(active.run)
      })
    }
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
        'Restore app data access and restart before starting more work. Your project files are retained.',
      )
    if (this.active.has(input.nodeId) || !this.hasCapacity(input.projectId))
      throw new ApplicationError(
        'PROJECT_BUSY',
        'This agent is active or the project’s parallel agent limit has been reached.',
        'Stop an agent, wait for a slot, or increase the limit in Project settings.',
      )
    const todoDependencyCommits = this.assertTaskDependencies(
      input.projectId,
      input.taskId,
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
        'A follow-up needs a message and an existing agent session.',
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
      },
      nodeSnapshot: structuredClone(node),
      taskSnapshot: graph.task,
      projectContext: graph.project,
      dependencyResults: [],
      todoDependencyCommits,
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
    this.active.set(input.nodeId, active)
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
      this.active.delete(input.nodeId)
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
      if (this.active.get(input.nodeId) === active)
        this.active.delete(input.nodeId)
      try {
        if (active.controller.signal.reason !== 'detach')
          this.hooks?.settled(structuredClone(run))
      } catch (error) {
        this.persistenceError = applicationFailure(error)
      }
      this.emit(input)
    })
    return { runId: run.id }
  }
  private async execute(active: Active, recovering = false) {
    const { run, controller } = active,
      signal = controller.signal
    let streamCompleted = false
    let releaseMcp: (() => void) | undefined
    try {
      if (!recovering) {
        await this.graphs.prepareStart({
          projectId: run.projectId,
          taskId: run.taskId,
          expectedRevision: run.graphRevision,
        })
        signal.throwIfAborted()
        this.assertRunDependencies(run)
        run.worktree = await this.worktrees.ensureNode(
          run.projectContext,
          run.taskSnapshot,
          run.nodeId,
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
        const context = `Task: ${run.taskSnapshot.title}\n${run.taskSnapshot.description}\n\nTask acceptance criteria:\n${run.taskSnapshot.acceptanceCriteria}\n\nNode: ${run.nodeSnapshot.data.title}\nNode acceptance criteria:\n${run.nodeSnapshot.data.acceptanceCriteria}\nGraph revision: ${run.graphRevision}\n\nAvailable predecessor results (context only; acceptance is managed separately):\n${JSON.stringify(run.dependencyResults)}\n\nThis is an explicitly requested node attempt. Do not run or approve other workflow nodes. When this assignment is complete, call the agent_report_done MCP tool as your LAST tool with a summary of changes and checks. Stop editing after handing it back. If you need input or cannot finish, ask in the terminal and do not report done. Read applicable AGENTS.md/README guidance in this worktree.\n\n${run.mode === 'retry' ? 'The previous attempt did not succeed. Inspect the current files and correct the problem; earlier partial changes are retained.\n' : ''}User request:\n${run.prompt}`
        const requiredInputs = await this.requiredInputs(run)
        run.resolvedPrompt = resolvePrompt(
          `${context}\n\nRequired input files (verified in this workspace):\n${requiredInputs}\n\nPrevious attempt and test results:\n${JSON.stringify(run.previousAttempt ?? null)}`,
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
      }
      const options: ThreadOptions = {
        role: 'worker',
        workingDirectory: run.worktree!.path,
        provider: run.projectContext.defaultProvider ?? 'codex',
        title: `${run.taskSnapshot.title} / ${run.nodeSnapshot.data.title}`,
        attachOnly: recovering,
        model: run.options.model ?? undefined,
        modelReasoningEffort: run.options.effort ?? undefined,
      }
      const connection = this.mcpConnection?.({
        projectId: run.projectId,
        taskId: run.taskId,
        nodeId: run.nodeId,
      })
      releaseMcp = connection?.release
      const client = connection?.client ?? this.client
      const thread = run.threadId
        ? client.resumeThread(run.threadId, options)
        : client.startThread(options)
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
        if (signal.reason !== 'detach') run.status = 'cancelled'
        return
      }
      if (!streamCompleted)
        throw new Error(
          'The agent terminal ended without handing back its result.',
        )
      this.assertRunDependencies(run)
      run.status = 'testing'
      delete run.attention
      this.persist(run)
      run.tests = await runChecks(
        run.tests.command,
        run.worktree!.path,
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
      releaseMcp?.()
      if (signal.reason === 'detach') return
      if (run.before && run.worktree) {
        try {
          run.changes = await this.worktrees.changes(run.worktree, run.before)
          if (run.status === 'completed' && !signal.aborted) {
            run.status = 'testing'
            this.persist(run)
            await this.worktrees.exclusive(run.taskId, async () => {
              signal.throwIfAborted()
              this.assertRunDependencies(run)
              const result = this.worktrees.get(run.taskId)!
              const merged = await this.worktrees.mergeInto(
                result,
                run.changes!.after.commit,
                `Combine ${run.nodeSnapshot.data.title}`,
              )
              const tree = async (commit: string) =>
                (
                  await taskGit(result.path, ['rev-parse', `${commit}^{tree}`])
                ).trim()
              if (
                (await tree(merged.commit)) !==
                (await tree(run.changes!.after.commit))
              ) {
                run.integrationTests = await runChecks(
                  run.tests.command,
                  result.path,
                  signal,
                  (tests) => {
                    run.integrationTests = tests
                    this.persist(run)
                  },
                  this.checkTimeoutMs,
                )
                if (
                  run.integrationTests.command &&
                  run.integrationTests.status !== 'passed'
                )
                  throw new ApplicationError(
                    'COMBINED_TEST_FAILED',
                    'Checks failed after combining agent results.',
                    'Inspect the combined test output and revise this agent. All branches and files are retained.',
                  )
              }
              await this.worktrees.assertClean(result.path)
              run.taskResult = merged
            })
            run.status = 'completed'
          }
        } catch (error) {
          run.inspectionError = applicationFailure(error)
          if (run.status === 'completed' || run.status === 'testing') {
            run.status = 'failed'
            run.error = run.inspectionError
          }
        }
      }
      if (signal.aborted) run.status = 'cancelled'
      run.finishedAt = new Date().toISOString()
      delete run.attention
      try {
        this.persist(run)
      } catch {
        /* Volatile snapshot and storage error remain visible. */
      }
    }
  }
  private applyEvent(run: NodeRun, event: ThreadEvent) {
    if (event.type === 'turn.started') delete run.attention
    if (event.type === 'terminal.attention') run.attention = event.attention
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
    const active = this.active.get(input.nodeId)
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
    const active = [...this.active.values()].filter(
      ({ run }) =>
        run.projectId === identity.projectId && run.taskId === identity.taskId,
    )
    await Promise.all(
      active.map(async (entry) => {
        await this.stop({ ...identity, nodeId: entry.run.nodeId })
        await entry.done
      }),
    )
  }
  async waitForIdle(projectId?: string) {
    await Promise.all(
      [...this.active.values()]
        .filter(({ run }) => !projectId || run.projectId === projectId)
        .map((active) => active.done),
    )
  }
  hasActiveRuns() {
    return this.active.size > 0
  }
  private async requiredInputs(run: NodeRun) {
    const root = await realpath(run.worktree!.path)
    const contents: string[] = []
    let remaining = 64_000
    for (const file of run.taskSnapshot.requiredFiles ?? []) {
      const path = await realpath(resolve(root, file)).catch(() => null)
      if (!path || !path.startsWith(root + sep) || !(await stat(path)).isFile())
        throw new ApplicationError(
          'MISSING_REQUIRED_INPUT',
          `Required file not found in this agent’s workspace: ${file}`,
          'Integrate the task that supplies this file, or correct the required files in the task editor. Implementation has not started.',
        )
      const info = await stat(path)
      if (info.size <= 32_000 && info.size <= remaining) {
        const text = await readFile(path, 'utf8')
        remaining -= info.size
        contents.push(
          text.includes('\0')
            ? `File: ${file} (binary input verified; inspect the file before implementing)`
            : `File: ${file}\n${text}`,
        )
      } else
        contents.push(
          `File: ${file} (verified; read the full file before implementing)`,
        )
    }
    return contents.join('\n\n') || 'None declared.'
  }
  async shutdown(detach = false) {
    for (const active of this.active.values()) {
      active.controller.abort(detach ? 'detach' : undefined)
      if (!detach) active.run.status = 'stopping'
      try {
        this.persist(active.run)
      } catch {
        /* Recovery will mark persisted active runs interrupted. */
      }
    }
    await this.waitForIdle()
  }
}
