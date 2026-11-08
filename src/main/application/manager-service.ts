import type { AgentClient, AgentOptions } from '../terminal/types'
import { terminalHost } from '../terminal/host'
import { NativeCliClient } from '../terminal/client'
import { randomUUID } from 'node:crypto'
import {
  managerSendSchema,
  newManagerChatSchema,
  selectManagerChatSchema,
  type ManagerChat,
  type ManagerChatSummary,
  type ManagerScope,
  type ManagerTurn,
} from '../../shared/manager'
import type { WorkspaceDatabase } from '../db/database'
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
  hasActiveProject(projectId: string) {
    return [...this.active.keys()].some((key) =>
      key.startsWith(`${projectId}:`),
    )
  }
  constructor(
    private readonly database: WorkspaceDatabase,
    readonly tools: ManagerTools,
    private readonly mcp: LocalMcpServer,
    private readonly client: (options: AgentOptions) => AgentClient = (
      options,
    ) => new NativeCliClient(options),
  ) {}
  initialize() {
    const rows = this.database.sqlite
      .prepare('SELECT document, created_at FROM manager_chats')
      .all() as { document: string; created_at: string }[]
    for (const row of rows) {
      const chat = this.read(row)
      let changed = false
      for (const turn of chat.turns)
        if (
          (turn.status === 'running' || turn.status === 'stopping') &&
          !chat.threadId?.startsWith('terminal:')
        ) {
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
  async reconnect() {
    const sessions = await terminalHost().list()
    const rows = this.database.sqlite
      .prepare('SELECT document, created_at FROM manager_chats')
      .all() as { document: string; created_at: string }[]
    for (const row of rows) {
      const chat = this.read(row),
        turn = chat.turns.at(-1)
      if (
        !chat.threadId?.startsWith('terminal:') ||
        !turn ||
        !['running', 'stopping'].includes(turn.status)
      )
        continue
      const live = sessions.find(
        (s) => s.id === chat.threadId!.slice(9) && s.state !== 'exited',
      )
      if (!live) {
        turn.status = 'interrupted'
        turn.finishedAt = new Date().toISOString()
        this.persist(chat)
        continue
      }
      chat.provider = live.provider
      const scope = { projectId: chat.projectId, taskId: chat.taskId }
      const connection = this.mcp.issue(scope)
      const active: Active = {
        controller: new AbortController(),
        release: connection.release,
      }
      this.active.set(this.key(scope), active)
      active.done = this.execute(
        chat,
        turn,
        active,
        this.client(connection.options),
        live.cwd,
        undefined,
        undefined,
        true,
      ).finally(() => {
        connection.release()
        this.active.delete(this.key(scope))
        this.notify(scope)
      })
    }
  }
  subscribe(listener: (scope: ManagerScope) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notify(scope: ManagerScope) {
    if (this.database.sqlite.inTransaction) {
      queueMicrotask(() => this.notify(scope))
      return
    }
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
  private read(row: { document: string; created_at: string }): ManagerChat {
    return { ...JSON.parse(row.document), createdAt: row.created_at }
  }
  private fresh(scope: ManagerScope): ManagerChat {
    return {
      ...scope,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      turns: [],
    }
  }
  get(raw: unknown): ManagerChat {
    const scope = this.tools.scope(raw)
    const row = this.database.sqlite
      .prepare(
        'SELECT document, created_at FROM manager_chats WHERE project_id = ? AND task_id IS ? AND is_current = 1',
      )
      .get(scope.projectId, scope.taskId) as
      { document: string; created_at: string } | undefined
    if (row) return this.read(row)
    const chat = this.fresh(scope)
    this.persist(chat)
    return chat
  }
  list(raw: unknown): ManagerChatSummary[] {
    const scope = this.tools.scope(raw)
    const rows = this.database.sqlite
      .prepare(
        `
      SELECT id, is_current, created_at,
        substr(json_extract(document, '$.turns[0].message'), 1, 100) AS title,
        json_array_length(document, '$.turns') AS turn_count,
        COALESCE(json_extract(document, '$.turns[#-1].finishedAt'), json_extract(document, '$.turns[#-1].startedAt'), created_at) AS updated_at
      FROM manager_chats WHERE project_id = ? AND task_id IS ?
      ORDER BY is_current DESC, rowid DESC
    `,
      )
      .all(scope.projectId, scope.taskId) as {
      id: string
      is_current: number
      created_at: string
      title: string | null
      turn_count: number
      updated_at: string
    }[]
    return rows.map((row) => ({
      ...scope,
      id: row.id,
      current: row.is_current === 1,
      title: row.title?.trim() || 'New conversation',
      turnCount: row.turn_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
  private switchable(scope: ManagerScope, expectedChatId: string) {
    if (this.closing || this.active.has(this.key(scope)))
      throw new ApplicationError(
        'MANAGER_BUSY',
        'This manager has an active turn.',
        'Stop it or wait for it to finish before changing conversations.',
      )
    const current = this.get(scope)
    if (current.id !== expectedChatId)
      throw new ApplicationError(
        'STALE_MANAGER_CHAT',
        'The selected manager conversation changed.',
        'Review the current conversation before trying again. Your draft is retained.',
      )
    return current
  }
  newChat(raw: unknown): ManagerChat {
    const input = newManagerChatSchema.parse(raw)
    const scope = this.tools.scope({
      projectId: input.projectId,
      taskId: input.taskId,
    })
    return this.database.sqlite
      .transaction(() => {
        this.switchable(scope, input.expectedChatId)
        const chat = this.fresh(scope)
        this.database.sqlite
          .prepare(
            'UPDATE manager_chats SET is_current = 0 WHERE project_id = ? AND task_id IS ? AND is_current = 1',
          )
          .run(scope.projectId, scope.taskId)
        this.persist(chat)
        return chat
      })
      .immediate()
  }
  selectChat(raw: unknown): ManagerChat {
    const input = selectManagerChatSchema.parse(raw)
    const scope = this.tools.scope({
      projectId: input.projectId,
      taskId: input.taskId,
    })
    return this.database.sqlite
      .transaction(() => {
        const current = this.switchable(scope, input.expectedChatId)
        if (current.id === input.chatId) return current
        const row = this.database.sqlite
          .prepare(
            'SELECT document, created_at FROM manager_chats WHERE id = ? AND project_id = ? AND task_id IS ?',
          )
          .get(input.chatId, scope.projectId, scope.taskId) as
          { document: string; created_at: string } | undefined
        if (!row)
          throw new ApplicationError(
            'MANAGER_CHAT_NOT_FOUND',
            'This conversation does not belong to this manager or no longer exists.',
            'Choose a saved conversation from this project or task.',
          )
        this.database.sqlite
          .prepare(
            'UPDATE manager_chats SET is_current = 0 WHERE project_id = ? AND task_id IS ? AND is_current = 1',
          )
          .run(scope.projectId, scope.taskId)
        this.database.sqlite
          .prepare('UPDATE manager_chats SET is_current = 1 WHERE id = ?')
          .run(input.chatId)
        this.notify(scope)
        return this.read(row)
      })
      .immediate()
  }
  private persist(chat: ManagerChat) {
    const document = JSON.stringify(chat)
    const updated = this.database.sqlite
      .prepare(
        'UPDATE manager_chats SET document = ? WHERE id = ? AND project_id = ? AND task_id IS ?',
      )
      .run(document, chat.id, chat.projectId, chat.taskId)
    if (!updated.changes)
      this.database.sqlite
        .prepare(
          'INSERT INTO manager_chats (id, project_id, task_id, document, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(chat.id, chat.projectId, chat.taskId, document, chat.createdAt)
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
    const chat = this.get(scope)
    if (input.chatId && input.chatId !== chat.id)
      throw new ApplicationError(
        'STALE_MANAGER_CHAT',
        'The selected manager conversation changed.',
        'Review the current conversation before sending again. Your draft is retained.',
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
        packet.models.length > 0 &&
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
    client: AgentClient,
    repoPath: string,
    model?: string,
    effort?: Parameters<AgentClient['startThread']>[0]['modelReasoningEffort'],
    attachOnly = false,
  ) {
    let completed = false
    try {
      chat.provider ??= this.tools.contextProvider(chat.projectId)
      const options = {
        attachOnly,
        role: 'manager' as const,
        workingDirectory: repoPath,
        provider: chat.provider,
        title: chat.taskId ? 'Task manager' : 'Project manager',
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
        throw new Error(
          'The manager terminal ended without handing back its assignment.',
        )
      turn.status = completed ? 'completed' : 'cancelled'
    } catch (error) {
      turn.status = completed
        ? 'completed'
        : active.controller.signal.aborted
          ? 'cancelled'
          : 'failed'
      if (turn.status === 'failed') turn.error = applicationFailure(error)
    } finally {
      if (active.controller.signal.reason === 'detach') return
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
  async shutdown(detach = false) {
    this.closing = true
    for (const active of this.active.values()) {
      active.release?.()
      active.controller.abort(detach ? 'detach' : undefined)
    }
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.done),
    )
  }
}
