import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Diagnostics } from '../../shared/contracts'
import { cliLaunch } from '../terminal/launch'

const execFileAsync = promisify(execFile)

export async function diagnose(): Promise<Diagnostics> {
  const providers = await Promise.all(
    (['codex', 'claude'] as const).map(async (provider) => {
      try {
        const launch = cliLaunch(provider)
        const path = launch.prefixArgs[0] ?? launch.executable
        // A raw .cmd wrapper can only be executed through the shell on Windows.
        const { stdout } = launch.viaShell
          ? await execFileAsync(`"${launch.executable}"`, ['--version'], {
              timeout: 8000,
              windowsHide: true,
              shell: true,
            })
          : await execFileAsync(
              launch.executable,
              [...launch.prefixArgs, '--version'],
              { timeout: 8000, windowsHide: true },
            )
        return { provider, available: true, path, version: stdout.trim() }
      } catch (error) {
        return {
          provider,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
  return {
    transport: 'Native CLI terminal',
    cliVersion: providers
      .map((provider) => `${provider.provider}: ${provider.version ?? 'not installed'}`)
      .join(' · '),
    runtimePath: providers.find((provider) => provider.available)?.path ?? '',
    auth: {
      status: 'unknown',
      detail:
        'Sign in and manage permissions inside your native CLI terminal. AgentConstella does not inspect or replace your provider login.',
    },
    models: [],
    providers,
    checkedAt: new Date().toISOString(),
  }
}
