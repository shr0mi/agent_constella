import { Codex, type CodexOptions } from '@openai/codex-sdk'
import { randomUUID } from 'node:crypto'
import {
  managerSendSchema,
  type ManagerChat,
  type ManagerScope,
  type ManagerTurn,
} from '../../shared/manager'
import type { WorkspaceDatabase } from '../db/database'
import type { CodexClient } from '../codex/service'
import { toActivity } from '../codex/service'
import { applicationFailure, ApplicationError } from './errors'
import { ManagerTools, managerInstructions } from './manager-tools'
import type { LocalMcpServer } from '../mcp/server'
import { resolveModelSettings } from '../../shared/model-settings'

type Active = {
  controller: AbortController
  done?: Promise<void>
  release?: () => void
}
export class ManagerService {
  private active = new Map<string, Active>()
  private listeners = new Set<(scope: ManagerScope) => void>()
  private closing = false
  constructor(
    private readonly database: WorkspaceDatabase,
    readonly tools: ManagerTools,
    private readonly mcp: LocalMcpServer,
    private readonly client: (options: CodexOptions) => CodexClient = (
      options,
    ) => new Codex(options),
  ) {}
  initialize() {
    const rows = this.database.sqlite
      .prepare('SELECT document FROM manager_chats')
      .all() as { document: string }[]
    for (const row of rows) {
      const chat = JSON.parse(row.document) as ManagerChat
      let changed = false
      for (const turn of chat.turns)
        if (turn.status === 'running' || turn.status === 'stopping') {
          turn.status = 'interrupted'
          turn.finishedAt = new Date().toISOString()
          turn.error = {
            code: 'INTERRUPTED',
            message: 'The app closed during this manager turn.',
            hint: 'Review saved changes and continue explicitly. Edits already saved remain in history.',
          }
          changed = true
        }
      if (changed) this.persist(chat)
    }
  }
  subscribe(listener: (scope: ManagerScope) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notify(scope: ManagerScope) {
    for (const listener of this.listeners) {
      try {
        listener(scope)
      } catch (error) {
        console.error('Manager notification failed:', error)
      }
    }
  }
  private key(scope: ManagerScope) {
    return `${scope.projectId}:${scope.taskId ?? 'board'}`
  }
  get(raw: unknown): ManagerChat {
    const scope = this.tools.scope(raw)
    const row = this.database.sqlite
      .prepare(
        'SELECT document FROM manager_chats WHERE project_id = ? AND task_id IS ?',
      )
      .get(scope.projectId, scope.taskId) as { document: string } | undefined
    if (row) return JSON.parse(row.document) as ManagerChat
    const chat: ManagerChat = { ...scope, id: randomUUID(), turns: [] }
    this.persist(chat)
    return chat
  }
  private persist(chat: ManagerChat) {
    this.database.sqlite
      .prepare(
        'INSERT INTO manager_chats (id, project_id, task_id, document) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document',
      )
      .run(chat.id, chat.projectId, chat.taskId, JSON.stringify(chat))
    this.notify({ projectId: chat.projectId, taskId: chat.taskId })
  }
  async send(raw: unknown) {
    const input = managerSendSchema.parse(raw),
      scope = this.tools.scope({
        projectId: input.projectId,
        taskId: input.taskId,
      })
    const key = this.key(scope)
    if (this.closing || this.active.has(key))
      throw new ApplicationError(
        'MANAGER_BUSY',
        'This manager already has an active turn.',
        'Stop it or wait for it to finish.',
      )
    const active: Active = { controller: new AbortController() }
    this.active.set(key, active)
    let release: (() => void) | undefined
    let created: { chat: ManagerChat; turn: ManagerTurn } | undefined
    try {
      const packet = await this.tools.context(
        scope,
        input.selectedNodeId ?? undefined,
      )
      const settings = resolveModelSettings(input, undefined, packet.project)
      if (settings.effort && !settings.model)
        throw new Error('Select a model before setting reasoning effort.')
      if (
        settings.model &&
        !packet.models.some(
          (model) =>
            model.id === settings.model &&
            (!settings.effort || model.efforts.includes(settings.effort)),
        )
      )
        throw new Error(
          'Refresh model options and select a supported model/effort.',
        )
      active.controller.signal.throwIfAborted()
      const chat = this.get(scope)
      const turn: ManagerTurn = {
        id: randomUUID(),
        message: input.message,
        context: JSON.stringify(packet),
        startedAt: new Date().toISOString(),
        status: 'running',
        items: [],
      }
      chat.turns.push(turn)
      created = { chat, turn }
      this.persist(chat)
      const connection = this.mcp.issue(scope)
      release = connection.release
      active.release = release
      const client = this.client(connection.options)
      active.done = this.execute(
        chat,
        turn,
        active,
        client,
        packet.project.repoPath,
        settings.model,
        settings.effort,
      ).finally(() => {
        connection.release()
        this.active.delete(key)
        this.notify(scope)
      })
      return { turnId: turn.id }
    } catch (error) {
      if (created) {
        created.turn.status = active.controller.signal.aborted
          ? 'cancelled'
          : 'failed'
        created.turn.finishedAt = new Date().toISOString()
        created.turn.error = applicationFailure(error)
        try {
          this.persist(created.chat)
        } catch (storageError) {
          console.error('Manager failure could not be saved:', storageError)
        }
      }
      release?.()
      this.active.delete(key)
      throw error
    }
  }
  private async execute(
    chat: ManagerChat,
    turn: ManagerTurn,
    active: Active,
    client: CodexClient,
    repoPath: string,
    model?: string,
    effort?: Parameters<CodexClient['startThread']>[0]['modelReasoningEffort'],
  ) {
    let completed = false
    try {
      const options = {
        workingDirectory: repoPath,
        skipGitRepoCheck: false,
        sandboxMode: 'read-only' as const,
        approvalPolicy: 'never' as const,
        networkAccessEnabled: false,
        webSearchMode: 'disabled' as const,
        model,
        modelReasoningEffort: effort,
      }
      const thread = chat.threadId
        ? client.resumeThread(chat.threadId, options)
        : client.startThread(options)
      const { events } = await thread.runStreamed(
        `${managerInstructions}\n\nCurrent application context (refresh through MCP as needed):\n${turn.context}\n\nUser request:\n${turn.message}`,
        { signal: active.controller.signal },
      )
      for await (const event of events) {
        if (event.type === 'thread.started') chat.threadId = event.thread_id
        if ('item' in event) {
          const activity = toActivity(event.item),
            index = turn.items.findIndex((item) => item.id === activity.id)
          if (index < 0) turn.items.push(activity)
          else turn.items[index] = activity
        }
        if (event.type === 'turn.completed') completed = true
        if (event.type === 'turn.failed') throw new Error(event.error.message)
        if (event.type === 'error') throw new Error(event.message)
        this.persist(chat)
      }
      if (!completed && !active.controller.signal.aborted)
        throw new Error('Codex ended without completing the manager turn.')
      turn.status = completed ? 'completed' : 'cancelled'
    } catch (error) {
      turn.status = completed
        ? 'completed'
        : active.controller.signal.aborted
          ? 'cancelled'
          : 'failed'
      if (turn.status === 'failed') turn.error = applicationFailure(error)
    } finally {
      turn.finishedAt = new Date().toISOString()
      try {
        this.persist(chat)
      } catch (error) {
        console.error('Manager transcript could not be saved:', error)
      }
    }
  }
  async stop(raw: unknown) {
    const scope = this.tools.scope(raw),
      active = this.active.get(this.key(scope))
    if (!active) return
    active.release?.()
    active.controller.abort()
    await active.done
  }
  async shutdown() {
    this.closing = true
    for (const active of this.active.values()) {
      active.release?.()
      active.controller.abort()
    }
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.done),
    )
  }
}
