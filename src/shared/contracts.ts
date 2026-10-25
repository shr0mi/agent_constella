import { z } from 'zod'
import type { WorkspaceBridge } from './workspace'
import type { GraphBridge } from './graph'
import type { ExecutionBridge } from './execution'
import type { WorkflowBridge } from './workflow'
import type {
  AgentProfile,
  CatalogBridge,
  ProjectRunSnapshot,
  SkillSnapshot,
} from './catalog'

// This is the pinned TypeScript SDK's union, not a promise that every model supports every effort.
export const effortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
])
export type Effort = z.infer<typeof effortSchema>
export const runInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    model: z.string().trim().min(1).max(160).nullable().optional(),
    effort: effortSchema.nullable().optional(),
    profileId: z.uuid().optional(),
    sandbox: z.enum(['read-only', 'workspace-write']),
    skillIds: z
      .array(z.union([z.literal('connectivity-proof'), z.uuid()]))
      .max(21)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Select each skill once.',
      ),
  })
  .strict()
export type RunInput = z.infer<typeof runInputSchema>
export const newSessionSchema = z
  .object({ projectId: z.uuid().optional() })
  .strict()

export interface ModelOption {
  id: string
  name: string
  isDefault: boolean
  efforts: Effort[]
  defaultEffort?: Effort
}
export interface Diagnostics {
  sdkVersion: string
  cliVersion: string
  runtimePath: string
  auth: { status: 'signed-in' | 'missing' | 'unknown'; detail: string }
  models: ModelOption[]
  modelError?: string
  checkedAt: string
}
export interface Failure {
  code: string
  message: string
  hint: string
}
export interface Activity {
  id: string
  type: string
  title: string
  text: string
  status?: string
}
export interface Run {
  id: string
  prompt: string
  resolvedPrompt: string
  options: Omit<RunInput, 'prompt'>
  skillSnapshots: SkillSnapshot[]
  profileSnapshot?: AgentProfile
  projectSnapshot?: ProjectRunSnapshot
  startedAt: string
  finishedAt?: string
  status:
    | 'running'
    | 'stopping'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted'
  items: Activity[]
  events: { type: string; at: string; detail: string }[]
  error?: Failure
  usage?: {
    input_tokens: number
    output_tokens: number
    cached_input_tokens: number
  }
}
export interface Session {
  id: string
  workspace: string
  threadId?: string
  projectId?: string
  createdAt: string
  runs: Run[]
}
export interface AppState {
  session: Session
  diagnostics?: Diagnostics
  persistenceError?: Failure
}
export interface SkillOption {
  id: 'connectivity-proof'
  name: string
  description: string
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure }

export interface ConstellaBridge {
  workflow: WorkflowBridge
  execution: ExecutionBridge
  graphs: GraphBridge
  workspace: WorkspaceBridge
  catalog: CatalogBridge
  getState(): Promise<Result<AppState>>
  diagnose(): Promise<Result<Diagnostics>>
  run(input: RunInput): Promise<Result<{ runId: string }>>
  stop(): Promise<Result<void>>
  newSession(context?: { projectId?: string }): Promise<Result<AppState>>
  onState(callback: (state: AppState) => void): () => void
}

export const skills: SkillOption[] = [
  {
    id: 'connectivity-proof',
    name: 'Connectivity proof',
    description:
      'Read the workspace fixture and prefix the final reply with CONSTELLA_SKILL_OK.',
  },
]

export const limitations = [
  'The TypeScript SDK uses codex exec. It exposes approval policy options, but has no approval-request event or approve/deny callback. This starter uses approvalPolicy=never; restricted operations fail instead of opening an approval dialog.',
  'Events arrive at item boundaries and item updates. The SDK does not expose guaranteed token-by-token text deltas or incremental shell output. Nested tools invoked through the runtime’s exec wrapper can be absent from this stream, including denied writes; the visible feed is incomplete.',
  'Selected skill contents and resource paths are snapshotted into each prompt. There is no typed skill selection or strict skill allowlist in this SDK. Codex may also discover installed skills and inherited configuration.',
  'The SDK has no model-list or authentication API. Diagnostics use the pinned CLI login status and a short-lived app-server model/list request. Catalog entries are filtered to efforts the SDK can express; account availability is confirmed only by a real run.',
  'Stop aborts the SDK subprocess. It does not undo file changes. Continue starts a new turn in the saved Codex thread, not the interrupted process.',
  'Thread history belongs to the local Codex home. The app stores thread IDs and a bounded event transcript separately. Deleting Codex sessions, changing Codex home, or deleting a scratch workspace can prevent continuation.',
]
