import { and, eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import {
  defaultTaskGraph,
  graphDocumentSchema,
  graphIdentitySchema,
  prepareGraphSchema,
  saveGraphSchema,
  type GraphDocument,
  type GraphIdentity,
  type GraphSnapshot,
  type PreparedGraph,
} from '../../shared/graph'
import { validateGraph } from '../../shared/graph-validation'
import type { ModelOption } from '../../shared/contracts'
import type { WorkspaceDatabase } from '../db/database'
import {
  graphCommands,
  graphRevisions,
  projects,
  taskGraphs,
  tasks,
  workspaceMeta,
} from '../db/schema'
import { ApplicationError } from './errors'
import type { CatalogService } from './catalog-service'

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class GraphService {
  private listeners = new Set<(identity: GraphIdentity) => void>()
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly catalog: CatalogService,
    private readonly models: () => ModelOption[] = () => [],
  ) {}
  private get db() {
    return this.database.db
  }
  subscribe(listener: (identity: GraphIdentity) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private notify(identity: GraphIdentity) {
    this.listeners.forEach((listener) => {
      try {
        listener(identity)
      } catch (error) {
        console.error('Graph notification failed after commit:', error)
      }
    })
  }
  private scope(identity: GraphIdentity) {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, identity.projectId))
      .get()
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
    if (!project || !task)
      throw new ApplicationError(
        'GRAPH_SCOPE',
        'This task does not belong to the selected project or no longer exists.',
        'Open the graph from a task on the selected project board.',
      )
    return { project, task }
  }
  private row(identity: GraphIdentity) {
    const row = this.db
      .select()
      .from(taskGraphs)
      .where(
        and(
          eq(taskGraphs.taskId, identity.taskId),
          eq(taskGraphs.projectId, identity.projectId),
        ),
      )
      .get()
    if (!row)
      throw new ApplicationError(
        'GRAPH_NOT_FOUND',
        'The task graph has not been opened yet.',
        'Open the task graph before editing it.',
      )
    return row
  }
  private fingerprint(identity: GraphIdentity) {
    const { project, task } = this.scope(identity)
    const catalog = this.catalog.getSnapshot({ projectId: identity.projectId })
    return digest({
      project,
      task,
      skills: catalog.skills,
      profiles: catalog.profiles,
      models: this.models(),
    })
  }
  private snapshot(identity: GraphIdentity): GraphSnapshot {
    const { project, task } = this.scope(identity)
    const row = this.row(identity)
    const document = graphDocumentSchema.parse(row.document)
    const validation = validateGraph(document, {
      catalog: this.catalog.getSnapshot({ projectId: identity.projectId }),
      models: this.models(),
      archived: !!task.archivedAt,
    })
    return {
      project,
      task,
      revision: row.revision,
      document,
      validation,
      updatedAt: row.updatedAt,
      prepared:
        validation.valid &&
        row.preparedRevision === row.revision &&
        row.preparedAt &&
        row.preparedFingerprint === this.fingerprint(identity)
          ? { revision: row.revision, at: row.preparedAt }
          : null,
    }
  }
  get(raw: unknown): GraphSnapshot {
    const identity = graphIdentitySchema.parse(raw)
    const { task } = this.scope(identity)
    let created = false
    this.database.sqlite
      .transaction(() => {
        const existing = this.db
          .select()
          .from(taskGraphs)
          .where(eq(taskGraphs.taskId, task.id))
          .get()
        if (existing) return
        const now = new Date().toISOString(),
          document = defaultTaskGraph(task, randomUUID)
        this.db
          .insert(taskGraphs)
          .values({
            ...identity,
            revision: 1,
            document,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        this.db
          .insert(graphRevisions)
          .values({
            ...identity,
            id: randomUUID(),
            revision: 1,
            document,
            createdAt: now,
          })
          .run()
        this.db
          .update(workspaceMeta)
          .set({ revision: sql`${workspaceMeta.revision} + 1` })
          .where(eq(workspaceMeta.id, 1))
          .run()
        created = true
      })
      .immediate()
    if (created) this.notify(identity)
    return this.snapshot(identity)
  }
  save(raw: unknown): GraphSnapshot {
    const input = saveGraphSchema.parse(raw)
    const identity = { projectId: input.projectId, taskId: input.taskId }
    let appliedRevision = 0
    this.database.sqlite
      .transaction(() => {
        const { task } = this.scope(identity)
        if (task.archivedAt)
          throw new ApplicationError(
            'TASK_ARCHIVED',
            'This task is archived and its graph is read-only.',
            'Restore the task before changing its graph.',
          )
        const inputHash = digest(input)
        const previous = this.db
          .select()
          .from(graphCommands)
          .where(eq(graphCommands.id, input.commandId))
          .get()
        if (previous) {
          if (
            previous.taskId !== input.taskId ||
            previous.projectId !== input.projectId ||
            previous.inputHash !== inputHash
          )
            throw new ApplicationError(
              'IDEMPOTENCY_CONFLICT',
              'This graph command ID was already used for a different change.',
              'Retry the edit with a new command ID.',
            )
          appliedRevision = previous.revision
          return
        }
        const row = this.row(identity)
        if (row.revision !== input.expectedRevision)
          throw new ApplicationError(
            'STALE_GRAPH',
            'This graph changed after it was opened.',
            'Your local draft is retained. Reload the saved graph to review newer changes before saving again.',
          )
        const validation = validateGraph(input.document, {
          catalog: this.catalog.getSnapshot({ projectId: input.projectId }),
          models: this.models(),
        })
        if (!validation.canSave)
          throw new ApplicationError(
            'GRAPH_INVALID',
            validation.issues
              .filter((issue) => issue.blocksSave)
              .map((issue) => issue.message)
              .join('\n'),
            'Fix the highlighted connections or assignments before saving. Incomplete connectedness and missing settings can be saved as a draft.',
          )
        const now = new Date().toISOString()
        appliedRevision = row.revision + 1
        this.db
          .update(taskGraphs)
          .set({
            document: input.document,
            revision: appliedRevision,
            preparedRevision: null,
            preparedAt: null,
            preparedFingerprint: null,
            updatedAt: now,
          })
          .where(eq(taskGraphs.taskId, input.taskId))
          .run()
        this.db
          .insert(graphRevisions)
          .values({
            ...identity,
            id: randomUUID(),
            revision: appliedRevision,
            document: input.document,
            createdAt: now,
          })
          .run()
        this.db
          .insert(graphCommands)
          .values({
            ...identity,
            id: input.commandId,
            inputHash,
            revision: appliedRevision,
            createdAt: now,
          })
          .run()
        this.db
          .update(workspaceMeta)
          .set({ revision: sql`${workspaceMeta.revision} + 1` })
          .where(eq(workspaceMeta.id, 1))
          .run()
      })
      .immediate()
    this.notify(identity)
    return { ...this.snapshot(identity), appliedRevision }
  }
  async prepareStart(raw: unknown): Promise<PreparedGraph> {
    const input = prepareGraphSchema.parse(raw)
    const identity = { projectId: input.projectId, taskId: input.taskId }
    const snapshot = this.snapshot(identity)
    if (snapshot.revision !== input.expectedRevision)
      throw new ApplicationError(
        'STALE_GRAPH',
        'The saved graph revision has changed.',
        'Reload and check the current graph before preparing it.',
      )
    // A failed recheck must not leave an earlier readiness stamp displayed.
    // Files can change outside the app without advancing catalog revisions.
    this.db
      .update(taskGraphs)
      .set({
        preparedRevision: null,
        preparedAt: null,
        preparedFingerprint: null,
      })
      .where(eq(taskGraphs.taskId, input.taskId))
      .run()
    this.notify(identity)
    if (!snapshot.validation.valid)
      throw new ApplicationError(
        'GRAPH_NOT_READY',
        snapshot.validation.issues.map((issue) => issue.message).join('\n'),
        'Complete the node settings and fix graph validation issues, then save and check again.',
      )
    const fingerprint = this.fingerprint(identity)
    const catalog = this.catalog.getSnapshot({ projectId: input.projectId })
    const skillIds = new Set<string>()
    for (const node of snapshot.document.nodes)
      if (node.type === 'agent') {
        const profile = catalog.profiles.find(
          (profile) => profile.id === node.data.profileId,
        )!
        for (const id of [...profile.skillIds, ...node.data.skillIds])
          skillIds.add(id)
      }
    await this.catalog.verifySelectionFiles(input.projectId, [...skillIds])
    const checkedAt = new Date().toISOString()
    this.database.sqlite
      .transaction(() => {
        if (
          this.row(identity).revision !== input.expectedRevision ||
          this.fingerprint(identity) !== fingerprint
        )
          throw new ApplicationError(
            'READINESS_CHANGED',
            'The graph or its assignments changed during the readiness check.',
            'Review the current graph and check readiness again.',
          )
        this.db
          .update(taskGraphs)
          .set({
            preparedRevision: input.expectedRevision,
            preparedAt: checkedAt,
            preparedFingerprint: fingerprint,
          })
          .where(eq(taskGraphs.taskId, input.taskId))
          .run()
      })
      .immediate()
    this.notify(identity)
    return {
      ...identity,
      revision: input.expectedRevision,
      checkedAt,
      nodeOrder: snapshot.validation.topologicalOrder,
      executionAvailable: false,
    }
  }
  validateDocument(identity: GraphIdentity, document: GraphDocument) {
    const { task } = this.scope(identity)
    return validateGraph(document, {
      catalog: this.catalog.getSnapshot({ projectId: identity.projectId }),
      models: this.models(),
      archived: !!task.archivedAt,
    })
  }
}
