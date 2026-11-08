import type { Effort } from '../../shared/contracts'
import type { AgentProvider, TerminalAttention } from '../../shared/terminal'

// Application lifecycle records, also used to read pre-terminal attempt history.
// Native terminal bytes are never parsed into model/tool events.
export type Usage = {
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens?: number
  reasoning_output_tokens?: number
}
export type ThreadItem =
  | { id: string; type: 'agent_message' | 'reasoning'; text: string }
  | {
      id: string
      type: 'command_execution'
      command: string
      aggregated_output: string
      status: string
      exit_code?: number | null
    }
  | {
      id: string
      type: 'file_change'
      changes: { kind: string; path: string }[]
      status: string
    }
  | {
      id: string
      type: 'mcp_tool_call'
      server: string
      tool: string
      arguments: unknown
      result?: unknown
      error?: unknown
      status: string
    }
  | {
      id: string
      type: 'todo_list'
      items: { text: string; completed: boolean }[]
    }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'error'; message: string }
export type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'terminal.attention'; attention?: TerminalAttention }
  | { type: 'turn.completed'; usage?: Usage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'error'; message: string }
  | {
      type: 'item.started' | 'item.updated' | 'item.completed'
      item: ThreadItem
    }
export interface ThreadOptions {
  role?: 'worker' | 'manager' | 'lab'
  workingDirectory?: string
  provider?: AgentProvider
  attachOnly?: boolean
  title?: string
  model?: string
  modelReasoningEffort?: Effort
}
export interface TurnOptions {
  signal?: AbortSignal
}
export interface AgentOptions {
  env?: Record<string, string>
  mcp?: { url: string; token: string }
}
export interface AgentClient {
  startThread(options: ThreadOptions): AgentThread
  resumeThread(id: string, options: ThreadOptions): AgentThread
}
export interface AgentThread {
  runStreamed(
    input: string,
    options: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>
}
