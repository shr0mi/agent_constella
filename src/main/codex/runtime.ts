import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import {
  effortSchema,
  type Diagnostics,
  type ModelOption,
} from '../../shared/contracts'
import { describeError } from './errors'

const execFileAsync = promisify(execFile)
export const SDK_VERSION = '0.164.0'

// Resolve the same pinned native package as the SDK, independently of shell PATH.
export function runtimePath(): string {
  const require = createRequire(import.meta.url)
  const codexRequire = createRequire(
    require.resolve('@openai/codex/package.json'),
  )
  const platformPackage = codexRequire.resolve(
    `@openai/codex-${process.platform}-${process.arch}/package.json`,
  )
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const target =
    process.platform === 'darwin'
      ? `${cpu}-apple-darwin`
      : process.platform === 'win32'
        ? `${cpu}-pc-windows-msvc`
        : `${cpu}-unknown-linux-musl`
  const root = join(dirname(platformPackage), 'vendor', target)
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const current = join(root, 'bin', binary)
  const legacy = join(root, 'codex', binary)
  if (existsSync(current)) return current
  if (existsSync(legacy)) return legacy
  throw new Error(
    'Unable to locate Codex CLI binaries. Reinstall with optional dependencies.',
  )
}

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

export async function discoverModels(
  binary = runtimePath(),
): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    let settled = false
    let nextId = 2
    const models: ModelOption[] = []
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      child.kill()
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 1_000)
      forceKill.unref()
      if (error) reject(error)
      else resolve(models)
    }
    const send = (value: unknown): void => {
      child.stdin.write(`${JSON.stringify(value)}\n`)
    }
    const timer = setTimeout(
      () => finish(new Error('Model discovery timed out after 15 seconds.')),
      15_000,
    )
    child.stderr.on('data', (data) => {
      stderr = (stderr + String(data)).slice(-2_000)
    })
    child.on('error', finish)
    child.stdin.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (!settled)
        finish(new Error(`Model discovery exited (${code}): ${stderr}`))
    })
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        // This auxiliary client only lists models. Never approve server requests.
        if (message.method && message.id !== undefined) {
          send({
            id: message.id,
            error: { code: -32601, message: 'Unsupported by catalog client' },
          })
          return
        }
        if (message.id === undefined) return
        if (message.error)
          throw new Error(
            message.error.message ?? JSON.stringify(message.error),
          )
        if (message.id === 1) {
          send({ method: 'initialized', params: {} })
          send({ id: nextId, method: 'model/list', params: { limit: 100 } })
        } else {
          const page = parseModels(message.result)
          models.push(...page.models)
          if (page.nextCursor && nextId < 10) {
            send({
              id: ++nextId,
              method: 'model/list',
              params: { limit: 100, cursor: page.nextCursor },
            })
          } else finish()
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agent_constella_catalog',
          title: 'AgentConstella',
          version: '0.1.0',
        },
      },
    })
  })
}

export async function diagnose(): Promise<Diagnostics> {
  const binary = runtimePath()
  const [version, auth, catalog] = await Promise.allSettled([
    execFileAsync(binary, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    }),
    execFileAsync(binary, ['login', 'status'], {
      timeout: 10_000,
      windowsHide: true,
    }),
    discoverModels(binary),
  ])
  const authOutput =
    auth.status === 'fulfilled'
      ? `${auth.value.stdout}\n${auth.value.stderr}`
      : ''
  return {
    sdkVersion: SDK_VERSION,
    cliVersion:
      version.status === 'fulfilled'
        ? version.value.stdout.trim()
        : 'Unavailable',
    runtimePath: binary,
    auth: /logged in/i.test(authOutput)
      ? {
          status: 'signed-in',
          detail:
            'Pinned CLI reports an existing login. A real run verifies provider access.',
        }
      : {
          status: auth.status === 'rejected' ? 'missing' : 'unknown',
          detail:
            'Login could not be confirmed. Run npx codex login, then refresh. Environment API credentials are validated when a turn runs.',
        },
    models: catalog.status === 'fulfilled' ? catalog.value : [],
    modelError:
      catalog.status === 'rejected'
        ? describeError(catalog.reason).message
        : undefined,
    checkedAt: new Date().toISOString(),
  }
}
