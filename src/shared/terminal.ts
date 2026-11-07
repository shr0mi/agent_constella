import { z } from 'zod'
import type { Result } from './contracts'

export const providerSchema = z.enum(['codex', 'claude'])
export type AgentProvider = z.infer<typeof providerSchema>
export const terminalIdSchema = z.object({ sessionId: z.uuid() }).strict()
export const terminalReadSchema = terminalIdSchema
  .extend({ after: z.number().int().min(0).default(0) })
  .strict()
export const terminalInputSchema = terminalIdSchema
  .extend({
    data: z.string().min(1).max(128_000),
    encoding: z.enum(['utf8', 'binary']).optional(),
  })
  .strict()
export type TerminalInput = z.infer<typeof terminalInputSchema>
export const terminalReadOnlyMessage =
  'Continue this node or manager from its controls before editing a completed result.'

// Only vertical wheel reports may reach a read-only fullscreen CLI. Never
// accept keyboard input, clicks, paste, or extra bytes through this exception.
export function isTerminalWheelInput({
  data,
  encoding,
}: Pick<TerminalInput, 'data' | 'encoding'>): boolean {
  let button: number
  if (encoding === 'binary') {
    if (data.length !== 6 || !/^\x1b\[M[\x60-\x7f][\x21-\xff]{2}$/.test(data))
      return false
    button = data.charCodeAt(3) - 32
  } else {
    const match = /^\x1b\[<(\d{2});[1-9]\d{0,5};[1-9]\d{0,5}M$/.exec(data)
    if (!match || match[0] !== data) return false
    button = Number(match[1])
  }
  return button >= 64 && button <= 93 && (button & 3) <= 1
}
export const terminalResizeSchema = terminalIdSchema
  .extend({
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(250),
  })
  .strict()
export const terminalFinishSchema = terminalIdSchema
  .extend({ summary: z.string().trim().max(32_000).default('') })
  .strict()
export interface TerminalSession {
  role?: 'worker' | 'manager' | 'lab'
  id: string
  provider: AgentProvider
  cwd: string
  title: string
  state: 'running' | 'ready' | 'exited'
  generation: number
  completedGeneration: number
  summary: string
  createdAt: string
  exitCode?: number
  cols: number
  rows: number
}
export interface TerminalRead {
  session: TerminalSession
  data: string
  cursor: number
  reset: boolean
  // Absent on detached terminal services started before wheel-input support.
  supportsReadOnlyWheel?: boolean
}
export interface TerminalBridge {
  list(): Promise<Result<TerminalSession[]>>
  read(input: {
    sessionId: string
    after?: number
  }): Promise<Result<TerminalRead>>
  input(input: TerminalInput): Promise<Result<void>>
  resize(input: {
    sessionId: string
    cols: number
    rows: number
  }): Promise<Result<void>>
  finish(input: { sessionId: string; summary?: string }): Promise<Result<void>>
  close(input: { sessionId: string }): Promise<Result<void>>
}
