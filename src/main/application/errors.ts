import { ZodError } from 'zod'
import type { Failure } from '../../shared/contracts'
import { describeError } from '../codex/errors'

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message)
  }
}

export function applicationFailure(error: unknown): Failure {
  if (error instanceof ApplicationError)
    return { code: error.code, message: error.message, hint: error.hint }
  if (error instanceof ZodError)
    return {
      code: 'VALIDATION',
      message: error.issues
        .map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`)
        .join('\n'),
      hint: 'Review the values and try again.',
    }
  if (
    /SQLITE_|database|NODE_MODULE_VERSION|better_sqlite3/i.test(
      error instanceof Error ? error.message : String(error),
    )
  )
    return {
      code: 'STORAGE',
      message: error instanceof Error ? error.message : String(error),
      hint: 'Check app data access and available disk space. For a native module version error, run npm run rebuild:native, then restart. Your existing database is preserved.',
    }
  return describeError(error)
}
