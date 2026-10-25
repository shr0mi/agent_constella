import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  createTaskSchema,
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
import { projects, tasks, workspaceMeta } from '../db/schema'
import { ApplicationError } from './errors'
import {
  createProjectFolder,
  openProjectFolder,
  resolveRepository,
} from './repository'

// This service owns the rules. It has no Electron dependency and can be called
// by IPC today and by project-scoped MCP tools later.
export class WorkspaceService {
  private listeners = new Set<(snapshot: WorkspaceSnapshot) => void>()
  constructor(private readonly database: WorkspaceDatabase) {}
  private get db() {
    return this.database.db
  }

  getSnapshot(): WorkspaceSnapshot {
    return {
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

  private commit<T>(action: () => T): T {
    const result = this.database.sqlite
      .transaction(() => {
        const result = action()
        this.db
          .update(workspaceMeta)
          .set({ revision: sql`${workspaceMeta.revision} + 1` })
          .where(eq(workspaceMeta.id, 1))
          .run()
        return result
      })
      .immediate()
    const snapshot = this.getSnapshot()
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('Workspace change listener failed after commit:', error)
      }
    })
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
    return this.registerRepository(await resolveRepository(path))
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
      this.checkRevision(this.project(projectId), expectedRevision)
      return this.db
        .update(projects)
        .set({
          ...fields,
          revision: expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(projects.id, projectId))
        .returning()
        .get()!
    })
  }

  createTask(raw: unknown): Task {
    const { projectId, ...fields } = createTaskSchema.parse(raw)
    return this.commit(() => {
      this.project(projectId)
      const now = new Date().toISOString()
      return this.db
        .insert(tasks)
        .values({
          id: randomUUID(),
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
