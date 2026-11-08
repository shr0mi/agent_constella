import { z } from 'zod'
import { providerSchema, type TerminalBridge } from './terminal'
import type { WorkspaceBridge } from './workspace'
import type { GraphBridge } from './graph'
import type { ExecutionBridge } from './execution'
import type { WorkflowBridge } from './workflow'
import type { ManagerBridge } from './manager'
import type {
  AgentProfile,
  CatalogBridge,
  ProjectRunSnapshot,
  SkillSnapshot,
} from './catalog'

// Persisted effort values; the selected native CLI validates provider support.
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
    provider: providerSchema.optional(),
    prompt: z.string().trim().min(1).max(32_000),
    model: z.string().trim().min(1).max(160).nullable().optional(),
    effort: effortSchema.nullable().optional(),
    profileId: z.uuid().optional(),
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
  transport: string
  providers?: { provider: 'codex' | 'claude'; available: boolean; path?: string; version?: string; error?: string }[]
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
  terminal: TerminalBridge
  manager: ManagerBridge
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
  'Agent nodes run your installed Codex or Claude Code CLI in real PTY terminals. Authentication, native commands, permissions and model availability belong to that CLI.',
  'Hand work back through agent_report_done or Finish step before checks and acceptance. Quiet output or a finished response does not imply workflow completion.',
  'Terminal sessions and local screen transcripts live in private app data. Closing a pane detaches; Stop ends the CLI process. A reboot ends processes; saved project state and transcripts remain.',
  'Worktrees isolate code changes, not operating-system permissions. Use the native CLI permission controls.',
]
