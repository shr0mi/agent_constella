import { randomUUID } from 'node:crypto'
import { terminalHost, type TerminalHost } from './host'
import { TerminalAttentionMonitor } from './attention'
import type { TerminalAttention } from '../../shared/terminal'
import type {
  AgentClient,
  AgentOptions,
  AgentThread,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from './types'

export class NativeCliClient implements AgentClient {
  constructor(
    private readonly connection: AgentOptions = {},
    private readonly host?: TerminalHost,
  ) {}
  startThread(options: ThreadOptions) {
    return this.thread(undefined, options)
  }
  resumeThread(id: string, options: ThreadOptions) {
    return this.thread(id, options)
  }
  private thread(id: string | undefined, options: ThreadOptions): AgentThread {
    return {
      runStreamed: async (prompt: string, turn: TurnOptions) => {
        turn.signal?.throwIfAborted()
        const host = this.host ?? terminalHost()
        const priorId = id?.startsWith('terminal:') ? id.slice(9) : undefined
        const prior = priorId
          ? (await host.list()).find(
              (s) => s.id === priorId && s.state !== 'exited',
            )
          : undefined
        if (options.attachOnly && !prior)
          throw new Error(
            'The terminal process ended while AgentConstella was closed. Retry explicitly.',
          )
        turn.signal?.throwIfAborted()
        const session = prior
          ? options.attachOnly
            ? prior
            : await host.rpc<import('../../shared/terminal').TerminalSession>({
                op: 'continue',
                sessionId: prior.id,
                prompt,
                mcp: this.connection.mcp,
              })
          : await host.launch(prompt, options, this.connection)
        if (prior && options.attachOnly)
          await host.setMcp(prior.id, this.connection.mcp)
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: 'thread.started', thread_id: `terminal:${session.id}` }
          yield { type: 'turn.started' }
          let cursor = 0
          let attention: TerminalAttention | undefined
          const monitor = new TerminalAttentionMonitor()
          try {
            while (!turn.signal?.aborted) {
              const value = await host.read({
                sessionId: session.id,
                after: cursor,
              })
              cursor = value.cursor
              if (value.session.completedGeneration >= session.generation) {
                yield {
                  type: 'item.completed',
                  item: {
                    id: randomUUID(),
                    type: 'agent_message',
                    text: value.session.summary,
                  },
                }
                yield { type: 'turn.completed' }
                return
              }
              if (value.session.state === 'exited')
                throw new Error(
                  `The native ${session.provider} terminal exited (${value.session.exitCode ?? 'unknown'}). Inspect its output and retry or start a new conversation.`,
                )
              const nextAttention = await monitor.read(value)
              if (nextAttention !== attention) {
                attention = nextAttention
                yield { type: 'terminal.attention', attention }
              }
              await new Promise((resolve) => setTimeout(resolve, 250))
            }
          } finally {
            monitor.dispose()
            if (turn.signal?.aborted && turn.signal.reason !== 'detach')
              await host.close(session.id).catch(() => {})
          }
        }
        return { events: events() }
      },
    }
  }
}
