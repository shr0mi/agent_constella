import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { effortSchema, type Diagnostics, type ModelOption } from '../../shared/contracts'
import { cliPath } from '../terminal/launch'
const execFileAsync = promisify(execFile)
export const SDK_VERSION = 'Native CLI terminal'
export function runtimePath() { return cliPath('codex') }
const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
      defaultReasoningEffort: z.string(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string() }),
      ),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
})

export function parseModels(value: unknown): {
  models: ModelOption[]
  nextCursor?: string | null
} {
  const data = catalogSchema.parse(value)
  return {
    nextCursor: data.nextCursor,
    models: data.data.map((model) => ({
      id: model.model,
      name: model.displayName,
      isDefault: model.isDefault,
      efforts: model.supportedReasoningEfforts.flatMap((option) => {
        const parsed = effortSchema.safeParse(option.reasoningEffort)
        return parsed.success ? [parsed.data] : []
      }),
      defaultEffort: effortSchema.safeParse(model.defaultReasoningEffort)
        .success
        ? effortSchema.parse(model.defaultReasoningEffort)
        : undefined,
    })),
  }
}


export async function discoverModels(): Promise<ModelOption[]> { return [] }
export async function diagnose(): Promise<Diagnostics> {
  const providers = await Promise.all((['codex', 'claude'] as const).map(async provider => {
    try {
      const path = cliPath(provider)
      const { stdout } = await execFileAsync(path, ['--version'], { timeout: 5000, windowsHide: true })
      return { provider, available: true, path, version: stdout.trim() }
    } catch (error) { return { provider, available: false, error: error instanceof Error ? error.message : String(error) } }
  }))
  return {
    sdkVersion: SDK_VERSION,
    cliVersion: providers.map(p => `${p.provider}: ${p.version ?? 'not installed'}`).join(' · '),
    runtimePath: providers.find(p => p.available)?.path ?? '',
    auth: { status: 'unknown', detail: 'Sign in and manage permissions inside your native CLI terminal. AgentConstella does not inspect or replace your provider login.' },
    models: [], providers,
    checkedAt: new Date().toISOString(),
  }
}
