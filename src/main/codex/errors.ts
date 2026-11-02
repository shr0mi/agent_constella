import type { Failure } from '../../shared/contracts'

export function describeError(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error)
  // Avoid accidentally persisting common credential forms from process errors.
  const safe = message
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[redacted]')
    .slice(0, 8_000)
  if (/auth|401|login|sign.?in|unauthorized|refresh.token/i.test(safe)) {
    return {
      code: 'AUTHENTICATION',
      message: safe,
      hint: 'Sign in using your chosen native CLI, then retry the terminal session.',
    }
  }
  if (
    /model.*(not|unsupported|unknown)|reasoning.*(unsupported|invalid)|effort/i.test(
      safe,
    )
  ) {
    return {
      code: 'MODEL_OPTIONS',
      message: safe,
      hint: 'Use a model and effort supported by your chosen CLI, or clear the override to inherit its configuration.',
    }
  }
  if (/sandbox|permission|not permitted|denied|approval/i.test(safe)) {
    return {
      code: 'PERMISSION',
      message: safe,
      hint: 'Inspect the native CLI permission prompt and configuration in the terminal.',
    }
  }
  if (/ENOENT|locate Codex|Unsupported platform/i.test(safe)) {
    return {
      code: 'RUNTIME',
      message: safe,
      hint: 'Install Codex CLI or Claude Code and make it available on PATH, then retry.',
    }
  }
  if (
    /network|fetch|connect|ENOTFOUND|stream disconnected|timed? ?out/i.test(
      safe,
    )
  ) {
    return {
      code: 'CONNECTIVITY',
      message: safe,
      hint: 'Check internet access and provider availability. Retry or continue after the connection is restored.',
    }
  }
  return {
    code: 'EXECUTION',
    message: safe,
    hint: 'Inspect the activity stream and diagnostics. You can continue a saved thread or create a new scratch session.',
  }
}
