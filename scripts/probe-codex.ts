import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeError } from '../src/main/codex/errors'
import { diagnose } from '../src/main/codex/runtime'
import { ConnectivityService } from '../src/main/codex/service'
import { SessionStore } from '../src/main/codex/storage'
import type { Effort, Run } from '../src/shared/contracts'

// Real inference is opt-in. This probe never operates on the source repository.
const live = process.argv.includes('--live')
const permissionsOnly = process.argv.includes('--permissions-only')
const directory = await mkdtemp(join(tmpdir(), 'constella-probe-'))
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  live,
  checks: [],
}
const checks = report.checks as {
  name: string
  status: string
  detail: string
}[]
let service: ConnectivityService | undefined
let cancelTimeout: ReturnType<typeof setTimeout> | undefined
let explicitOptions: { model?: string; effort?: Effort } = {}

// Probe-only evidence: inspect only the thread created by this probe. The production
// app deliberately does not depend on the private Codex session-log schema.
async function nestedPermissionEvidence(
  threadId: string,
  since: string,
): Promise<boolean> {
  const sessions = join(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'sessions',
  )
  const entries = await readdir(sessions, {
    recursive: true,
    withFileTypes: true,
  })
  const entry = entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.includes(threadId) &&
      entry.name.endsWith('.jsonl'),
  )
  if (!entry) return false
  const text = await readFile(join(entry.parentPath, entry.name), 'utf8')
  return text
    .trim()
    .split('\n')
    .some((line) => {
      const event = JSON.parse(line)
      return (
        event.timestamp >= since &&
        event.type === 'response_item' &&
        ['custom_tool_call_output', 'function_call_output'].includes(
          event.payload?.type,
        ) &&
        /operation not permitted|permission denied|read.only file system/i.test(
          JSON.stringify(event.payload.output),
        ) &&
        /permission-probe\.txt/.test(JSON.stringify(event.payload.output))
      )
    })
}

async function run(
  prompt: string,
  skill = false,
  sandbox: 'read-only' | 'workspace-write' = 'workspace-write',
): Promise<Run> {
  assert(service)
  await service.start({
    prompt,
    sandbox,
    ...explicitOptions,
    skillIds: skill ? ['connectivity-proof'] : [],
  })
  const timer = setTimeout(() => {
    void service?.stop().catch(() => {})
  }, 90_000)
  try {
    await service.waitForIdle()
  } finally {
    clearTimeout(timer)
  }
  const result = service.snapshot().session.runs.at(-1)!
  if (result.error)
    throw new Error(`${result.error.code}: ${result.error.message}`)
  return result
}

try {
  const diagnostics = await diagnose()
  report.diagnostics = diagnostics
  console.log(`SDK ${diagnostics.sdkVersion} / ${diagnostics.cliVersion}`)
  console.log(`Authentication: ${diagnostics.auth.status}`)
  console.log(
    `Runtime models: ${diagnostics.models.map((model) => `${model.id} [${model.efforts.join(', ')}]`).join('; ') || diagnostics.modelError}`,
  )
  checks.push({
    name: 'authentication preflight',
    status: diagnostics.auth.status === 'signed-in' ? 'passed' : 'unconfirmed',
    detail: diagnostics.auth.detail,
  })
  checks.push({
    name: 'model/effort catalog',
    status: diagnostics.models.length ? 'passed' : 'unavailable',
    detail:
      diagnostics.modelError ??
      `${diagnostics.models.length} models returned by pinned CLI app-server`,
  })
  if (!live) {
    checks.push({
      name: 'real conversation',
      status: 'not run',
      detail:
        'Pass --live to execute the disposable-workspace probe using your local Codex login.',
    })
  } else {
    service = new ConnectivityService(
      new SessionStore(join(directory, 'metadata')),
    )
    await service.initialize()
    report.workspace = service.snapshot().session.workspace

    if (permissionsOnly) {
      const catalog = await service.refreshDiagnostics()
      const selected =
        catalog.models.find((model) => model.isDefault) ?? catalog.models[0]
      if (selected) {
        explicitOptions = {
          model: selected.id,
          effort: selected.efforts.includes('low')
            ? 'low'
            : selected.defaultEffort,
        }
        report.explicitModelOptions = explicitOptions
      }
    } else {
      const first = await run(
        'Read workspace-proof.txt with a shell command. Remember COMET as our conversation word. Follow the selected skill and include the proof word in your final response.',
        true,
      )
      assert.equal(first.status, 'completed')
      assert(
        first.items.some((item) => item.type === 'command_execution'),
        'Expected a real shell tool item',
      )
      const reply = first.items
        .filter((item) => item.type === 'agent_message')
        .map((item) => item.text)
        .join('\n')
      assert(
        reply.includes('CONSTELLA_SKILL_OK') && reply.includes('ORBIT'),
        'Selected skill proof missing',
      )
      assert(first.events.some((event) => event.type === 'thread.started'))
      checks.push({
        name: 'authentication + streamed output + tool events + selected skill',
        status: 'passed',
        detail: `Observed ${first.events.length} SDK events and the skill/fixture markers.`,
      })

      // Rebuild the service and SDK client from disk, rather than retaining the Thread object.
      const savedId = service.snapshot().session.threadId
      assert(savedId)
      service = new ConnectivityService(
        new SessionStore(join(directory, 'metadata')),
      )
      await service.initialize()
      const continuation = await run(
        'What conversation word did I ask you to remember? Reply with that word, without using tools.',
      )
      assert.equal(continuation.status, 'completed')
      assert.equal(service.snapshot().session.threadId, savedId)
      assert(
        continuation.items.some(
          (item) =>
            item.type === 'agent_message' && item.text.includes('COMET'),
        ),
        'Saved thread did not retain context',
      )
      checks.push({
        name: 'saved continuation across a new SDK client',
        status: 'passed',
        detail: `Resumed saved thread ${savedId}; recalled COMET.`,
      })

      let stoppedDuringCommand = false
      let stoppedAt = 0
      const unsubscribe = service.subscribe((state) => {
        const current = state.session.runs.at(-1)
        if (
          !stoppedDuringCommand &&
          current?.status === 'running' &&
          current.items.some(
            (item) =>
              item.type === 'command_execution' &&
              /sleep\s+30/.test(item.title) &&
              item.status === 'in_progress',
          )
        ) {
          stoppedDuringCommand = true
          stoppedAt = Date.now()
          void service!.stop().catch(() => {})
        }
      })
      cancelTimeout = setTimeout(() => {
        void service?.stop().catch(() => {})
      }, 45_000)
      const cancelled = await run(
        'Use a shell tool to run exactly sleep 30 in the foreground. Do not use a background job. Then reply FINISHED.',
      )
      clearTimeout(cancelTimeout)
      unsubscribe()
      assert(
        stoppedDuringCommand,
        'Did not observe a running sleep command before cancellation',
      )
      assert.equal(cancelled.status, 'cancelled')
      const stopDuration = Date.now() - stoppedAt
      assert(
        stopDuration < 15_000,
        `Cancellation took ${stopDuration}ms; expected the 30-second tool to be interrupted promptly`,
      )
      checks.push({
        name: 'cancellation during tool execution',
        status: 'passed',
        detail: `Observed running sleep tool, called AbortController, and persisted cancelled status in ${stopDuration}ms.`,
      })

      service = new ConnectivityService(
        new SessionStore(join(directory, 'metadata')),
      )
      await service.initialize()
      const afterStop = await run(
        'Continue after the interrupted turn. Reply RESUMED and the conversation word you remember.',
      )
      assert.equal(afterStop.status, 'completed')
      assert.equal(service.snapshot().session.threadId, savedId)
      assert(
        afterStop.items.some(
          (item) =>
            item.type === 'agent_message' && item.text.includes('COMET'),
        ),
      )
      checks.push({
        name: 'continue after stop',
        status: 'passed',
        detail:
          'New SDK client resumed the same thread and retained prior context.',
      })
    }

    const permission = await run(
      'Use a shell command to attempt writing PERMISSION_PROBE to permission-probe.txt in the current directory. Do not request elevated access or change the sandbox. Report what happened.',
      false,
      'read-only',
    )
    const denied = permission.items.some(
      (item) =>
        item.type === 'command_execution' &&
        /failed|exit [1-9]/.test(item.status ?? ''),
    )
    const threadId = service.snapshot().session.threadId
    assert(threadId)
    const nestedDenial =
      !denied &&
      (await nestedPermissionEvidence(threadId, permission.startedAt))
    const fileExists = await access(
      join(service.snapshot().session.workspace, 'permission-probe.txt'),
    ).then(
      () => true,
      () => false,
    )
    assert(
      (denied || nestedDenial) && !fileExists,
      'Expected a failed write tool with no file created under read-only permissions',
    )
    checks.push({
      name: 'noninteractive permission failure',
      status: 'passed',
      detail: denied
        ? 'Read-only write attempt failed in an SDK tool item. No approval callback is available.'
        : 'Read-only denial verified in the generated thread log and no file was created. The SDK omitted the nested exec tool event: this is an integration limitation, not a complete activity feed.',
    })
    if (permissionsOnly && explicitOptions.model)
      checks.push({
        name: 'explicit model/effort execution',
        status: 'passed',
        detail: JSON.stringify(explicitOptions),
      })
    report.threadId = threadId
    report.eventTypes = [
      ...new Set(
        service
          .snapshot()
          .session.runs.flatMap((turn) =>
            turn.events.map((event) => event.type),
          ),
      ),
    ]
  }
} catch (error) {
  const failure = describeError(error)
  report.failure = failure
  checks.push({ name: 'probe', status: 'failed', detail: failure.message })
  console.error(`${failure.code}: ${failure.message}\n${failure.hint}`)
  process.exitCode = 1
} finally {
  if (cancelTimeout) clearTimeout(cancelTimeout)
  if (service) await service.shutdown().catch(() => {})
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(
    checks
      .map(
        (check) =>
          `${check.status.toUpperCase()}: ${check.name} — ${check.detail}`,
      )
      .join('\n'),
  )
  console.log(`Report: ${join(directory, 'report.json')}`)
  if (report.workspace)
    console.log(
      `Disposable workspace retained for inspection: ${report.workspace}`,
    )
}
