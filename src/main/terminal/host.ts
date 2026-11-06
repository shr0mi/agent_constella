import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TerminalInput,
  TerminalRead,
  TerminalSession,
} from '../../shared/terminal'
import { cliArguments, cliPath } from './launch'
import type { AgentOptions, ThreadOptions } from './types'

type Descriptor = { port: number; key: string; version: number; pid: number }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export class TerminalHost {
  private descriptor?: Descriptor
  private starting?: Promise<void>
  private inputQueues = new Map<string, Promise<void>>()
  constructor(
    readonly directory: string,
    private readonly daemonPath: string,
    private readonly executable = process.execPath,
  ) {}
  private async request<T>(descriptor: Descriptor, input: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    })
    const result = (await response.json()) as { value: T; error?: string }
    if (!response.ok || result.error)
      throw new Error(result.error ?? 'Terminal service request failed')
    return result.value
  }
  async initialize() {
    if (this.descriptor) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const descriptorPath = join(this.directory, 'daemon.json')
      const existing = (await readFile(descriptorPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null)) as Descriptor | null
      if (existing?.version === 1) {
        try {
          await this.request(existing, { op: 'list' })
          this.descriptor = existing
          return
        } catch {
          /* Stale descriptor after a reboot or stopped service. */
        }
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const child = spawn(
        this.executable,
        [this.daemonPath, '--terminal-daemon', this.directory],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      )
      let failure: Error | undefined
      child.on('error', (error) => {
        failure = error
      })
      child.unref()
      for (let attempt = 0; attempt < 80; attempt++) {
        if (failure) throw failure
        const next = (await readFile(descriptorPath, 'utf8')
          .then(JSON.parse)
          .catch(() => null)) as Descriptor | null
        if (next && next.pid === child.pid) {
          await this.request(next, { op: 'list' })
          this.descriptor = next
          return
        }
        await delay(100)
      }
      throw new Error(
        'The terminal service did not start. Rebuild native modules with npm run rebuild:native, then restart AgentConstella.',
      )
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  async rpc<T>(input: unknown): Promise<T> {
    await this.initialize()
    return this.request<T>(this.descriptor!, input)
  }
  list() {
    return this.rpc<TerminalSession[]>({ op: 'list' })
  }
  read(input: { sessionId: string; after?: number }) {
    return this.rpc<TerminalRead>({ op: 'read', ...input })
  }
  input(input: TerminalInput) {
    // Preserve keystroke order across concurrent IPC/HTTP requests.
    const pending = (this.inputQueues.get(input.sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.rpc<void>({ op: 'input', ...input }))
    this.inputQueues.set(input.sessionId, pending)
    const clear = () => {
      if (this.inputQueues.get(input.sessionId) === pending)
        this.inputQueues.delete(input.sessionId)
    }
    void pending.then(clear, clear)
    return pending
  }
  resize(input: { sessionId: string; cols: number; rows: number }) {
    return this.rpc<void>({ op: 'resize', ...input })
  }
  finish(input: { sessionId: string; summary: string }) {
    return this.rpc<void>({ op: 'finish', ...input })
  }
  close(sessionId: string) {
    return this.rpc<void>({ op: 'close', sessionId })
  }
  setMcp(sessionId: string, mcp?: AgentOptions['mcp']) {
    return this.rpc<void>({ op: 'mcp', sessionId, mcp })
  }
  async launch(
    prompt: string,
    options: ThreadOptions,
    connection: AgentOptions,
    sessionId = randomUUID(),
  ) {
    await this.initialize()
    const provider = options.provider ?? 'codex'
    const mcpToken = randomBytes(32).toString('hex')
    const proxy = connection.mcp
      ? { url: `http://127.0.0.1:${this.descriptor!.port}/mcp/${sessionId}` }
      : undefined
    return this.rpc<TerminalSession>({
      op: 'create',
      id: sessionId,
      provider,
      role: options.role,
      title: options.title ?? `${provider} terminal`,
      cwd: options.workingDirectory,
      executable: cliPath(provider),
      args: cliArguments(provider, prompt, options, proxy),
      prompt,
      mcp: connection.mcp,
      mcpToken,
      env: {
        ...connection.env,
        ...(proxy ? { CONSTELLA_MCP_TOKEN: mcpToken } : {}),
      },
    })
  }
}
let current: TerminalHost | undefined
export function configureTerminalHost(host: TerminalHost) {
  current = host
}
export function terminalHost() {
  if (!current)
    throw new Error('The terminal service has not been initialized.')
  return current
}
