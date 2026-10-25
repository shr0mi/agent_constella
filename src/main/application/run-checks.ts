import { spawn } from 'node:child_process'
import type { TestResult } from '../../shared/execution'

// Only the explicitly saved project test command is executed by this runner.
export function runChecks(
  command: string,
  cwd: string,
  signal: AbortSignal,
  onUpdate: (result: TestResult) => void,
  timeoutMs = 120_000,
): Promise<TestResult> {
  if (!command.trim() || signal.aborted)
    return Promise.resolve({
      command,
      status: signal.aborted ? 'cancelled' : 'not-run',
      output: '',
      exitCode: null,
      truncated: false,
    })
  return new Promise((resolve) => {
    const result: TestResult = {
      command,
      status: 'running',
      output: '',
      exitCode: null,
      truncated: false,
      startedAt: new Date().toISOString(),
    }
    let timedOut = false,
      killTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })
    const terminate = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        })
        return
      }
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* Already exited. */
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }, 1000)
      killTimer.unref()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const collect = (data: Buffer) => {
      const remaining = 64_000 - result.output.length
      result.output += data.toString().slice(0, Math.max(0, remaining))
      if (data.length > remaining) result.truncated = true
      onUpdate(structuredClone(result))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      collect(Buffer.from(error.message))
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', terminate)
      result.exitCode = code
      result.finishedAt = new Date().toISOString()
      result.status = signal.aborted
        ? 'cancelled'
        : timedOut
          ? 'timed-out'
          : code === 0
            ? 'passed'
            : 'failed'
      onUpdate(structuredClone(result))
      resolve(result)
    })
    signal.addEventListener('abort', terminate, { once: true })
    if (signal.aborted) terminate()
    onUpdate(structuredClone(result))
  })
}
