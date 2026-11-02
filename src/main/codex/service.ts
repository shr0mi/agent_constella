import type { ThreadItem, ThreadOptions, AgentClient } from '../terminal/types'
import { NativeCliClient } from '../terminal/client'
import { terminalHost } from '../terminal/host'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runInputSchema,
  type Activity,
  type AppState,
  type Run,
  type RunInput,
} from '../../shared/contracts'
import { describeError } from './errors'
import { diagnose } from './runtime'
import { resolvePrompt, stageSkills } from './skills'
import { SessionStore } from './storage'
import type {
  CatalogRunResolver,
  PreparedCatalogRun,
} from '../../shared/catalog'

export type CodexClient = AgentClient

const clip = (text: string): string =>
  text.length > 24_000
    ? `${text.slice(0, 24_000)}\n[truncated in app transcript]`
    : text

export function toActivity(item: ThreadItem): Activity {
  const base = { id: item.id, type: item.type }
  switch (item.type) {
    case 'agent_message':
      return { ...base, title: 'Agent', text: clip(item.text) }
    case 'reasoning':
      return { ...base, title: 'Reasoning summary', text: clip(item.text) }
    case 'command_execution':
      return {
        ...base,
        title: item.command,
        text: clip(item.aggregated_output),
        status:
          typeof item.exit_code === 'number'
            ? `${item.status} · exit ${item.exit_code}`
            : item.status,
      }
    case 'file_change':
      return {
        ...base,
        title: 'File changes',
        text: item.changes
          .map((change) => `${change.kind} ${change.path}`)
          .join('\n'),
        status: item.status,
      }
    case 'mcp_tool_call':
      return {
        ...base,
        title: `${item.server} / ${item.tool}`,
        text: clip(
          JSON.stringify(
            {
              arguments: item.arguments,
              result: item.result,
              error: item.error,
            },
            null,
            2,
          ),
        ),
        status: item.status,
      }
    case 'todo_list':
      return {
        ...base,
        title: 'Plan',
        text: item.items
          .map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`)
          .join('\n'),
      }
    case 'web_search':
      return { ...base, title: 'Web search', text: item.query }
    case 'error':
      return {
        ...base,
        title: 'Tool error',
        text: item.message,
        status: 'failed',
      }
  }
}

export class ConnectivityService {
  hasActiveProject(projectId: string) {
    return (
      this.resetting ||
      (!!this.active && this.state.session.projectId === projectId)
    )
  }
  private state!: AppState
  private active?: { controller: AbortController; done?: Promise<void> }
  private resetting = false
  private listeners = new Set<(state: AppState) => void>()

  constructor(
    private readonly store: SessionStore,
    private readonly client: CodexClient = new NativeCliClient(),
    private readonly resolveCatalog?: CatalogRunResolver,
  ) {}

  async initialize(): Promise<void> {
    const saved = await this.store.read()
    let reconnect: Run | undefined
    if (saved) {
      this.state = { session: saved }
      for (const run of saved.runs) {
        if (run.status === 'running' || run.status === 'stopping') {
          if (
            this.client instanceof NativeCliClient &&
            saved.threadId?.startsWith('terminal:')
          ) {
            const live = (await terminalHost().list()).find(
              (session) =>
                session.id === saved.threadId!.slice(9) &&
                session.state !== 'exited',
            )
            if (live) {
              reconnect = run
              continue
            }
          }
          run.status = 'interrupted'
          run.finishedAt = new Date().toISOString()
          run.error = {
            code: 'INTERRUPTED',
            message: 'The app closed while this turn was active.',
            hint: 'Continue explicitly to send a new turn to the saved thread. Work is never rerun automatically.',
          }
        }
      }
      await this.persist()
    } else await this.createSession()
    if (reconnect) {
      const active = {
        controller: new AbortController(),
        done: undefined as Promise<void> | undefined,
      }
      this.active = active
      active.done = this.execute(reconnect, active.controller, true).finally(
        () => {
          if (this.active === active) this.active = undefined
          this.emit()
        },
      )
    }
  }

  snapshot(): AppState {
    return structuredClone(this.state)
  }
  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void {
    const state = this.snapshot()
    this.listeners.forEach((listener) => listener(state))
  }
  private async persist(): Promise<void> {
    try {
      await this.store.write(this.state.session)
      delete this.state.persistenceError
    } catch (error) {
      this.state.persistenceError = {
        code: 'STORAGE',
        message: describeError(error).message,
        hint: 'Conversation metadata could not be saved. Restore access to the app data directory before continuing.',
      }
      this.emit()
      throw error
    }
    this.emit()
  }

  async refreshDiagnostics() {
    this.state.diagnostics = await diagnose()
    this.emit()
    return this.state.diagnostics
  }

  private async createSession(projectId?: string): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-constella-'))
    const id = randomUUID()
    await writeFile(
      join(workspace, 'workspace-proof.txt'),
      'Proof word: ORBIT\nThis disposable directory belongs to the AgentConstella connectivity exercise.\n',
    )
    await writeFile(join(workspace, '.constella-session'), id)
    const previousDiagnostics = this.state?.diagnostics
    this.state = {
      session: {
        id,
        workspace,
        projectId,
        createdAt: new Date().toISOString(),
        runs: [],
      },
      diagnostics: previousDiagnostics,
    }
    await this.persist()
  }

  async newSession(projectId?: string): Promise<AppState> {
    if (this.active || this.resetting)
      throw new Error(
        'Stop the current turn before creating a new scratch session.',
      )
    this.resetting = true
    try {
      await this.store.archive(this.state.session)
      await this.createSession(projectId)
      return this.snapshot()
    } finally {
      this.resetting = false
    }
  }

  async start(raw: RunInput): Promise<{ runId: string }> {
    const input = runInputSchema.parse(raw)
    if (this.active || this.resetting)
      throw new Error(
        'A turn is already active. Stop it before starting another.',
      )
    const controller = new AbortController()
    // Claim the single execution slot before the first asynchronous operation.
    const active = { controller, done: undefined as Promise<void> | undefined }
    this.active = active
    let createdRun: Run | undefined
    try {
      const workspace = this.state.session.workspace
      if (!(await stat(workspace)).isDirectory())
        throw new Error(
          'The scratch workspace is missing. Create a new scratch session.',
        )
      if (
        (await readFile(join(workspace, '.constella-session'), 'utf8')) !==
        this.state.session.id
      )
        throw new Error(
          'Scratch workspace ownership could not be verified. Create a new scratch session.',
        )
      // Native discovery must not retain a previously selected demo skill on later turns.
      if (!input.skillIds.includes('connectivity-proof'))
        await rm(join(workspace, '.agents', 'skills', 'connectivity-proof'), {
          recursive: true,
          force: true,
        })
      const runId = randomUUID()
      let prepared: PreparedCatalogRun = {
        skillSnapshots: [],
        model: input.model ?? undefined,
        effort: input.effort ?? undefined,
      }
      if (this.resolveCatalog)
        prepared = await this.resolveCatalog(
          input,
          workspace,
          runId,
          this.state.session.projectId,
        )
      else if (
        input.profileId ||
        input.skillIds.some((id) => id !== 'connectivity-proof')
      )
        throw new Error('Catalog selection is unavailable in this runtime.')
      if (prepared.effort && !prepared.model)
        throw new Error(
          'Select a model from the runtime catalog before setting an effort.',
        )
      if (prepared.model && (this.state.diagnostics?.models.length ?? 0) > 0) {
        const model = this.state.diagnostics?.models.find(
          (model) => model.id === prepared.model,
        )
        if (
          !model ||
          (prepared.effort && !model.efforts.includes(prepared.effort))
        )
          throw new Error(
            'Selected model or reasoning effort is not in the runtime catalog. Refresh diagnostics or use the configured default.',
          )
      }
      const snapshots = [
        ...(await stageSkills(workspace, input.skillIds)),
        ...prepared.skillSnapshots,
      ]
      const { prompt, ...options } = input
      const run: Run = {
        id: runId,
        prompt,
        resolvedPrompt: resolvePrompt(prompt, snapshots, prepared),
        options: {
          ...options,
          model: prepared.model,
          effort: prepared.effort,
          skillIds: snapshots.map((skill) => skill.id),
        },
        skillSnapshots: snapshots,
        profileSnapshot: prepared.profileSnapshot,
        projectSnapshot: prepared.projectSnapshot,
        startedAt: new Date().toISOString(),
        status: controller.signal.aborted ? 'stopping' : 'running',
        items: [],
        events: [],
      }
      createdRun = run
      this.state.session.runs.push(run)
      await this.persist()
      active.done = this.execute(run, controller).finally(() => {
        if (this.active === active) this.active = undefined
        this.emit()
      })
      return { runId: run.id }
    } catch (error) {
      if (createdRun) {
        createdRun.status = 'failed'
        createdRun.finishedAt = new Date().toISOString()
        createdRun.error = describeError(error)
      }
      if (this.active === active) this.active = undefined
      this.emit()
      throw error
    }
  }

  private async execute(
    run: Run,
    controller: AbortController,
    attachOnly = false,
  ): Promise<void> {
    let completed = false
    try {
      const options: ThreadOptions = {
        role: 'lab',
        attachOnly,
        workingDirectory: this.state.session.workspace,
        provider:
          run.options.provider ??
          run.projectSnapshot?.defaultProvider ??
          'codex',
        title: 'Terminal lab',
        skipGitRepoCheck: true,
        sandboxMode: run.options.sandbox,
        model: run.options.model ?? undefined,
        modelReasoningEffort: run.options.effort ?? undefined,
      }
      const thread = this.state.session.threadId
        ? this.client.resumeThread(this.state.session.threadId, options)
        : this.client.startThread(options)
      const { events } = await thread.runStreamed(run.resolvedPrompt, {
        signal: controller.signal,
      })
      for await (const event of events) {
        run.events.push({
          type: event.type,
          at: new Date().toISOString(),
          detail: clip(JSON.stringify(event)),
        })
        run.events = run.events.slice(-300)
        if (event.type === 'thread.started')
          this.state.session.threadId = event.thread_id
        if ('item' in event) {
          const item = toActivity(event.item)
          const index = run.items.findIndex(
            (existing) => existing.id === item.id,
          )
          if (index < 0) run.items.push(item)
          else run.items[index] = item
        }
        if (event.type === 'turn.completed') {
          completed = true
          run.usage = event.usage
        }
        if (event.type === 'turn.failed') throw new Error(event.error.message)
        if (event.type === 'error') throw new Error(event.message)
        await this.persist()
      }
      if (!completed && !controller.signal.aborted)
        throw new Error(
          'The agent session ended without handing back its result.',
        )
      run.status = completed ? 'completed' : 'cancelled'
    } catch (error) {
      if (completed) run.status = 'completed'
      else if (controller.signal.aborted) run.status = 'cancelled'
      else {
        run.status = 'failed'
        run.error = describeError(error)
      }
    } finally {
      if (controller.signal.reason === 'detach') return
      run.finishedAt = new Date().toISOString()
      // A storage failure must remain visible and cannot become an unhandled background rejection.
      try {
        await this.persist()
      } catch {
        this.emit()
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return
    const run = this.state.session.runs.at(-1)
    if (run && run.status === 'running') run.status = 'stopping'
    this.active.controller.abort()
    await this.persist()
  }

  async waitForIdle(): Promise<void> {
    await this.active?.done
  }
  async shutdown(detach = false): Promise<void> {
    if (detach) this.active?.controller.abort('detach')
    else await this.stop()
    await this.waitForIdle()
  }
}
