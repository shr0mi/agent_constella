import { z } from 'zod'
import {
  effortSchema,
  type Activity,
  type Failure,
  type Result,
} from './contracts'
import { graphEdgeSchema, graphNodeSchema, type GraphDocument } from './graph'
import type { Project, Task } from './workspace'

export const managerScopeSchema = z
  .object({
    projectId: z.uuid(),
    taskId: z.uuid().nullable().default(null),
  })
  .strict()
export type ManagerScope = z.infer<typeof managerScopeSchema>
export const managerSendSchema = managerScopeSchema.extend({
  chatId: z.uuid().optional(),
  message: z.string().trim().min(1).max(32_000),
  selectedNodeId: z.uuid().nullable().optional(),
  model: z.string().trim().min(1).max(160).nullable().optional(),
  effort: effortSchema.nullable().optional(),
})
export type ManagerSend = z.infer<typeof managerSendSchema>
export const newManagerChatSchema = managerScopeSchema.extend({
  expectedChatId: z.uuid(),
})
export const selectManagerChatSchema = newManagerChatSchema.extend({
  chatId: z.uuid(),
})
export const graphChangesSchema = z
  .object({
    taskId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    commandId: z.uuid(),
    changes: z
      .array(
        z.discriminatedUnion('op', [
          z
            .object({ op: z.literal('add_node'), node: graphNodeSchema })
            .strict(),
          z
            .object({ op: z.literal('update_node'), node: graphNodeSchema })
            .strict(),
          z.object({ op: z.literal('remove_node'), nodeId: z.uuid() }).strict(),
          z
            .object({ op: z.literal('add_edge'), edge: graphEdgeSchema })
            .strict(),
          z.object({ op: z.literal('remove_edge'), edgeId: z.uuid() }).strict(),
        ]),
      )
      .min(1)
      .max(500),
  })
  .strict()
export interface ManagerTurn {
  id: string
  message: string
  context: string
  startedAt: string
  finishedAt?: string
  status:
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
  items: Activity[]
  error?: Failure
}
export interface ManagerChat extends ManagerScope {
  provider?: 'codex' | 'claude'
  id: string
  createdAt: string
  threadId?: string
  turns: ManagerTurn[]
}
export interface ManagerChatSummary extends ManagerScope {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  turnCount: number
  current: boolean
}
interface ChangeMetadata {
  projectId: string
  action: string
  revision: number
}
export type ChangeRecord = ChangeMetadata &
  (
    | { kind: 'project'; taskId: null; before: Project; after: Project }
    | { kind: 'task'; taskId: string; before: Task | null; after: Task }
    | {
        kind: 'graph'
        taskId: string
        before: GraphDocument
        after: GraphDocument
      }
  )
export type ChangeEntry = ChangeRecord & {
  id: string
  createdAt: string
  undoneAt: string | null
}
export const undoChangeSchema = managerScopeSchema.extend({
  changeId: z.uuid(),
  commandId: z.uuid(),
})
export interface ManagerBridge {
  get(input: ManagerScope): Promise<Result<ManagerChat>>
  list(input: ManagerScope): Promise<Result<ManagerChatSummary[]>>
  newChat(
    input: z.infer<typeof newManagerChatSchema>,
  ): Promise<Result<ManagerChat>>
  selectChat(
    input: z.infer<typeof selectManagerChatSchema>,
  ): Promise<Result<ManagerChat>>
  send(input: ManagerSend): Promise<Result<{ turnId: string }>>
  stop(input: ManagerScope): Promise<Result<void>>
  history(input: ManagerScope): Promise<Result<ChangeEntry[]>>
  undo(input: z.infer<typeof undoChangeSchema>): Promise<Result<void>>
  onChange(callback: (scope: ManagerScope) => void): () => void
}
