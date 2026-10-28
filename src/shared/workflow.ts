import { z } from 'zod'
import {
  graphIdentitySchema,
  type GraphIdentity,
  type WorkflowNodeType,
} from './graph'
import type { Result, Failure } from './contracts'
import type { CodeSnapshot } from './execution'

export type WorkflowPhase =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'archived'
  | 'integrating'
export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting-acceptance'
  | 'waiting-review'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'stale'
export interface WorkflowNodeState {
  id: string
  type: WorkflowNodeType
  title: string
  signature: string
  status: WorkflowNodeStatus
  runId?: string
  acceptanceId?: string
  acceptedAt?: string
  acceptedBy?: 'human' | 'auto' | 'system'
  reason?: string
  invalidated?: boolean
  pendingMessage?: string
}
export interface IntegrationPlan {
  status:
    | 'ready'
    | 'blocked'
    | 'conflicts'
    | 'integrated'
    | 'failed'
    | 'interrupted'
  workflowRevision: number
  targetBranch: string | null
  targetHead: string | null
  resultCommit?: string
  mergedTree?: string
  commit?: string
  conflicts: string[]
  message: string
  checkedAt: string
}
export interface WorkflowRecord extends GraphIdentity {
  revision: number
  graphRevision: number
  phase: WorkflowPhase
  scheduling?: 'automatic' | 'manual'
  nodes: Record<string, WorkflowNodeState>
  startedAt?: string
  completedAt?: string
  updatedAt: string
  lastSnapshot?: CodeSnapshot
  completionSnapshot?: CodeSnapshot
  error?: Failure
  integration?: IntegrationPlan
  integrationHistory?: IntegrationPlan[]
}
export interface WorkflowSummary extends GraphIdentity {
  running?: number
  phase: WorkflowPhase
  scheduling?: WorkflowRecord['scheduling']
  started: boolean
  accepted: number
  total: number
  blockers: string[]
  integration?: IntegrationPlan['status']
}
export interface ReviewEvidence {
  nodeId: string
  title: string
  runId?: string
  status: string
  summary: string
  checks?: string
}
export interface WorkflowSnapshot extends WorkflowRecord {
  summary: WorkflowSummary
  evidence: Record<string, ReviewEvidence[]>
}
export interface WorkflowDecision extends GraphIdentity {
  id: string
  nodeId: string
  action: 'accept' | 'approve' | 'changes'
  actor: 'human'
  runId?: string
  targetNodeId?: string
  note: string
  at: string
}
export const workflowStartSchema = graphIdentitySchema
  .extend({ expectedGraphRevision: z.number().int().positive() })
  .strict()
export const acceptNodeSchema = graphIdentitySchema
  .extend({
    nodeId: z.uuid(),
    runId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  })
  .strict()
export const reviewNodeSchema = graphIdentitySchema
  .extend({
    nodeId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(['approve', 'changes']),
    targetNodeId: z.uuid().optional(),
    note: z.string().trim().max(8000).default(''),
  })
  .strict()
export const integrationPreviewSchema = graphIdentitySchema
  .extend({ expectedRevision: z.number().int().positive() })
  .strict()
export const integrationApplySchema = integrationPreviewSchema
  .extend({
    targetBranch: z.string().min(1).max(240),
    targetHead: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
  })
  .strict()
export type HumanOrigin = 'desktop-human' | 'manager' | 'worker'
export interface WorkflowBridge {
  get(input: GraphIdentity): Promise<Result<WorkflowSnapshot>>
  start(
    input: z.infer<typeof workflowStartSchema>,
  ): Promise<Result<WorkflowSnapshot>>
  pause(input: GraphIdentity): Promise<Result<WorkflowSnapshot>>
  accept(
    input: z.infer<typeof acceptNodeSchema>,
  ): Promise<Result<WorkflowSnapshot>>
  review(
    input: z.input<typeof reviewNodeSchema>,
  ): Promise<Result<WorkflowSnapshot>>
  previewIntegration(
    input: z.infer<typeof integrationPreviewSchema>,
  ): Promise<Result<IntegrationPlan>>
  integrate(
    input: z.infer<typeof integrationApplySchema>,
  ): Promise<Result<IntegrationPlan>>
  onChange(callback: (identity: GraphIdentity) => void): () => void
}
export function summarizeWorkflow(record: WorkflowRecord): WorkflowSummary {
  const nodes = Object.values(record.nodes),
    required = nodes.filter((node) => node.type !== 'start')
  const blockers = nodes
    .filter((node) =>
      [
        'failed',
        'stopped',
        'interrupted',
        'stale',
        'awaiting-acceptance',
        'waiting-review',
      ].includes(node.status),
    )
    .map(
      (node) =>
        `${node.title}: ${node.reason ?? node.status.replaceAll('-', ' ')}`,
    )
  if (record.error) blockers.unshift(record.error.message)
  return {
    projectId: record.projectId,
    taskId: record.taskId,
    phase: record.phase,
    scheduling: record.scheduling,
    started: !!record.startedAt,
    running: nodes.filter((node) => node.status === 'running').length,
    accepted: required.filter(
      (node) => node.status === 'completed' && node.acceptanceId,
    ).length,
    total: required.length,
    blockers,
    integration: record.integration?.status,
  }
}
export const workflowStatusLabel: Record<WorkflowNodeStatus, string> = {
  pending: 'Pending',
  ready: 'Ready',
  running: 'Running',
  'awaiting-acceptance': 'Awaiting acceptance',
  'waiting-review': 'Waiting for human',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  stale: 'Stale result',
}
