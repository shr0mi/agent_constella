import { z } from 'zod'
import { effortSchema, type Effort, type Result } from './contracts'
import type { WorkflowSummary } from './workflow'

export const taskStatusSchema = z.enum(['todo', 'doing', 'done'])
export type TaskStatus = z.infer<typeof taskStatusSchema>
export const projectIdSchema = z.object({ projectId: z.uuid() }).strict()
export const repositoryInputSchema = z
  .object({ path: z.string().trim().min(1).max(4096) })
  .strict()
export const projectFieldsSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the project a name.').max(100),
    description: z.string().max(20_000),
    instructions: z.string().max(40_000),
    devCommand: z.string().trim().max(2000),
    testCommand: z.string().trim().max(2000),
    ideCommand: z.string().trim().max(2000).optional(),
    maxParallelAgents: z.number().int().min(1).max(8).optional(),
    defaultModel: z.string().trim().min(1).max(160).nullable().optional(),
    defaultEffort: effortSchema.nullable().optional(),
  })
  .strict()
export const updateProjectSchema = projectFieldsSchema.extend({
  projectId: z.uuid(),
  expectedRevision: z.number().int().positive(),
})
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
export const deleteProjectSchema = projectIdSchema.extend({
  expectedRevision: z.number().int().positive(),
})
export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>

export const taskFieldsSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the task a title.').max(180),
    description: z.string().max(30_000),
    acceptanceCriteria: z.string().max(20_000),
    dependencyIds: z.array(z.uuid()).max(100).optional(),
    requiredFiles: z.array(
      z.string().trim().min(1).max(4096).refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          !path.split('/').some((part) => part === '..' || part === '.' || !part) &&
          !/[:\x00-\x1f]/.test(path),
        'Use a relative file path inside the task workspace.',
      ),
    ).max(100).optional(),
  })
  .strict()
export const createTaskSchema = taskFieldsSchema.extend({
  projectId: z.uuid(),
  status: taskStatusSchema.default('todo'),
  description: z.string().max(30_000).default(''),
  acceptanceCriteria: z.string().max(20_000).default(''),
  dependencyIds: taskFieldsSchema.shape.dependencyIds.default([]),
  requiredFiles: taskFieldsSchema.shape.requiredFiles.default([]),
})
export type CreateTaskInput = z.input<typeof createTaskSchema>
export const taskIdentitySchema = projectIdSchema.extend({
  taskId: z.uuid(),
  expectedRevision: z.number().int().positive(),
})
export type TaskIdentityInput = z.infer<typeof taskIdentitySchema>
export const updateTaskSchema = taskIdentitySchema.extend(
  taskFieldsSchema.shape,
)
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>
export const moveTaskSchema = taskIdentitySchema.extend({
  status: taskStatusSchema,
  beforeTaskId: z.uuid().nullable().default(null),
})
export type MoveTaskInput = z.input<typeof moveTaskSchema>

export interface Project {
  id: string
  repoPath: string
  name: string
  description: string
  instructions: string
  devCommand: string
  testCommand: string
  ideCommand: string
  maxParallelAgents: number
  defaultModel: string | null
  defaultEffort: Effort | null
  revision: number
  createdAt: string
  updatedAt: string
}
export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  acceptanceCriteria: string
  dependencyIds: string[]
  requiredFiles: string[]
  status: TaskStatus
  position: number
  revision: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface WorkspaceSnapshot {
  revision: number
  projects: Project[]
  tasks: Task[]
  workflows?: WorkflowSummary[]
}
export interface ProjectBoard {
  project: Project
  tasks: Task[]
}

export interface WorkspaceBridge {
  getSnapshot(): Promise<Result<WorkspaceSnapshot>>
  chooseRepository(): Promise<Result<Project | null>>
  chooseNewProject(): Promise<Result<Project | null>>
  updateProject(input: UpdateProjectInput): Promise<Result<Project>>
  deleteProject(input: DeleteProjectInput): Promise<Result<boolean>>
  createTask(input: CreateTaskInput): Promise<Result<Task>>
  updateTask(input: UpdateTaskInput): Promise<Result<Task>>
  moveTask(input: MoveTaskInput): Promise<Result<Task>>
  archiveTask(input: TaskIdentityInput): Promise<Result<Task>>
  restoreTask(input: TaskIdentityInput): Promise<Result<Task>>
  onChange(callback: (snapshot: WorkspaceSnapshot) => void): () => void
}
