import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent, ThreadOptions, TurnOptions } from '../src/main/terminal/types'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { NodeExecutionService } from '../src/main/application/node-execution-service'
import type { AgentClient } from '../src/main/terminal/types'
import type { NodeIdentity } from '../src/shared/execution'
import { nodeRuns } from '../src/main/db/schema'
import { eq } from 'drizzle-orm'
import { runChecks } from '../src/main/application/run-checks'

const directories: string[] = [],
  databases: WorkspaceDatabase[] = [],
  services: NodeExecutionService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  directories
    .splice(0)
    .forEach((path) => removeTemp(path))
})
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
type Turn = (
  options: ThreadOptions,
  input: string,
  signal?: AbortSignal,
  id?: string,
) => AsyncIterable<ThreadEvent>
function client(turn: Turn) {
  const calls: { options: ThreadOptions; input: string; resumed?: string }[] =
    []
  const make = (options: ThreadOptions, resumed?: string) => ({
    async runStreamed(input: string, config: TurnOptions) {
      calls.push({ options, input, resumed })
      return { events: turn(options, input, config.signal, resumed) }
    },
  })
  const client: AgentClient = {
    startThread: (options) => make(options),
    resumeThread: (id, options) => make(options, id),
  }
  return { client, calls }
}
function successful(
  options: ThreadOptions,
  text = 'first revision',
  id = 'thread-fixture',
) {
  return (async function* (): AsyncGenerator<ThreadEvent> {
    yield { type: 'thread.started', thread_id: id }
    writeFileSync(join(options.workingDirectory!, 'answer.txt'), text)
    yield {
      type: 'item.started',
      item: {
        id: 'command',
        type: 'command_execution',
        command: 'write answer',
        aggregated_output: '',
        status: 'in_progress',
      },
    }
    yield {
      type: 'item.completed',
      item: {
        id: 'command',
        type: 'command_execution',
        command: 'write answer',
        aggregated_output: 'wrote answer',
        status: 'completed',
        exit_code: 0,
      },
    }
    yield {
      type: 'item.completed',
      item: {
        id: 'message',
        type: 'agent_message',
        text: `Implemented ${text}`,
      },
    }
    yield {
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    }
  })()
}
async function fixture(
  turn: Turn = (options) => successful(options),
  committed = false,
  testCommand = '',
) {
  const root = mkdtempSync(join(tmpdir(), 'constella-node-test-'))
  directories.push(root)
  const appData = join(root, 'app'),
    file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database)
  let project = await workspace.createProject({ path: join(root, 'project') })
  writeFileSync(
    join(project.repoPath, 'README.md'),
    '# Fixture project\nFollow these instructions.\n',
  )
  writeFileSync(
    join(project.repoPath, '.gitignore'),
    'node_modules/\nignored.txt\n',
  )
  writeFileSync(join(project.repoPath, 'input.txt'), 'original input')
  writeFileSync(join(project.repoPath, 'ignored.txt'), 'not copied')
  {
    git(project.repoPath, 'add', '.')
    git(
      project.repoPath,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Fixture',
    )
  }
  if (committed) {
    writeFileSync(join(project.repoPath, 'input.txt'), 'uncommitted input')
    git(project.repoPath, 'add', 'input.txt')
    writeFileSync(join(project.repoPath, 'input.txt'), 'unstaged input')
  }
  project = workspace.updateProject({
    projectId: project.id,
    expectedRevision: project.revision,
    name: project.name,
    description: 'Project brief snapshot',
    instructions: 'Build clear interfaces.',
    devCommand: 'npm run dev',
    testCommand,
  })
  const task = workspace.createTask({
    projectId: project.id,
    title: 'Build an answer',
    description: 'Write answer.txt',
    acceptanceCriteria: 'The answer is useful.',
  })
  const catalog = new CatalogService(database, appData)
  const skill = await catalog.createSkill({
    name: 'coding-style',
    description: 'Use the project style',
    instructions: 'Read README.md and use readable names.',
  })
  const profile = await catalog.createProfile({
    name: 'Builder',
    roleInstructions: 'Implement the requested feature.',
    styleGuide: 'Keep changes focused.',
    skillIds: [skill.id],
    model: null,
    effort: null,
  })
  const graphs = new GraphService(database, catalog)
  const graph = graphs.get({ projectId: project.id, taskId: task.id })
  const agent = graph.document.nodes.find((node) => node.type === 'agent')!
  if (agent.type !== 'agent') throw new Error('Expected agent')
  agent.data.profileId = profile.id
  const saved = graphs.save({
    projectId: project.id,
    taskId: task.id,
    expectedRevision: graph.revision,
    commandId: randomUUID(),
    document: graph.document,
  })
  const transport = client(turn)
  const execution = new NodeExecutionService(
    database,
    graphs,
    catalog,
    appData,
    transport.client,
    5000,
  )
  services.push(execution)
  await execution.initialize()
  const identity: NodeIdentity = {
    projectId: project.id,
    taskId: task.id,
    nodeId: agent.id,
  }
  const start = (
    mode: 'run' | 'followup' | 'retry' | 'restart' = 'run',
    message?: string,
  ) =>
    execution.start({
      ...identity,
      expectedGraphRevision: saved.revision,
      mode,
      message,
    })
  return {
    root,
    file,
    appData,
    database,
    workspace,
    project,
    task,
    catalog,
    skill,
    profile,
    graphs,
    graph: saved,
    execution,
    transport,
    identity,
    start,
  }
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 250; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for execution state')
}

describe('node execution in isolated worktrees', () => {
  it('reviews combined results in an isolated folder without switching the original checkout or running development commands', async () => {
    const f = await fixture(), identity = { projectId: f.project.id, taskId: f.task.id }
    await expect(f.execution.getReview(identity)).rejects.toThrow('not ready')
    const head = git(f.project.repoPath, 'rev-parse', 'HEAD')
    f.start(); await f.execution.waitForIdle()
    const result = f.execution.worktrees.get(f.task.id)!
    const review = await f.execution.getReview(identity)
    expect(review.path).toBe(result.path)
    expect(review.path).not.toBe(f.project.repoPath)
    expect(review.runCommand).toContain(result.path)
    expect(review.runCommand).not.toContain('git switch')
    expect(existsSync(join(result.path, 'answer.txt'))).toBe(true)
    expect(existsSync(join(f.project.repoPath, 'answer.txt'))).toBe(false)
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(head)
    await f.execution.checkoutTask(identity)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
    await expect(f.execution.getReview({ ...identity, path: '/tmp' })).rejects.toThrow()
    await expect(f.execution.getReview({ ...identity, projectId: randomUUID() })).rejects.toThrow()
  })
  it('runs Default Codex without an assigned or available custom profile', async () => {
    const f = await fixture()
    await f.catalog.setProfileActive({
      id: f.profile.id,
      expectedRevision: f.profile.revision,
      active: false,
    })
    const document = structuredClone(f.graph.document)
    const node = document.nodes.find((node) => node.id === f.identity.nodeId)!
    if (node.type !== 'agent') throw new Error('Expected agent')
    node.data.profileId = null
    node.data.skillIds = []
    const saved = f.graphs.save({
      projectId: f.project.id,
      taskId: f.task.id,
      expectedRevision: f.graph.revision,
      commandId: randomUUID(),
      document,
    })
    expect(saved.validation.valid).toBe(true)
    f.execution.start({
      ...f.identity,
      expectedGraphRevision: saved.revision,
      mode: 'run',
    })
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.status).toBe('completed')
    expect(run.profileSnapshot).toBeUndefined()
    expect(run.options.profileId).toBeUndefined()
    expect(run.skillSnapshots).toEqual([])
    expect(run.resolvedPrompt).toContain(f.task.description)
    expect(run.resolvedPrompt).not.toContain('Agent profile:')
    expect(f.transport.calls[0].options.model).toBeUndefined()
    expect(f.transport.calls[0].options.modelReasoningEffort).toBeUndefined()
  })
  it('establishes shared history before creating a new task worktree for a legacy unborn project', async () => {
    const f = await fixture()
    git(
      f.project.repoPath,
      'rm',
      '-f',
      '--',
      'README.md',
      '.gitignore',
      'input.txt',
    )
    rmSync(join(f.project.repoPath, 'ignored.txt'))
    git(f.project.repoPath, 'update-ref', '-d', 'HEAD')
    f.start()
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.status).toBe('completed')
    const initialHead = git(f.project.repoPath, 'rev-parse', 'main')
    expect(run.worktree?.sourceHead).toBe(initialHead)
    expect(
      git(
        f.project.repoPath,
        'merge-base',
        '--is-ancestor',
        initialHead,
        run.changes!.after.commit,
      ),
    ).toBe('')
  })
  it('executes on an agent branch in its own worktree, saves exact run context, tests, new files and diffs', async () => {
    const f = await fixture(
      undefined,
      false,
      'node -e "console.log(\'TEST_OK\')"',
    )
    const projectHead = git(f.project.repoPath, 'rev-parse', 'HEAD')
    const started = f.start()
    await f.execution.waitForIdle()
    const snapshot = f.execution.get(f.identity),
      run = snapshot.runs[0]
    expect(run.id).toBe(started.runId)
    expect(run.status).toBe('completed')
    expect(run.tests).toMatchObject({
      status: 'passed',
      exitCode: 0,
      output: expect.stringContaining('TEST_OK'),
    })
    expect(run.worktree?.branch).toMatch(/^codex\/build-an-answer-agent-/)
    expect(readFileSync(join(run.worktree!.path, 'input.txt'), 'utf8')).toBe(
      'original input',
    )
    expect(existsSync(join(run.worktree!.path, 'ignored.txt'))).toBe(false)
    expect(existsSync(join(f.project.repoPath, 'answer.txt'))).toBe(false)
    expect(git(f.project.repoPath, 'rev-parse', 'main')).toBe(projectHead)
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(projectHead)
    expect(git(run.worktree!.path, 'rev-parse', 'HEAD')).toBe(run.changes?.after.commit)
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
    expect(run.worktree?.sourceHead).toBe(projectHead)
    expect(run.nodeSnapshot.data.profileId).toBe(f.profile.id)
    expect(run.profileSnapshot?.styleGuide).toBe(f.profile.styleGuide)
    expect(run.skillSnapshots[0].content).toContain('use readable names')
    expect(run.resolvedPrompt).toContain('isolated Git worktree')
    expect(run.resolvedPrompt).not.toContain('disposable lab workspace')
    expect(run.taskSnapshot.acceptanceCriteria).toBe(f.task.acceptanceCriteria)
    expect(run.before?.commit).toMatch(/^[a-f0-9]{40,64}$/)
    expect(run.changes?.files).toEqual([
      { path: 'answer.txt', status: 'added' },
    ])
    const diff = await f.execution.getDiff({
      ...f.identity,
      runId: run.id,
      path: 'answer.txt',
    })
    expect(diff).toMatchObject({
      original: '',
      modified: 'first revision',
      binary: false,
    })
    expect(run.items.find((item) => item.id === 'command')?.text).toBe(
      'wrote answer',
    )
    expect(f.transport.calls[0].options).toMatchObject({
      workingDirectory: run.worktree!.path,
      role: 'worker',
      provider: 'codex',
    })
    expect(existsSync(join(run.worktree!.path, '.constella'))).toBe(false)
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('todo')
  })
  it('preserves dirty original files and independent snapshots across same-thread revisions', async () => {
    let turn = 0
    const f = await fixture((options, _input, _signal, id) => successful(options, ++turn === 1 ? 'first revision' : 'second revision', id ?? 'thread-same'), true)
    const originalHead = git(f.project.repoPath, 'rev-parse', 'HEAD'), index = git(f.project.repoPath, 'diff', '--cached'), status = git(f.project.repoPath, 'status', '--porcelain')
    f.start(); await f.execution.waitForIdle()
    const first = f.execution.get(f.identity).runs[0]
    expect(first.status).toBe('completed')
    expect(readFileSync(join(first.worktree!.path, 'input.txt'), 'utf8')).toBe('original input')
    f.start('followup', 'Second revision'); await f.execution.waitForIdle()
    const second = f.execution.get(f.identity).runs[1]
    expect(second.status).toBe('completed')
    expect(second.threadId).toBe(first.threadId)
    expect(f.transport.calls[1].resumed).toBe('thread-same')
    expect(await f.execution.getDiff({ ...f.identity, runId: first.id, path: 'answer.txt' })).toMatchObject({ original: '', modified: 'first revision' })
    expect(await f.execution.getDiff({ ...f.identity, runId: second.id, path: 'answer.txt' })).toMatchObject({ original: 'first revision', modified: 'second revision' })
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(git(f.project.repoPath, 'diff', '--cached')).toBe(index)
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe(status)
    f.start('restart'); await f.execution.waitForIdle()
    expect(f.transport.calls[2].resumed).toBeUndefined()
  })
  it('persists node thread IDs and attempt history across an app/database restart', async () => {
    const f = await fixture()
    f.start()
    await f.execution.waitForIdle()
    await f.execution.shutdown()
    f.database.close()
    const database = openWorkspaceDatabase(f.file)
    databases.push(database)
    const catalog = new CatalogService(database, f.appData),
      graphs = new GraphService(database, catalog)
    const transport = client((options, _input, _signal, id) =>
      successful(options, 'continued after restart', id),
    )
    const restored = new NodeExecutionService(
      database,
      graphs,
      catalog,
      f.appData,
      transport.client,
    )
    services.push(restored)
    await restored.initialize()
    expect(restored.get(f.identity).runs).toHaveLength(1)
    restored.start({
      ...f.identity,
      expectedGraphRevision: f.graph.revision,
      mode: 'followup',
      message: 'Revise the result after reopening.',
    })
    await restored.waitForIdle()
    expect(transport.calls[0].resumed).toBe('thread-fixture')
    expect(restored.get(f.identity).runs).toHaveLength(2)
  })
  it('streams activity, reserves a project execution slot before async preparation, freezes graph writes, and cancels without rollback', async () => {
    const f = await fixture((options, _input, signal) =>
      (async function* () {
        yield {
          type: 'thread.started',
          thread_id: 'cancel-thread',
        } as ThreadEvent
        writeFileSync(
          join(options.workingDirectory!, 'partial.txt'),
          'partial work',
        )
        yield {
          type: 'item.started',
          item: {
            id: 'slow',
            type: 'command_execution',
            command: 'slow command',
            aggregated_output: '',
            status: 'in_progress',
          },
        } as ThreadEvent
        await new Promise<void>((resolve) => {
          if (signal!.aborted) resolve()
          else
            signal!.addEventListener('abort', () => resolve(), { once: true })
        })
      })(),
    )
    const otherTask = f.workspace.createTask({
      projectId: f.project.id,
      title: 'Another task to review',
    })
    await f.execution.worktrees.ensure(f.project, otherTask)
    f.start()
    expect(() => f.start()).toThrow(/agent is active/)
    expect(() =>
      f.graphs.save({
        projectId: f.project.id,
        taskId: f.task.id,
        expectedRevision: f.graph.revision,
        commandId: randomUUID(),
        document: f.graph.document,
      }),
    ).toThrow(/active node run/)
    await until(() =>
      f.execution
        .get(f.identity)
        .runs[0].items.some((item) => item.id === 'slow'),
    )
    const otherIdentity = { projectId: f.project.id, taskId: otherTask.id }
    expect((await f.execution.getReview(otherIdentity)).active).toBe(false)
    await f.execution.checkoutTask(otherIdentity)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
    await f.execution.stop(f.identity)
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.status).toBe('cancelled')
    expect(run.threadId).toBe('cancel-thread')
    expect(run.tests.status).toBe('not-run')
    expect(run.changes?.files).toContainEqual({
      path: 'partial.txt',
      status: 'added',
    })
    expect(readFileSync(join(run.worktree!.path, 'partial.txt'), 'utf8')).toBe(
      'partial work',
    )
  })
  it('can cancel during preparation before the agent starts', async () => {
    const f = await fixture()
    f.start()
    await f.execution.stop(f.identity)
    await f.execution.waitForIdle()
    expect(f.transport.calls).toHaveLength(0)
    expect(f.execution.get(f.identity).runs[0].status).toBe('cancelled')
  })
  it('records failed checks and supplies their output to a retry in the same thread', async () => {
    const f = await fixture(
      undefined,
      false,
      'node -e "console.log(\'CHECK_FAILURE\');process.exit(2)"',
    )
    f.start()
    await f.execution.waitForIdle()
    const first = f.execution.get(f.identity).runs[0]
    expect(first.status).toBe('failed')
    expect(first.error?.code).toBe('TEST_FAILED')
    expect(first.tests.exitCode).toBe(2)
    expect(first.changes?.files[0].path).toBe('answer.txt')
    f.start('retry')
    await f.execution.waitForIdle()
    expect(f.transport.calls[1].resumed).toBe(first.threadId)
    expect(f.transport.calls[1].input).toContain('CHECK_FAILURE')
    expect(f.execution.get(f.identity).runs[1].prompt).toBe(first.prompt)
  })
  it('stops an active configured test process and records cancellation before releasing the slot', async () => {
    const f = await fixture(
      undefined,
      false,
      'node -e "console.log(\'WAITING_CHECK\');setTimeout(()=>{},30000)"',
    )
    f.start()
    await until(() =>
      f.execution
        .get(f.identity)
        .runs[0].tests.output.includes('WAITING_CHECK'),
    )
    expect(f.execution.get(f.identity).runs[0].status).toBe('testing')
    await f.execution.stop(f.identity)
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.status).toBe('cancelled')
    expect(run.tests.status).toBe('cancelled')
    expect(run.changes?.files).toContainEqual({
      path: 'answer.txt',
      status: 'added',
    })
    expect(f.execution.get(f.identity).active).toBeNull()
  })
  it('times out configured checks, bounds their output, and never reports unconfigured checks as passing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'constella-checks-'))
    directories.push(directory)
    const controller = new AbortController()
    const result = await runChecks(
      'node -e "console.log(\'x\'.repeat(70000))"',
      directory,
      controller.signal,
      () => {},
      5000,
    )
    expect(result.status).toBe('passed')
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(64_000)
    expect(
      (
        await runChecks(
          'node -e "setTimeout(()=>{},30000)"',
          directory,
          controller.signal,
          () => {},
          150,
        )
      ).status,
    ).toBe('timed-out')
    expect(
      (await runChecks('', directory, controller.signal, () => {})).status,
    ).toBe('not-run')
  })
  it('preserves deletions and binary/large files in snapshots with explicit preview limits', async () => {
    const f = await fixture((options) =>
      (async function* (): AsyncGenerator<ThreadEvent> {
        yield* successful(options)
        rmSync(join(options.workingDirectory!, 'input.txt'))
        writeFileSync(
          join(options.workingDirectory!, 'image.bin'),
          Buffer.from([0, 1, 2, 255]),
        )
        writeFileSync(
          join(options.workingDirectory!, 'large.txt'),
          'x'.repeat(600 * 1024),
        )
      })(),
    )
    f.start()
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.changes?.files).toContainEqual({
      path: 'input.txt',
      status: 'deleted',
    })
    expect(
      await f.execution.getDiff({
        ...f.identity,
        runId: run.id,
        path: 'input.txt',
      }),
    ).toMatchObject({ original: 'original input', modified: '' })
    expect(
      (
        await f.execution.getDiff({
          ...f.identity,
          runId: run.id,
          path: 'image.bin',
        })
      ).binary,
    ).toBe(true)
    expect(
      (
        await f.execution.getDiff({
          ...f.identity,
          runId: run.id,
          path: 'large.txt',
        })
      ).unavailable,
    ).toContain('512 KB')
  })
  it('reports permission/auth/EOF failures and releases the slot for explicit retries', async () => {
    let attempt = 0
    const f = await fixture((options) =>
      (async function* (): AsyncGenerator<ThreadEvent> {
        if (++attempt === 1) throw new Error('Permission denied by sandbox')
        if (attempt === 2) {
          yield { type: 'error', message: '401 unauthorized' }
          return
        }
        if (attempt === 3) return
        yield* successful(options)
      })(),
    )
    f.start()
    await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.error?.code).toBe(
      'PERMISSION',
    )
    f.start('retry')
    await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.error?.code).toBe(
      'AUTHENTICATION',
    )
    f.start('retry')
    await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.error?.message).toContain(
      'without handing back its result',
    )
    f.start('retry')
    await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.status).toBe('completed')
  })
  it('reconciles a crash as interrupted, captures retained files, and never starts inference automatically', async () => {
    const f = await fixture()
    f.start()
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    run.status = 'running'
    delete run.finishedAt
    delete run.changes
    f.database.db
      .update(nodeRuns)
      .set({ document: run })
      .where(eq(nodeRuns.id, run.id))
      .run()
    writeFileSync(join(run.worktree!.path, 'after-crash.txt'), 'retained')
    const transport = client((options) => successful(options))
    const restored = new NodeExecutionService(
      f.database,
      f.graphs,
      f.catalog,
      f.appData,
      transport.client,
    )
    services.push(restored)
    await restored.initialize()
    const interrupted = restored.get(f.identity).runs[0]
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.error?.code).toBe('INTERRUPTED')
    expect(interrupted.changes?.files).toContainEqual({
      path: 'after-crash.txt',
      status: 'added',
    })
    expect(transport.calls).toHaveLength(0)
  })
  it('isolates node conversations and rejects foreign task/run/diff identifiers, stale graphs and invalid assignments', async () => {
    const f = await fixture()
    expect(() =>
      f.execution.get({ ...f.identity, projectId: randomUUID() }),
    ).toThrow(/does not belong/)
    expect(() =>
      f.execution.start({
        ...f.identity,
        expectedGraphRevision: 1,
        mode: 'run',
      }),
    ).toThrow(/graph changed/)
    expect(() =>
      f.execution.start({
        ...f.identity,
        nodeId: f.graph.document.nodes[0].id,
        expectedGraphRevision: f.graph.revision,
        mode: 'run',
      }),
    ).toThrow(/agent task node/)
    await f.catalog.setProfileActive({
      id: f.profile.id,
      expectedRevision: f.profile.revision,
      active: false,
    })
    expect(() => f.start()).toThrow(/profile is removed/)
    expect(f.transport.calls).toHaveLength(0)
    await f.catalog.setProfileActive({
      id: f.profile.id,
      expectedRevision: f.profile.revision + 1,
      active: true,
    })
    f.start()
    await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    await expect(
      f.execution.getDiff({
        ...f.identity,
        runId: run.id,
        path: '../../outside',
      }),
    ).rejects.toThrow(/not part/)
    expect(() =>
      f.execution.getRun({
        ...f.identity,
        nodeId: randomUUID(),
        runId: run.id,
      }),
    ).toThrow(/does not belong/)
    const second = f.graph.document.nodes.find((node) => node.type === 'agent')!
    const secondId = randomUUID()
    f.graph.document.nodes.push({ ...structuredClone(second), id: secondId })
    f.graph.document.edges.push(
      {
        id: randomUUID(),
        source: f.graph.document.nodes[0].id,
        target: secondId,
      },
      {
        id: randomUUID(),
        source: secondId,
        target: f.graph.document.nodes.at(-2)!.id,
      },
    )
    const updated = f.graphs.save({
      projectId: f.project.id,
      taskId: f.task.id,
      expectedRevision: f.graph.revision,
      commandId: randomUUID(),
      document: f.graph.document,
    })
    f.execution.start({
      ...f.identity,
      nodeId: secondId,
      expectedGraphRevision: updated.revision,
      mode: 'run',
    })
    await f.execution.waitForIdle()
    expect(f.transport.calls[1].resumed).toBeUndefined()
    expect(
      f.execution.get({ ...f.identity, nodeId: secondId }).runs,
    ).toHaveLength(1)
  })
  it('preserves agent files after an external branch change and recovers after the branch is restored in that worktree', async () => {
    let turn = 0
    const f = await fixture((options) => (async function* (): AsyncGenerator<ThreadEvent> {
      yield* successful(options)
      if (++turn === 1) git(options.workingDirectory!, 'switch', '-c', 'changed-in-ide')
    })())
    f.start(); await f.execution.waitForIdle()
    const run = f.execution.get(f.identity).runs[0]
    expect(run.status).toBe('failed')
    expect(run.inspectionError?.code).toBe('TASK_BRANCH_CHANGED')
    expect(readFileSync(join(run.worktree!.path, 'answer.txt'), 'utf8')).toBe('first revision')
    expect(existsSync(join(f.project.repoPath, 'answer.txt'))).toBe(false)
    f.start('retry'); await f.execution.waitForIdle()
    expect(f.transport.calls).toHaveLength(1)
    git(run.worktree!.path, 'switch', run.worktree!.branch)
    f.start('retry'); await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.status).toBe('completed')
    expect(f.transport.calls[1].resumed).toBe(run.threadId)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
  })
  it('reuses agent worktrees for follow-ups but never recreates deleted branches or runs archived tasks', async () => {
    const f = await fixture()
    f.start(); await f.execution.waitForIdle()
    const worktree = f.execution.get(f.identity).worktree!
    f.start('followup', 'Revise'); await f.execution.waitForIdle()
    expect(f.transport.calls).toHaveLength(2)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
    git(worktree.path, 'switch', '--detach')
    git(f.project.repoPath, 'branch', '-D', worktree.branch)
    f.start('followup', 'Continue'); await f.execution.waitForIdle()
    expect(f.execution.get(f.identity).runs.at(-1)?.error?.message).toContain('saved task branch or workspace is missing')
    expect(f.transport.calls).toHaveLength(2)
    f.workspace.archiveTask({ projectId: f.project.id, taskId: f.task.id, expectedRevision: f.task.revision })
    expect(() => f.start('retry')).toThrow(/Restore this task/)
  })
  it('keeps storage errors visible without an unhandled execution rejection', async () => {
    const f = await fixture()
    f.database.sqlite.exec(
      "CREATE TRIGGER fail_node_save BEFORE UPDATE ON node_runs BEGIN SELECT RAISE(ABORT, 'database simulated failure'); END",
    )
    f.start()
    await f.execution.waitForIdle()
    const snapshot = f.execution.get(f.identity)
    expect(snapshot.persistenceError?.code).toBe('STORAGE')
    expect(snapshot.runs[0].status).toBe('failed')
    expect(snapshot.active).toBeNull()
    f.database.sqlite.exec('DROP TRIGGER fail_node_save')
  })
})

it('blocks a missing declared input before starting the provider', async () => {
  const f = await fixture()
  f.workspace.updateTask({ projectId: f.project.id, taskId: f.task.id, expectedRevision: f.task.revision, title: f.task.title, description: f.task.description, acceptanceCriteria: f.task.acceptanceCriteria, requiredFiles: ['project_plan.md'] })
  f.start(); await f.execution.waitForIdle()
  const run = f.execution.get(f.identity).runs[0]
  expect(run.status).toBe('failed')
  expect(run.error).toMatchObject({ code: 'MISSING_REQUIRED_INPUT', message: expect.stringContaining('project_plan.md') })
  expect(f.transport.calls).toHaveLength(0)
  expect(existsSync(join(f.project.repoPath, 'answer.txt'))).toBe(false)
})

it('opens the task and agent workspaces with the saved IDE command without running development commands', async () => {
  const f = await fixture()
  f.workspace.updateProject({ projectId: f.project.id, expectedRevision: f.project.revision, name: f.project.name, description: '', instructions: '', devCommand: 'SHOULD_NOT_RUN', testCommand: '', ideCommand: 'zed --new' })
  const calls: string[][] = []
  const launch = async (command: string, path: string) => { calls.push([command, path]) }
  await f.execution.openInIde({ projectId: f.project.id, taskId: f.task.id }, launch)
  expect(calls[0]).toEqual(['zed --new', f.execution.worktrees.get(f.task.id)!.path])
  f.start(); await f.execution.waitForIdle()
  await f.execution.openInIde(f.identity, launch)
  expect(calls[1]).toEqual(['zed --new', f.execution.get(f.identity).worktree!.path])
  expect(calls[0][1]).not.toBe(calls[1][1])
  const agentWorkspace = f.execution.get(f.identity).worktree!
  git(agentWorkspace.path, 'switch', '-c', 'repair-in-ide')
  await f.execution.openInIde(f.identity, launch)
  expect(calls[2]).toEqual(['zed --new', agentWorkspace.path])
  expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
})

it('includes edits from the task IDE workspace in the next agent run without touching the original checkout', async () => {
  const f = await fixture()
  const result = await f.execution.worktrees.ensure(f.project, f.task)
  writeFileSync(join(result.path, 'manual-input.txt'), 'written in the IDE')
  f.start()
  await f.execution.waitForIdle()
  const run = f.execution.get(f.identity).runs[0]
  expect(run.status).toBe('completed')
  expect(readFileSync(join(run.worktree!.path, 'manual-input.txt'), 'utf8')).toBe('written in the IDE')
  expect(existsSync(join(f.project.repoPath, 'manual-input.txt'))).toBe(false)
  expect(git(result.path, 'status', '--porcelain')).toBe('')
})

it('stops one agent independently and stops all remaining agents when their task is stopped', async () => {
  const f = await fixture((options, _prompt, signal) => (async function* (): AsyncGenerator<ThreadEvent> {
    yield { type: 'thread.started', thread_id: 'parallel-stop' }
    writeFileSync(join(options.workingDirectory!, 'partial.txt'), 'keep partial work')
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve()
      else signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })())
  const document = structuredClone(f.graph.document)
  const agent = document.nodes.find((node) => node.type === 'agent')!
  const second = { ...structuredClone(agent), id: randomUUID() }
  document.nodes.push(second)
  const start = document.nodes.find((node) => node.type === 'start')!
  const review = document.nodes.find((node) => node.type === 'review')!
  document.edges.push(
    { id: randomUUID(), source: start.id, target: second.id },
    { id: randomUUID(), source: second.id, target: review.id },
  )
  const saved = f.graphs.save({ projectId: f.project.id, taskId: f.task.id, expectedRevision: f.graph.revision, commandId: randomUUID(), document })
  const secondIdentity = { ...f.identity, nodeId: second.id }
  f.execution.start({ ...f.identity, expectedGraphRevision: saved.revision, mode: 'run' })
  f.execution.start({ ...secondIdentity, expectedGraphRevision: saved.revision, mode: 'run' })
  await until(() => f.transport.calls.length === 2)
  expect(f.execution.getTask({ projectId: f.project.id, taskId: f.task.id }).activeRuns).toHaveLength(2)
  await f.execution.stop(f.identity)
  await until(() => f.execution.get(f.identity).runs[0].status === 'cancelled')
  expect(f.execution.get(secondIdentity).active?.nodeId).toBe(second.id)
  await f.execution.stopTask(f.identity)
  await f.execution.waitForIdle()
  expect(f.execution.getTask({ projectId: f.project.id, taskId: f.task.id }).activeRuns).toHaveLength(0)
  for (const identity of [f.identity, secondIdentity]) {
    const run = f.execution.get(identity).runs[0]
    expect(run.status).toBe('cancelled')
    expect(readFileSync(join(run.worktree!.path, 'partial.txt'), 'utf8')).toBe('keep partial work')
  }
})

/** Windows keeps database/Git handles open a moment longer than POSIX; leave
 * the temp folder behind there instead of failing an otherwise passing test. */
function removeTemp(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}
