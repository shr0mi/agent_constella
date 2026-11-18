import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  createTaskSchema,
  deleteProjectSchema,
  moveTaskSchema,
  projectIdSchema,
  repositoryInputSchema,
  taskIdentitySchema,
  updateProjectSchema,
  updateTaskSchema,
  type Project,
  type ProjectBoard,
  type Task,
  type TaskStatus,
  type WorkspaceSnapshot,
} from '../../shared/workspace'
import type { WorkspaceDatabase } from '../db/database'
import { projects, tasks, workspaceMeta, workflows } from '../db/schema'
import { summarizeWorkflow } from '../../shared/workflow'
import { ApplicationError } from './errors'
import { cliPath } from '../terminal/launch'
import { recordChange } from './change-log'
import { effectiveIdeCommand, ideArguments, launchIde } from './ide-launcher'
import type { ModelOption } from '../../shared/contracts'
import {
  createProjectFolder,
  ensureInitialCommit,
  openProjectFolder,
  resolveRepository,
} from './repository'

// This service owns the rules. It has no Electron dependency and can be called
// by IPC today and by project-scoped MCP tools later.
export class WorkspaceService {
  private deletionGuard?: (projectId: string) => string | undefined
  setProjectDeletionGuard(guard: (projectId: string) => string | undefined) {
    this.deletionGuard = guard
  }
  private listeners = new Set<(snapshot: WorkspaceSnapshot) => void>()
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly models: () => ModelOption[] = () => [],
  ) {}
  private get db() {
    return this.database.db
  }

  async openInIde(raw: unknown, launch: typeof launchIde = launchIde): Promise<void> {
    const { projectId } = projectIdSchema.parse(raw)
    const project = this.project(projectId)
    ideArguments(effectiveIdeCommand(project.ideCommand))
    await launch(project.ideCommand, project.repoPath)
  }

  getSnapshot(): WorkspaceSnapshot {
    return {
      workflows: this.db
        .select()
        .from(workflows)
        .all()
        .map((row) => {
          const summary = summarizeWorkflow(row.document)
          summary.blockers.unshift(...this.dependencyBlockers(row.projectId, row.taskId))
          return summary
        }),
      revision: this.db.select().from(workspaceMeta).get()!.revision,
      projects: this.db
        .select()
        .from(projects)
        .orderBy(desc(projects.updatedAt), asc(projects.id))
        .all(),
      tasks: this.db
        .select()
        .from(tasks)
        .orderBy(
          asc(tasks.projectId),
          asc(tasks.status),
          asc(tasks.position),
          asc(tasks.id),
        )
        .all(),
    }
  }

  getBoard(raw: unknown): ProjectBoard {
    const { projectId } = projectIdSchema.parse(raw)
    return {
      project: this.project(projectId),
      tasks: this.db
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(asc(tasks.position), asc(tasks.id))
        .all(),
    }
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notify(): void {
    if (this.database.sqlite.inTransaction) {
      queueMicrotask(() => this.notify())
      return
    }
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('Workspace notification failed:', error)
      }
    }
  }
  // Called in the scheduler's SQLite transaction; publish only after that commits.
  setWorkflowStatus(
    identity: { projectId: string; taskId: string },
    status: TaskStatus,
  ): void {
    const task = this.task(identity.projectId, identity.taskId)
    if (task.archivedAt || task.status === status) return
    const now = new Date().toISOString()
    this.db
      .update(tasks)
      .set({
        status,
        position: this.column(identity.projectId, status).length,
        revision: task.revision + 1,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run()
    this.reorder(this.column(identity.projectId, task.status), now)
  }

  private commit<T>(action: () => T): T {
    const result = this.database.sqlite
      .transaction(() => {
        const before = new Map(
          this.db
            .select()
            .from(tasks)
            .all()
            .map((task) => [task.id, task]),
        )
        const result = action()
        for (const task of this.db.select().from(tasks).all()) {
          const previous = before.get(task.id)
          if (previous?.revision === task.revision) continue
          const action = !previous
            ? 'Create task'
            : task.archivedAt !== previous.archivedAt
              ? task.archivedAt
                ? 'Archive task'
                : 'Restore task'
              : task.position !== previous.position ||
                  task.status !== previous.status
                ? 'Move task'
                : 'Edit task'
          recordChange(this.database, {
            projectId: task.projectId,
            taskId: task.id,
            kind: 'task',
            action,
            before: previous ?? null,
            after: task,
            revision: task.revision,
          })
        }
        this.db
          .update(workspaceMeta)
          .set({ revision: sql`${workspaceMeta.revision} + 1` })
          .where(eq(workspaceMeta.id, 1))
          .run()
        return result
      })
      .immediate()
    this.notify()
    return result
  }

  private project(id: string): Project {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get()
    if (!project)
      throw new ApplicationError(
        'PROJECT_NOT_FOUND',
        'The project no longer exists.',
        'Return to Projects and choose an available project.',
      )
    return project
  }

  private task(projectId: string, taskId: string): Task {
    this.project(projectId)
    const task = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .get()
    if (!task)
      throw new ApplicationError(
        'TASK_NOT_FOUND',
        'This task does not belong to the selected project or no longer exists.',
        'Refresh the board and choose a task from this project.',
      )
    return task
  }

  private checkRevision(row: { revision: number }, expected: number): void {
    if (row.revision !== expected)
      throw new ApplicationError(
        'STALE_WRITE',
        'This item changed after it was opened.',
        'The board has refreshed. Reopen the item to review the latest values before saving again.',
      )
  }

  private checkActive(task: Task): void {
    if (task.archivedAt)
      throw new ApplicationError(
        'TASK_ARCHIVED',
        'This task is archived.',
        'Restore the task from the archive before editing or moving it.',
      )
  }

  dependencyBlockers(projectId: string, taskId: string): string[] {
    const task = this.task(projectId, taskId)
    return (task.dependencyIds ?? []).flatMap((id) => {
      const dependency = this.task(projectId, id)
      const result = this.db
        .select().from(workflows).where(eq(workflows.taskId, id)).get()?.document
      return result?.phase === 'completed' &&
        result.integration?.status === 'integrated' && result.integration.commit
        ? []
        : [`Waiting for “${dependency.title}” to be integrated${dependency.archivedAt ? ' (currently archived)' : ''}.`]
    })
  }

  assertDependencies(projectId: string, taskId: string) {
    const blockers = this.dependencyBlockers(projectId, taskId)
    if (blockers.length)
      throw new ApplicationError(
        'TASK_DEPENDENCIES', blockers.join('\n'),
        'Complete and integrate the prerequisite tasks. This task will wait without starting an agent.',
      )
  }

  private validateDependencies(
    projectId: string, taskId: string, dependencyIds: string[],
  ) {
    if (new Set(dependencyIds).size !== dependencyIds.length)
      throw new ApplicationError(
        'TASK_DEPENDENCIES', 'A prerequisite is listed more than once.',
        'Select each prerequisite once.',
      )
    const checked = new Set<string>()
    const visit = (id: string, path: Set<string>) => {
      if (checked.has(id)) return
      if (id === taskId || path.has(id))
        throw new ApplicationError(
          'TASK_DEPENDENCY_CYCLE', 'Task dependencies cannot contain a cycle.',
          'Remove the dependency that leads back to this task.',
        )
      const dependency = this.task(projectId, id)
      for (const parent of dependency.dependencyIds ?? [])
        visit(parent, new Set([...path, id]))
      checked.add(id)
    }
    for (const id of dependencyIds) visit(id, new Set())
  }

  private column(projectId: string, status: TaskStatus): Task[] {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(tasks.status, status),
          isNull(tasks.archivedAt),
        ),
      )
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all()
  }

  private reorder(rows: Task[], now: string): void {
    rows.forEach((row, position) => {
      if (row.position === position) return
      this.db
        .update(tasks)
        .set({ position, revision: sql`${tasks.revision} + 1`, updatedAt: now })
        .where(and(eq(tasks.id, row.id), eq(tasks.projectId, row.projectId)))
        .run()
    })
  }

  async openRepository(raw: unknown): Promise<Project> {
    const { path } = repositoryInputSchema.parse(raw)
    const repository = await resolveRepository(path)
    await ensureInitialCommit(repository)
    return this.registerRepository(repository)
  }

  async openFolder(raw: unknown): Promise<Project> {
    const { path } = repositoryInputSchema.parse(raw)
    return this.registerRepository(await openProjectFolder(path))
  }

  async createProject(raw: unknown): Promise<Project> {
    const { path } = repositoryInputSchema.parse(raw)
    const repoPath = await createProjectFolder(path)
    try {
      return this.registerRepository(repoPath)
    } catch {
      throw new ApplicationError(
        'PROJECT_REGISTRATION',
        `The project folder and Git repository were created at ${repoPath}, but the project could not be saved.`,
        'Check app data access and available disk space, then use Open folder to register it. The folder has been preserved.',
      )
    }
  }

  /** New projects default to a CLI that is actually installed. */
  private preferredProvider(): 'codex' | 'claude' {
    // Tests need a deterministic default regardless of what this machine has.
    if (process.env.VITEST) return 'codex'
    const installed = (provider: 'codex' | 'claude') => {
      try {
        cliPath(provider)
        return true
      } catch {
        return false
      }
    }
    return !installed('codex') && installed('claude') ? 'claude' : 'codex'
  }

  private registerRepository(repoPath: string): Project {
    const existing = this.db
      .select()
      .from(projects)
      .where(eq(projects.repoPath, repoPath))
      .get()
    if (existing) return existing
    return this.commit(() => {
      const now = new Date().toISOString()
      return this.db
        .insert(projects)
        .values({
          id: randomUUID(),
          repoPath,
          name: basename(repoPath).trim().slice(0, 100) || 'Untitled project',
          description: '',
          instructions: '',
          devCommand: '',
          testCommand: '',
          defaultProvider: this.preferredProvider(),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
    })
  }

  updateProject(raw: unknown): Project {
    const { projectId, expectedRevision, ...fields } =
      updateProjectSchema.parse(raw)
    return this.commit(() => {
      const current = this.project(projectId)
      this.checkRevision(current, expectedRevision)
      const model =
        fields.defaultModel !== undefined
          ? fields.defaultModel
          : current.defaultModel
      const effort =
        fields.defaultEffort !== undefined
          ? fields.defaultEffort
          : current.defaultEffort
      if (!model && effort)
        throw new ApplicationError(
          'MODEL_OPTIONS',
          'Choose a default model before setting reasoning effort.',
          'Select a model or use its default effort.',
        )
      const models = this.models()
      if (
        model &&
        models.length &&
        !models.some(
          (option) =>
            option.id === model && (!effort || option.efforts.includes(effort)),
        )
      )
        throw new ApplicationError(
          'MODEL_OPTIONS',
          'This default model/effort pair is not supported by the current runtime.',
          'Refresh model options and choose a supported combination.',
        )
      const updated = this.db
        .update(projects)
        .set({
          ...fields,
          revision: expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(projects.id, projectId))
        .returning()
        .get()!
      recordChange(this.database, {
        projectId,
        taskId: null,
        kind: 'project',
        action: 'Edit project settings',
        before: current,
        after: updated,
        revision: updated.revision,
      })
      return updated
    })
  }

  async deleteProject(
    raw: unknown,
    confirm: (project: Project) => Promise<boolean>,
    origin?: 'desktop-human',
  ): Promise<boolean> {
    if (origin !== 'desktop-human')
      throw new ApplicationError(
        'HUMAN_ONLY',
        'Only a confirmed desktop action can delete a project.',
        'Use Delete project in Project settings.',
      )
    const input = deleteProjectSchema.parse(raw)
    const check = () => {
      const project = this.project(input.projectId)
      this.checkRevision(project, input.expectedRevision)
      const busy = this.deletionGuard?.(input.projectId)
      if (busy)
        throw new ApplicationError(
          'PROJECT_BUSY',
          busy,
          'Stop active work or wait for it to finish, then try deleting the project again.',
        )
      return project
    }
    if (!(await confirm(check()))) return false
    // Recheck after the confirmation dialog: work or settings may have changed
    // while it was open. Never hold a database transaction across user input.
    this.commit(() => {
      check()
      this.db.delete(projects).where(eq(projects.id, input.projectId)).run()
    })
    return true
  }

  createTask(raw: unknown): Task {
    const { projectId, ...fields } = createTaskSchema.parse(raw)
    return this.commit(() => {
      this.project(projectId)
      if (fields.status === 'done')
        throw new ApplicationError(
          'WORKFLOW_STATUS', 'Tasks become Done only after integration.',
          'Create the task in To Do or Doing, then run and integrate it.',
        )
      const id = randomUUID()
      this.validateDependencies(projectId, id, fields.dependencyIds)
      const now = new Date().toISOString()
      return this.db
        .insert(tasks)
        .values({
          id,
          projectId,
          ...fields,
          position: this.column(projectId, fields.status).length,
          revision: 1,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
    })
  }

  updateTask(raw: unknown): Task {
    const { projectId, taskId, expectedRevision, ...fields } =
      updateTaskSchema.parse(raw)
    return this.commit(() => {
      const task = this.task(projectId, taskId)
      this.checkRevision(task, expectedRevision)
      this.checkActive(task)
      this.validateDependencies(projectId, taskId, fields.dependencyIds ?? task.dependencyIds)
      return this.db
        .update(tasks)
        .set({
          ...fields,
          revision: expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .returning()
        .get()!
    })
  }

  moveTask(raw: unknown): Task {
    const { projectId, taskId, expectedRevision, status, beforeTaskId } =
      moveTaskSchema.parse(raw)
    return this.commit(() => {
      const task = this.task(projectId, taskId)
      const workflow = this.db
        .select()
        .from(workflows)
        .where(eq(workflows.taskId, taskId))
        .get()?.document
      if (status === 'done' && workflow?.integration?.status !== 'integrated')
        throw new ApplicationError('WORKFLOW_STATUS', 'Tasks become Done only after integration.', 'Complete the workflow, then use Integrate branch.')
      if (workflow?.startedAt && status !== task.status)
        throw new ApplicationError(
          'WORKFLOW_STATUS',
          'This task status is controlled by its workflow.',
          'Start/resume the graph to move it to Doing. Integrating accepted work moves it to Done. You can still reorder it within its column.',
        )
      this.checkRevision(task, expectedRevision)
      this.checkActive(task)
      if (beforeTaskId === taskId && status === task.status) return task
      const target = this.column(projectId, status).filter(
        (row) => row.id !== taskId,
      )
      const index = beforeTaskId
        ? target.findIndex((row) => row.id === beforeTaskId)
        : target.length
      if (index < 0)
        throw new ApplicationError(
          'INVALID_TASK_ORDER',
          'The destination task is not in the selected project and column.',
          'Refresh the board and move the task again.',
        )
      const now = new Date().toISOString()
      const moved = this.db
        .update(tasks)
        .set({ status, revision: expectedRevision + 1, updatedAt: now })
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .returning()
        .get()!
      target.splice(index, 0, moved)
      this.reorder(target, now)
      if (status !== task.status)
        this.reorder(this.column(projectId, task.status), now)
      return this.task(projectId, taskId)
    })
  }

  archiveTask(raw: unknown): Task {
    const { projectId, taskId, expectedRevision } =
      taskIdentitySchema.parse(raw)
    return this.commit(() => {
      const task = this.task(projectId, taskId)
      this.checkRevision(task, expectedRevision)
      if (task.archivedAt) return task
      const now = new Date().toISOString()
      const archived = this.db
        .update(tasks)
        .set({
          archivedAt: now,
          revision: expectedRevision + 1,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .returning()
        .get()!
      this.reorder(this.column(projectId, task.status), now)
      return archived
    })
  }

  restoreTask(raw: unknown): Task {
    const { projectId, taskId, expectedRevision } =
      taskIdentitySchema.parse(raw)
    return this.commit(() => {
      const task = this.task(projectId, taskId)
      this.checkRevision(task, expectedRevision)
      if (!task.archivedAt) return task
      return this.db
        .update(tasks)
        .set({
          archivedAt: null,
          position: this.column(projectId, task.status).length,
          revision: expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .returning()
        .get()!
    })
  }
}
