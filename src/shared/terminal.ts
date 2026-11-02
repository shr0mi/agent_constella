import { z } from 'zod'
import type { Result } from './contracts'

export const providerSchema = z.enum(['codex', 'claude'])
export type AgentProvider = z.infer<typeof providerSchema>
export const terminalIdSchema = z.object({ sessionId: z.uuid() }).strict()
export const terminalReadSchema = terminalIdSchema
  .extend({ after: z.number().int().min(0).default(0) })
  .strict()
export const terminalInputSchema = terminalIdSchema
  .extend({ data: z.string().min(1).max(128_000) })
  .strict()
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
}
export interface TerminalBridge {
  list(): Promise<Result<TerminalSession[]>>
  read(input: {
    sessionId: string
    after?: number
  }): Promise<Result<TerminalRead>>
  input(input: { sessionId: string; data: string }): Promise<Result<void>>
  resize(input: {
    sessionId: string
    cols: number
    rows: number
  }): Promise<Result<void>>
  finish(input: { sessionId: string; summary?: string }): Promise<Result<void>>
  close(input: { sessionId: string }): Promise<Result<void>>
}
