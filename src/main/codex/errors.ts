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
      hint: 'Run npx codex login in this repository, then refresh diagnostics. An existing desktop login may use a different Codex home.',
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
      hint: 'Refresh the model catalog or choose Configured default. Model and effort access depends on your account and runtime.',
    }
  }
  if (/sandbox|permission|not permitted|denied|approval/i.test(safe)) {
    return {
      code: 'PERMISSION',
      message: safe,
      hint: 'Check the selected sandbox. Interactive approval is unavailable through this SDK; this app never escalates access automatically.',
    }
  }
  if (/ENOENT|locate Codex|Unsupported platform/i.test(safe)) {
    return {
      code: 'RUNTIME',
      message: safe,
      hint: 'Run npm install with optional dependencies enabled to install the pinned native Codex runtime.',
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
