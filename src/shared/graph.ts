import { z } from 'zod'
import { effortSchema, type Result } from './contracts'
import type { Project, Task } from './workspace'

const positionSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
  })
  .strict()
const nodeBase = { id: z.uuid(), position: positionSchema }
const title = z.string().trim().max(180)
export const graphNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...nodeBase,
      type: z.literal('start'),
      data: z.object({ title }).strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal('end'),
      data: z.object({ title }).strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal('review'),
      data: z.object({ title, instructions: z.string().max(20_000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal('agent'),
      data: z
        .object({
          title,
          prompt: z.string().max(32_000),
          acceptanceCriteria: z.string().max(20_000),
          profileId: z.uuid().nullable(),
          skillIds: z.array(z.uuid()).max(20),
          model: z.string().trim().min(1).max(160).nullable().optional(),
          effort: effortSchema.nullable().optional(),
          acceptance: z.enum(['auto', 'manual']),
        })
        .strict(),
    })
    .strict(),
])
export type WorkflowNode = z.infer<typeof graphNodeSchema>
export type WorkflowNodeType = WorkflowNode['type']
export const graphEdgeSchema = z
  .object({ id: z.uuid(), source: z.uuid(), target: z.uuid() })
  .strict()
export type WorkflowEdge = z.infer<typeof graphEdgeSchema>
export const graphDocumentSchema = z
  .object({
    nodes: z.array(graphNodeSchema).max(100),
    edges: z.array(graphEdgeSchema).max(400),
    viewport: z
      .object({
        x: z.number().finite().min(-1_000_000).max(1_000_000),
        y: z.number().finite().min(-1_000_000).max(1_000_000),
        zoom: z.number().min(0.1).max(2.5),
      })
      .strict(),
  })
  .strict()
export type GraphDocument = z.infer<typeof graphDocumentSchema>
export const graphIdentitySchema = z
  .object({ projectId: z.uuid(), taskId: z.uuid() })
  .strict()
export type GraphIdentity = z.infer<typeof graphIdentitySchema>
export const saveGraphSchema = graphIdentitySchema.extend({
  expectedRevision: z.number().int().positive(),
  commandId: z.uuid(),
  document: graphDocumentSchema,
})
export type SaveGraphInput = z.infer<typeof saveGraphSchema>
export const prepareGraphSchema = graphIdentitySchema.extend({
  expectedRevision: z.number().int().positive(),
})
export interface GraphIssue {
  code: string
  message: string
  blocksSave: boolean
  nodeId?: string
  edgeId?: string
}
export interface GraphValidation {
  valid: boolean
  canSave: boolean
  issues: GraphIssue[]
  topologicalOrder: string[]
}
export interface GraphSnapshot {
  project: Project
  task: Task
  revision: number
  document: GraphDocument
  validation: GraphValidation
  prepared: { revision: number; at: string } | null
  updatedAt: string
  appliedRevision?: number
}
export interface PreparedGraph {
  projectId: string
  taskId: string
  revision: number
  checkedAt: string
  nodeOrder: string[]
  executionAvailable: false
}
export interface GraphBridge {
  get(input: GraphIdentity): Promise<Result<GraphSnapshot>>
  save(input: SaveGraphInput): Promise<Result<GraphSnapshot>>
  prepareStart(
    input: GraphIdentity & { expectedRevision: number },
  ): Promise<Result<PreparedGraph>>
  onChange(callback: (identity: GraphIdentity) => void): () => void
}

export function makeWorkflowNode(
  type: WorkflowNodeType,
  id: string,
  position: { x: number; y: number },
): WorkflowNode {
  if (type === 'agent')
    return {
      id,
      position,
      type,
      data: {
        title: 'Agent task',
        prompt: '',
        acceptanceCriteria: '',
        profileId: null,
        skillIds: [],
        acceptance: 'manual',
      },
    }
  if (type === 'review')
    return {
      id,
      position,
      type,
      data: {
        title: 'Human review',
        instructions:
          'Review the upstream results and decide whether to approve or request changes.',
      },
    }
  return {
    id,
    position,
    type,
    data: { title: type === 'start' ? 'Start' : 'End' },
  }
}

export function defaultTaskGraph(
  task: Task,
  uuid: () => string,
): GraphDocument {
  const nodes = (['start', 'agent', 'review', 'end'] as const).map(
    (type, index) =>
      makeWorkflowNode(type, uuid(), { x: 40 + index * 270, y: 140 }),
  )
  const agent = nodes[1]
  if (agent.type === 'agent')
    agent.data = {
      ...agent.data,
      title: task.title,
      prompt: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
    }
  return {
    nodes,
    edges: nodes
      .slice(1)
      .map((node, index) => ({
        id: uuid(),
        source: nodes[index].id,
        target: node.id,
      })),
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}
