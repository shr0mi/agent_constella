import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
  Usage,
} from '../src/main/terminal/types'
import { runInputSchema, type RunInput } from '../src/shared/contracts'
import {
  ConnectivityService,
  toActivity,
  type CodexClient,
} from '../src/main/codex/service'
import { SessionStore } from '../src/main/codex/storage'
import { parseModels } from '../src/main/codex/runtime'

const usage: Usage = {
  input_tokens: 12,
  output_tokens: 4,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
}
const input: RunInput = {
  prompt: 'Read the fixture',
  sandbox: 'workspace-write',
  skillIds: ['connectivity-proof'],
}
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function fakeClient(
  events: (options: TurnOptions) => AsyncIterable<ThreadEvent>,
): CodexClient & {
  startThread: ReturnType<typeof vi.fn>
  resumeThread: ReturnType<typeof vi.fn>
} {
  const thread = {
    runStreamed: vi.fn(async (_input: string, options: TurnOptions) => ({
      events: events(options),
    })),
  }
  return {
    startThread: vi.fn((_options: ThreadOptions) => thread),
    resumeThread: vi.fn((_id: string, _options: ThreadOptions) => thread),
  }
}

async function setup(client: CodexClient) {
  const directory = await mkdtemp(join(tmpdir(), 'constella-test-'))
  cleanup.push(directory)
  const store = new SessionStore(directory)
  const service = new ConnectivityService(store, client)
  await service.initialize()
  cleanup.push(service.snapshot().session.workspace)
  return { service, store, directory }
}

async function* successful(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'saved-thread' }
  yield { type: 'turn.started' }
  yield {
    type: 'item.started',
    item: {
      id: 'cmd',
      type: 'command_execution',
      command: 'cat workspace-proof.txt',
      aggregated_output: '',
      status: 'in_progress',
    },
  }
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd',
      type: 'command_execution',
      command: 'cat workspace-proof.txt',
      aggregated_output: 'ORBIT',
      status: 'completed',
      exit_code: 0,
    },
  }
  yield {
    type: 'item.completed',
    item: {
      id: 'reply',
      type: 'agent_message',
      text: 'CONSTELLA_SKILL_OK ORBIT',
    },
  }
  yield { type: 'turn.completed', usage }
}

describe('connectivity service lifecycle', () => {
  it('persists a selected-skill snapshot and resumes the same thread from a new service', async () => {
    const client = fakeClient(successful)
    const { service, store } = await setup(client)
    await service.start(input)
    await service.waitForIdle()
    const state = service.snapshot()
    const run = state.session.runs[0]
    expect(run.status).toBe('completed')
    expect(run.items.filter((item) => item.id === 'cmd')).toHaveLength(1)
    expect(run.items.find((item) => item.id === 'cmd')?.text).toBe('ORBIT')
    expect(run.resolvedPrompt).toContain(run.skillSnapshots[0].content)
    expect(state.session.workspace.startsWith(store.directory)).toBe(false)
    expect(client.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: 'workspace-write',
      }),
    )
    const reopened = new ConnectivityService(store, client)
    await reopened.initialize()
    await reopened.start({ ...input, prompt: 'Continue', skillIds: [] })
    await reopened.waitForIdle()
    expect(client.resumeThread).toHaveBeenCalledWith(
      'saved-thread',
      expect.anything(),
    )
    expect(reopened.snapshot().session.runs).toHaveLength(2)
    expect(reopened.snapshot().session.runs[1].skillSnapshots).toEqual([])
    await expect(
      readFile(
        join(
          state.session.workspace,
          '.agents/skills/connectivity-proof/SKILL.md',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops an active subprocess signal, rejects overlapping starts, and can continue', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let turn = 0
    const client = fakeClient(async function* (options) {
      if (turn++ > 0) {
        yield* successful()
        return
      }
      yield { type: 'thread.started', thread_id: 'saved-thread' }
      entered()
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        else
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          })
      })
      throw new Error('The operation was aborted')
    })
    const { service } = await setup(client)
    const first = service.start(input)
    await expect(service.start(input)).rejects.toThrow('already active')
    await first
    await started
    await expect(service.newSession()).rejects.toThrow('Stop the current turn')
    await service.stop()
    await service.waitForIdle()
    expect(service.snapshot().session.runs[0].status).toBe('cancelled')
    await service.start(input)
    await service.waitForIdle()
    expect(service.snapshot().session.runs[1].status).toBe('completed')
  })

  it.each([
    ['turn.failed', 'Authentication failed: 401', 'AUTHENTICATION'],
    ['error', 'Permission denied by sandbox', 'PERMISSION'],
    ['eof', '', 'EXECUTION'],
  ])(
    'surfaces %s as a failed run instead of success',
    async (kind, message, code) => {
      const client = fakeClient(async function* () {
        yield { type: 'thread.started', thread_id: 'saved-thread' }
        if (kind === 'turn.failed')
          yield { type: 'turn.failed', error: { message } }
        else if (kind === 'error') yield { type: 'error', message }
      })
      const { service } = await setup(client)
      await service.start(input)
      await service.waitForIdle()
      expect(service.snapshot().session.runs[0]).toMatchObject({
        status: 'failed',
        error: { code },
      })
    },
  )

  it('preserves completion when stop races with process teardown after turn.completed', async () => {
    const client = fakeClient(async function* (options) {
      yield { type: 'thread.started', thread_id: 'saved-thread' }
      yield { type: 'turn.completed', usage }
      if (options.signal?.aborted) throw new Error('The operation was aborted')
    })
    const { service } = await setup(client)
    const unsubscribe = service.subscribe((state) => {
      if (
        state.session.runs.at(-1)?.usage &&
        state.session.runs.at(-1)?.status === 'running'
      )
        void service.stop()
    })
    await service.start(input)
    await service.waitForIdle()
    unsubscribe()
    expect(service.snapshot().session.runs[0].status).toBe('completed')
  })

  it('restores an unfinished turn as interrupted without executing it automatically', async () => {
    const client = fakeClient(successful)
    const { service, store } = await setup(client)
    await service.start(input)
    await service.waitForIdle()
    const session = service.snapshot().session
    session.runs[0].status = 'running'
    await store.write(session)
    client.startThread.mockClear()
    const reopened = new ConnectivityService(store, client)
    await reopened.initialize()
    expect(reopened.snapshot().session.runs[0]).toMatchObject({
      status: 'interrupted',
      error: { code: 'INTERRUPTED' },
    })
    expect(client.startThread).not.toHaveBeenCalled()
    expect(client.resumeThread).not.toHaveBeenCalled()
  })

  it('exposes storage failure and releases the slot without leaving a running turn', async () => {
    const client = fakeClient(successful)
    const { service, store } = await setup(client)
    vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'))
    await expect(service.start(input)).rejects.toThrow('disk full')
    expect(service.snapshot().persistenceError?.code).toBe('STORAGE')
    expect(service.snapshot().session.runs[0].status).toBe('failed')
    expect(client.startThread).not.toHaveBeenCalled()
  })

  it('rejects corrupt saved metadata without replacing it', async () => {
    const { directory, store } = await setup(fakeClient(successful))
    await writeFile(join(directory, 'session.json'), '{broken')
    await expect(store.read()).rejects.toThrow()
    expect(await readFile(join(directory, 'session.json'), 'utf8')).toBe(
      '{broken',
    )
  })
})

describe('runtime inputs', () => {
  it('handles the real CLI null exit code on running command items despite the SDK declaration', () => {
    const item = JSON.parse(
      '{"id":"cmd","type":"command_execution","command":"sleep 30","aggregated_output":"","exit_code":null,"status":"in_progress"}',
    )
    expect(toActivity(item).status).toBe('in_progress')
  })
  it('does not accept full access, arbitrary skills, or process settings through IPC', () => {
    expect(
      runInputSchema.safeParse({ ...input, sandbox: 'danger-full-access' })
        .success,
    ).toBe(false)
    expect(
      runInputSchema.safeParse({ ...input, skillIds: ['../../secret'] })
        .success,
    ).toBe(false)
    expect(
      runInputSchema.safeParse({ ...input, workingDirectory: '/' }).success,
    ).toBe(false)
  })
  it('uses runtime-supported efforts and filters values the SDK cannot express', () => {
    const catalog = parseModels({
      data: [
        {
          id: 'model-entry',
          model: 'account-model',
          displayName: 'Account Model',
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'future-effort' },
          ],
        },
      ],
      nextCursor: null,
    })
    expect(catalog.models).toEqual([
      {
        id: 'account-model',
        name: 'Account Model',
        isDefault: true,
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
      },
    ])
  })
})
