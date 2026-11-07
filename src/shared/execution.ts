import { z } from 'zod'
import type { Failure, Result, Run } from './contracts'
import {
  graphIdentitySchema,
  type GraphIdentity,
  type WorkflowNode,
} from './graph'
import type { Project, Task } from './workspace'
import type { WorkflowSnapshot } from './workflow'

export const nodeIdentitySchema = graphIdentitySchema.extend({
  nodeId: z.uuid(),
})
export type NodeIdentity = z.infer<typeof nodeIdentitySchema>
export const startNodeSchema = nodeIdentitySchema
  .extend({
    expectedGraphRevision: z.number().int().positive(),
    mode: z.enum(['run', 'followup', 'retry', 'restart']),
    message: z.string().trim().min(1).max(32_000).optional(),
  })
  .strict()
export type StartNodeInput = z.infer<typeof startNodeSchema>
export const runIdentitySchema = nodeIdentitySchema
  .extend({ runId: z.uuid() })
  .strict()
export const fileDiffSchema = runIdentitySchema
  .extend({ path: z.string().min(1).max(4096) })
  .strict()
export interface TaskWorktree {
  /** Missing on older, isolated worktree records. */
  mode?: 'project' | 'isolated'
  nodeId?: string
  legacyPath?: string
  taskId: string
  projectId: string
  path: string
  branch: string
  baseRevision: string
  sourceHead: string | null
  sourceBranch: string | null
  state: 'creating' | 'ready'
  createdAt: string
}
export interface CodeSnapshot {
  head: string
  commit: string
}
export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'type-changed'
}
export interface RunChanges {
  before: CodeSnapshot
  after: CodeSnapshot
  files: ChangedFile[]
  omittedFiles: number
}
export interface FileDiff {
  path: string
  original: string
  modified: string
  binary: boolean
  unavailable?: string
}
export interface TestResult {
  command: string
  status:
    'not-run' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timed-out'
  output: string
  truncated: boolean
  exitCode: number | null
  startedAt?: string
  finishedAt?: string
}
export interface NodeRun extends Omit<Run, 'status'> {
  projectId: string
  taskId: string
  nodeId: string
  graphRevision: number
  mode: StartNodeInput['mode']
  threadId?: string
  status: Run['status'] | 'preparing' | 'testing'
  nodeSnapshot: Extract<WorkflowNode, { type: 'agent' }>
  taskSnapshot: Task
  projectContext: Project
  dependencyResults: {
    nodeId: string
    runId: string
    status: string
    summary: string
  }[]
  todoDependencyCommits?: Record<string, string>
  previousAttempt?: {
    id: string
    status: string
    error?: Failure
    tests: TestResult
  }
  worktree?: TaskWorktree
  before?: CodeSnapshot
  changes?: RunChanges
  taskResult?: CodeSnapshot
  integrationTests?: TestResult
  inspectionError?: Failure
  tests: TestResult
}
export interface ActiveNodeRun extends NodeIdentity {
  runId: string
  status: NodeRun['status']
}
export interface TaskExecutionSnapshot extends GraphIdentity {
  workflow?: WorkflowSnapshot
  worktree: TaskWorktree | null
  active: ActiveNodeRun | null
  activeRuns: ActiveNodeRun[]
  nodeStates: { nodeId: string; runId: string; status: NodeRun['status'] }[]
  persistenceError?: Failure
}
export interface TaskReviewContext extends GraphIdentity {
  taskTitle: string
  path: string
  branch: string
  projectPath: string
  projectBranch: string | null
  devCommand: string
  ideCommand: string
  runCommand: string | null
  active: boolean
  targetBranch: string | null
  checkoutCommand: string
}
export interface NodeExecutionSnapshot extends NodeIdentity {
  workflow?: WorkflowSnapshot
  worktree: TaskWorktree | null
  threadId?: string
  runs: NodeRun[]
  active: ActiveNodeRun | null
  persistenceError?: Failure
}
export interface NodeSession extends NodeIdentity {
  title: string
  projectName: string
  taskTitle: string
  state: 'running' | 'attention' | 'done'
  detail: string
  updatedAt: string
}
export interface ExecutionBridge {
  listSessions(): Promise<Result<NodeSession[]>>
  getTask(input: GraphIdentity): Promise<Result<TaskExecutionSnapshot>>
  getReview(input: GraphIdentity): Promise<Result<TaskReviewContext>>
  openWorktree(input: GraphIdentity): Promise<Result<void>>
  openInIde(input: GraphIdentity & { nodeId?: string }): Promise<Result<void>>
  checkoutTask(input: GraphIdentity): Promise<Result<void>>
  get(input: NodeIdentity): Promise<Result<NodeExecutionSnapshot>>
  start(input: StartNodeInput): Promise<Result<{ runId: string }>>
  stop(input: NodeIdentity): Promise<Result<void>>
  getRun(input: NodeIdentity & { runId: string }): Promise<Result<NodeRun>>
  getDiff(
    input: NodeIdentity & { runId: string; path: string },
  ): Promise<Result<FileDiff>>
  onChange(callback: (identity: GraphIdentity) => void): () => void
}
export const isActiveNodeRun = (status?: NodeRun['status']) =>
  !!status && ['preparing', 'running', 'testing', 'stopping'].includes(status)
