import { TerminalPane } from './components/TerminalPane'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  History,
  LoaderCircle,
  Plus,
  Send,
  Square,
  Undo2,
  X,
} from 'lucide-react'
import type {
  ChangeEntry,
  ManagerChat as Chat,
  ManagerChatSummary,
  ManagerScope,
} from '../../shared/manager'
import type { Effort, Result } from '../../shared/contracts'
import type { GraphDocument } from '../../shared/graph'
import type { Task } from '../../shared/workspace'
import { refreshDiagnostics, useAppStore } from './store'
import { useWorkspaceStore } from './workspace-store'
import { resolveModelSettings } from '../../shared/model-settings'

export function ManagerChat({
  projectId,
  taskId = null,
  selectedNodeId,
  blockedReason,
}: ManagerScope & { selectedNodeId?: string; blockedReason?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="button secondary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Bot size={14} />
        {taskId ? 'Task manager' : 'Project manager'}
      </button>
      {open && (
        <ManagerPanel
          key={`${projectId}:${taskId}`}
          scope={{ projectId, taskId }}
          selectedNodeId={selectedNodeId}
          blockedReason={blockedReason}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
function changeDescription(entry: ChangeEntry) {
  if (entry.kind === 'project') {
    const labels = [
      ['name', 'Name'],
      ['description', 'Project brief'],
      ['instructions', 'Instructions'],
      ['devCommand', 'Development/run command'],
      ['testCommand', 'Test command'],
      ['defaultProvider', 'Default provider'],
      ['defaultModel', 'Default model'],
      ['defaultEffort', 'Default effort'],
    ] as const
    return (
      labels
        .filter(([key]) => entry.before[key] !== entry.after[key])
        .map(([, label]) => label)
        .join(' · ') || entry.after.name
    )
  }
  if (entry.kind === 'task') return (entry.after as Task).title
  const before = entry.before as GraphDocument,
    after = entry.after as GraphDocument
  const added = after.nodes.filter(
    (node) => !before.nodes.some((other) => other.id === node.id),
  )
  const removed = before.nodes.filter(
    (node) => !after.nodes.some((other) => other.id === node.id),
  )
  const edited = after.nodes.filter((node) =>
    before.nodes.some(
      (other) =>
        other.id === node.id && JSON.stringify(other) !== JSON.stringify(node),
    ),
  )
  return (
    [
      added.length
        ? `Added ${added.map((node) => node.data.title).join(', ')}`
        : '',
      removed.length
        ? `Removed ${removed.map((node) => node.data.title).join(', ')}`
        : '',
      edited.length
        ? `Updated ${edited.map((node) => node.data.title).join(', ')}`
        : '',
      JSON.stringify(before.edges) !== JSON.stringify(after.edges)
        ? 'Connections changed'
        : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Canvas updated'
  )
}
function ManagerPanel({
  scope,
  selectedNodeId,
  blockedReason,
  onClose,
}: {
  scope: ManagerScope
  selectedNodeId?: string
  blockedReason?: string
  onClose: () => void
}) {
  const [chat, setChat] = useState<Chat>()
  const [chats, setChats] = useState<ManagerChatSummary[]>([])
  const [history, setHistory] = useState<ChangeEntry[]>([])
  const [tab, setTab] = useState<'chat' | 'history'>('chat')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const runtimeModels = useAppStore((state) => state.state?.diagnostics?.models)
  const models = runtimeModels ?? []
  const project = useWorkspaceStore((state) =>
    state.snapshot?.projects.find((project) => project.id === scope.projectId),
  )
  const modelOverride = model === '__configured__' ? null : model || undefined
  const effortOverride =
    effort === '__default__'
      ? null
      : ((effort || undefined) as Effort | undefined)
  const effective = resolveModelSettings(
    { model: modelOverride, effort: effortOverride },
    undefined,
    project,
  )
  const bottom = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    request = useRef(0)
  const scopeKey = `${scope.projectId}:${scope.taskId}`
  const latest = chat?.turns.at(-1)
  const active = latest?.status === 'running' || latest?.status === 'stopping'
  async function value<T>(promise: Promise<Result<T>>) {
    const result = await promise
    if (!result.ok)
      throw new Error(`${result.error.message}\n${result.error.hint}`)
    return result.value
  }
  const refresh = useCallback(async () => {
    const id = ++request.current
    try {
      const api = window.constella?.manager
      if (!api?.list || !api.newChat || !api.selectChat)
        throw new Error('Manager chat is unavailable. Restart the desktop app.')
      const results = await Promise.all([
        value(api.get(scope)),
        value(api.history(scope)),
        value(api.list(scope)),
      ])
      if (alive.current && id === request.current) {
        setChat(results[0])
        setHistory(results[1])
        setChats(results[2])
      }
    } catch (error) {
      if (alive.current) setError(String(error))
    }
  }, [scopeKey])
  useEffect(() => {
    alive.current = true
    void refresh()
    const api = window.constella
    const subscriptions = [
      api?.manager?.onChange((changed) => {
        if (
          changed.projectId === scope.projectId &&
          changed.taskId === scope.taskId
        )
          void refresh()
      }),
      api?.workspace.onChange(() => void refresh()),
      api?.graphs.onChange((changed) => {
        if (
          changed.projectId === scope.projectId &&
          (!scope.taskId || changed.taskId === scope.taskId)
        )
          void refresh()
      }),
    ]
    return () => {
      alive.current = false
      request.current++
      subscriptions.forEach((unsubscribe) => unsubscribe?.())
    }
  }, [refresh])
  useEffect(() => {
    if (tab === 'chat') bottom.current?.scrollIntoView({ block: 'end' })
  }, [chat, tab])
  const launching = useRef(new Set<string>())
  useEffect(() => {
    if (
      !chat ||
      chat.turns.length ||
      blockedReason ||
      launching.current.has(chat.id)
    )
      return
    launching.current.add(chat.id)
    void value(
      window.constella!.manager.send({
        ...scope,
        chatId: chat.id,
        selectedNodeId: selectedNodeId ?? null,
        message:
          'Read the current application context through MCP, then wait for my instructions. Do not change anything until I ask.',
      }),
    )
      .then(() => refresh())
      .catch((error) => {
        if (alive.current) setError(String(error))
      })
  }, [chat?.id, blockedReason])
  async function act(action: () => Promise<unknown>) {
    setPending(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (error) {
      if (alive.current) setError(String(error))
      await refresh()
    } finally {
      if (alive.current) setPending(false)
    }
  }
  return (
    <aside
      className="manager-panel"
      aria-label={scope.taskId ? 'Task manager chat' : 'Project manager chat'}
    >
      <header>
        <div>
          <Bot size={18} />
          <strong>{scope.taskId ? 'Task manager' : 'Project manager'}</strong>
        </div>
        <div className="manager-header-actions">
          <button
            className="button secondary"
            disabled={pending || active || !chat || chat.turns.length === 0}
            title={
              active
                ? 'Finish the manager assignment or stop its terminal before starting a new chat.'
                : 'Start a fresh conversation and keep this one in saved chats.'
            }
            onClick={() => {
              if (!chat) return
              void act(async () => {
                const next = await value(
                  window.constella!.manager.newChat({
                    ...scope,
                    expectedChatId: chat.id,
                  }),
                )
                setChat(next)
                setMessage('')
                setModel('')
                setEffort('')
                setTab('chat')
              })
            }}
          >
            <Plus size={13} />
            New chat
          </button>
          <button
            className="icon-button"
            aria-label="Close manager chat"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      <p className="manager-caption">
        Plan and edit your{' '}
        {scope.taskId ? 'task workflow' : 'project board and settings'}. Changes
        save immediately and appear in history.
      </p>
      {chat && chats.length > 1 && (
        <div className="manager-conversation-picker">
          <label htmlFor="manager-conversation">Saved chats</label>
          <select
            id="manager-conversation"
            aria-label="Saved manager chats"
            value={chat.id}
            disabled={pending || active}
            onChange={(event) => {
              const chatId = event.target.value
              void act(async () => {
                const next = await value(
                  window.constella!.manager.selectChat({
                    ...scope,
                    expectedChatId: chat.id,
                    chatId,
                  }),
                )
                setChat(next)
                setMessage('')
                setModel('')
                setEffort('')
                setTab('chat')
              })
            }}
          >
            {chats.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title} ·{' '}
                {new Date(conversation.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
          <small>Each message uses the current saved project state.</small>
        </div>
      )}
      <nav aria-label="Manager views">
        <button
          className={tab === 'chat' ? 'selected' : ''}
          onClick={() => setTab('chat')}
        >
          <Bot size={13} />
          Conversation
        </button>
        <button
          className={tab === 'history' ? 'selected' : ''}
          onClick={() => setTab('history')}
        >
          <History size={13} />
          Changes & Undo
        </button>
      </nav>
      {error && (
        <div className="manager-error" role="alert">
          {error}
        </div>
      )}
      {tab === 'chat' ? (
        <>
          <div className="manager-transcript" aria-live="polite">
            {chat?.threadId?.startsWith('terminal:') && (
              <TerminalPane
                sessionId={chat.threadId.slice(9)}
                disabled={!!blockedReason}
                finishLabel="Finish manager assignment"
              />
            )}
            {!chat && <p className="helper">Loading conversation…</p>}
            {chat?.turns.length === 0 && (
              <div className="manager-empty">
                <Bot size={26} />
                <h3>Shape the work together</h3>
                <p>
                  {scope.taskId
                    ? 'Ask to add an agent node, change a prompt, assign a profile or skill, or adjust model and acceptance settings.'
                    : 'Try “Create a task to add CSV export, with implementation, testing, and a human review.”'}
                </p>
                <p>
                  Your project brief and repository guidance are included in
                  each turn.
                </p>
                {!scope.taskId && (
                  <p>
                    You can also ask to update the project brief, instructions,
                    development/run command, test command, or model defaults.
                  </p>
                )}
              </div>
            )}
            {!chat?.threadId?.startsWith('terminal:') &&
              chat?.turns.map((turn) => (
                <section className="manager-turn" key={turn.id}>
                  <div className="manager-user">
                    <strong>You</strong>
                    <p>{turn.message}</p>
                  </div>
                  {turn.items.map((item) =>
                    item.type === 'agent_message' ? (
                      <div className="manager-reply" key={item.id}>
                        <strong>Manager</strong>
                        <p>{item.text}</p>
                      </div>
                    ) : (
                      <details className="manager-activity" key={item.id}>
                        <summary>
                          {item.title}{' '}
                          {item.status && <small>· {item.status}</small>}
                        </summary>
                        <pre>{item.text}</pre>
                      </details>
                    ),
                  )}
                  <div className="manager-turn-status">
                    {turn.status === 'running' && (
                      <LoaderCircle size={12} className="spin" />
                    )}
                    {turn.status}
                  </div>
                  {turn.error && (
                    <p className="manager-error">
                      {turn.error.message}
                      <br />
                      {turn.error.hint}
                    </p>
                  )}
                  <details className="manager-context">
                    <summary>Project context for this turn</summary>
                    <pre>
                      {JSON.stringify(JSON.parse(turn.context), null, 2)}
                    </pre>
                  </details>
                </section>
              ))}
            <div ref={bottom} />
          </div>
          <form
            className="manager-composer"
            onSubmit={(event) => {
              event.preventDefault()
              if (
                !chat ||
                !message.trim() ||
                active ||
                pending ||
                blockedReason
              )
                return
              void act(async () => {
                await value(
                  window.constella!.manager.send({
                    ...scope,
                    chatId: chat.id,
                    message,
                    selectedNodeId: selectedNodeId ?? null,
                    model: modelOverride,
                    effort: effortOverride,
                  }),
                )
                setMessage('')
              })
            }}
          >
            {blockedReason && (
              <p className="manager-warning">{blockedReason}</p>
            )}
            {!(active && chat?.threadId?.startsWith('terminal:')) && (
              <>
                <div className="manager-options">
                  <select
                    aria-label="Manager model"
                    value={model}
                    disabled={pending || active}
                    onChange={(event) => {
                      setModel(event.target.value)
                      setEffort('')
                    }}
                  >
                    <option value="">
                      Project default (
                      {project?.defaultModel ?? 'configured runtime'})
                    </option>
                    <option value="__configured__">
                      Configured runtime default
                    </option>
                    {models.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Manager reasoning effort"
                    value={effort}
                    disabled={pending || active || !effective.model}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    <option value="">
                      Inherit (
                      {resolveModelSettings(
                        { model: modelOverride },
                        undefined,
                        project,
                      ).effort ?? 'model default'}
                      )
                    </option>
                    <option value="__default__">Model default</option>
                    {models
                      .find((option) => option.id === effective.model)
                      ?.efforts.map((effort) => (
                        <option key={effort}>{effort}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="icon-button"
                    title="Refresh model options"
                    onClick={() => void refreshDiagnostics()}
                  >
                    <History size={13} />
                  </button>
                </div>
                <textarea
                  aria-label="Message manager"
                  rows={3}
                  value={message}
                  maxLength={32000}
                  disabled={pending || active || !!blockedReason}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={
                    scope.taskId
                      ? 'How should this workflow change?'
                      : 'What should we plan or change?'
                  }
                />
              </>
            )}
            <div className="manager-send-row">
              <small>Execution starts from the workflow controls.</small>
              {active ? (
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() =>
                    void act(() => value(window.constella!.manager.stop(scope)))
                  }
                >
                  <Square size={12} />
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="button primary"
                  disabled={
                    pending || !chat || !message.trim() || !!blockedReason
                  }
                >
                  {pending ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Send size={13} />
                  )}
                  Send
                </button>
              )}
            </div>
          </form>
        </>
      ) : (
        <div className="manager-history">
          <p className="helper">
            Saved project settings, board and graph edits from the UI and
            manager. Undo restores metadata; code and prior runs stay available.
          </p>
          {!history.length && <p className="helper">No saved changes yet.</p>}
          {history.map((entry) => (
            <article key={entry.id}>
              <strong>{entry.action}</strong>
              <p>{changeDescription(entry)}</p>
              <small>
                {new Date(entry.createdAt).toLocaleString()} · revision{' '}
                {entry.revision}
              </small>
              <details>
                <summary>View saved changes</summary>
                <strong>Before</strong>
                <pre>{JSON.stringify(entry.before, null, 2)}</pre>
                <strong>After</strong>
                <pre>{JSON.stringify(entry.after, null, 2)}</pre>
              </details>
              <button
                className="button secondary"
                disabled={
                  pending || active || !!entry.undoneAt || !!blockedReason
                }
                onClick={() =>
                  void act(() =>
                    value(
                      window.constella!.manager.undo({
                        ...scope,
                        changeId: entry.id,
                        commandId: crypto.randomUUID(),
                      }),
                    ),
                  )
                }
              >
                <Undo2 size={12} />
                {entry.undoneAt ? 'Undone' : 'Undo'}
              </button>
            </article>
          ))}
        </div>
      )}
    </aside>
  )
}
