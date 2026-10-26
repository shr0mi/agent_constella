import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { workflows, nodeRuns, workflowDecisions } from '../src/main/db/schema'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { NodeExecutionService } from '../src/main/application/node-execution-service'
import { WorkflowService } from '../src/main/application/workflow-service'
import { makeWorkflowNode, type WorkflowNode } from '../src/shared/graph'
import { BranchIntegrationService } from '../src/main/application/branch-integration'
import type { CodexClient } from '../src/main/codex/service'

const roots: string[] = [],
  databases: WorkspaceDatabase[] = [],
  schedulers: WorkflowService[] = []
afterEach(async () => {
  await Promise.all(
    schedulers.splice(0).map((scheduler) => scheduler.shutdown()),
  )
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function commit(path: string) {
  git(path, 'add', '.')
  git(
    path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Source changes',
  )
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 1000; n++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Workflow condition timed out')
}
async function fixture(
  options: {
    manualA?: boolean
    failA?: boolean
    empty?: boolean
    editInput?: boolean
    hangA?: boolean
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'constella-workflow-'))
  roots.push(root)
  const appData = join(root, 'app'),
    file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database),
    project = await workspace.createProject({ path: join(root, 'project') })
  if (!options.empty) {
    writeFileSync(join(project.repoPath, 'input.txt'), 'base\n')
    commit(project.repoPath)
  }
  const task = workspace.createTask({
    projectId: project.id,
    title: 'Branching workflow',
    description: 'Build a branching graph.',
  })
  const catalog = new CatalogService(database, appData),
    graphs = new GraphService(database, catalog)
  const initial = graphs.get({ projectId: project.id, taskId: task.id })
  const make = (type: WorkflowNode['type'], title: string) => {
    const node = makeWorkflowNode(type, randomUUID(), { x: 0, y: 0 })
    node.data.title = title
    if (node.type === 'agent') {
      node.data.prompt = `Work on ${title}`
      node.data.acceptance =
        title === 'A' && options.manualA ? 'manual' : 'auto'
    }
    return node
  }
  const start = make('start', 'Start'),
    a = make('agent', 'A'),
    b = make('agent', 'B'),
    joinNode = make('agent', 'Join'),
    review = make('review', 'Review'),
    end = make('end', 'End')
  const pairs = [
    [start, a],
    [start, b],
    [a, joinNode],
    [b, joinNode],
    [joinNode, review],
    [review, end],
  ]
  const graph = graphs.save({
    projectId: project.id,
    taskId: task.id,
    expectedRevision: initial.revision,
    commandId: randomUUID(),
    document: {
      nodes: [start, a, b, joinNode, review, end],
      edges: pairs.map(([source, target]) => ({
        id: randomUUID(),
        source: source.id,
        target: target.id,
      })),
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  })
  const calls: { name: string; resumed?: string; prompt: string }[] = []
  let running = 0,
    maxRunning = 0,
    failed = false
  const thread = (config: ThreadOptions, resumed?: string) => ({
    async runStreamed(prompt: string, turn: TurnOptions) {
      const name = prompt.match(/\nNode: (.+)\n/)?.[1] ?? 'unknown'
      return {
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          calls.push({ name, resumed, prompt })
          running++
          maxRunning = Math.max(maxRunning, running)
          try {
            yield {
              type: 'thread.started',
              thread_id: resumed ?? `thread-${name}`,
            }
            if (name === 'A' && options.hangA) {
              await new Promise<void>((resolve) => {
                if (turn.signal?.aborted) resolve()
                else
                  turn.signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  })
              })
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 8))
            writeFileSync(
              join(config.workingDirectory!, `${name}.txt`),
              `Result for ${name}\n${calls.length}`,
            )
            if (options.editInput && name === 'A')
              writeFileSync(
                join(config.workingDirectory!, 'input.txt'),
                'agent change\n',
              )
            if (options.failA && name === 'A' && !failed) {
              failed = true
              yield {
                type: 'turn.failed',
                error: { message: 'Deliberate fixture failure' },
              }
              return
            }
            yield {
              type: 'item.completed',
              item: {
                id: 'message',
                type: 'agent_message',
                text: `Finished ${name}`,
              },
            }
            yield {
              type: 'turn.completed',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            }
          } finally {
            running--
          }
        })(),
      }
    },
  })
  const client: CodexClient = {
    startThread: (config) => thread(config),
    resumeThread: (id, config) => thread(config, id),
  }
  const execution = new NodeExecutionService(
    database,
    graphs,
    catalog,
    appData,
    client,
  )
  await execution.initialize()
  const scheduler = new WorkflowService(
    database,
    graphs,
    catalog,
    execution,
    workspace,
  )
  schedulers.push(scheduler)
  await scheduler.initialize()
  const identity = { projectId: project.id, taskId: task.id }
  const snapshot = () => scheduler.get(identity)
  const begin = () =>
    scheduler.start({
      ...identity,
      expectedGraphRevision: graphs.get(identity).revision,
    })
  const approve = () =>
    scheduler.review(
      {
        ...identity,
        nodeId: review.id,
        expectedRevision: snapshot().revision,
        decision: 'approve',
      },
      'desktop-human',
    )
  const waitingReview = () =>
    until(
      () =>
        snapshot().nodes[review.id].status === 'waiting-review' &&
        snapshot().phase === 'waiting',
    )
  return {
    root,
    file,
    appData,
    database,
    workspace,
    project,
    task,
    catalog,
    graphs,
    graph,
    execution,
    scheduler,
    identity,
    snapshot,
    begin,
    approve,
    waitingReview,
    a,
    b,
    joinNode,
    review,
    end,
    calls,
    client,
    maxRunning: () => maxRunning,
  }
}

describe('workflow scheduler, acceptance and review gates', () => {
  it('runs only the selected eligible node and keeps joins gated through manual acceptance and review revisions', async () => {
    const f = await fixture({ manualA: true })
    const run = (nodeId: string, mode: 'run' | 'followup' = 'run') =>
      f.scheduler.startNode({
        ...f.identity,
        nodeId,
        expectedGraphRevision: f.graph.revision,
        mode,
        ...(mode === 'followup'
          ? {
              message:
                'Update this node with the accepted prerequisite results.',
            }
          : {}),
      })
    const acceptA = () =>
      f.scheduler.accept(
        {
          ...f.identity,
          nodeId: f.a.id,
          expectedRevision: f.snapshot().revision,
          runId: f.snapshot().nodes[f.a.id].runId!,
        },
        'desktop-human',
      )
    run(f.a.id)
    await until(
      () => f.snapshot().nodes[f.a.id].status === 'awaiting-acceptance',
    )
    await f.scheduler.waitForIdle()
    expect(f.snapshot().scheduling).toBe('manual')
    expect(f.calls.map((call) => call.name)).toEqual(['A'])
    expect(() => run(f.joinNode.id)).toThrow(/Every predecessor/)
    run(f.b.id)
    await until(() => f.snapshot().nodes[f.b.id].status === 'completed')
    expect(() => run(f.joinNode.id)).toThrow(/Every predecessor/)
    acceptA()
    await f.scheduler.waitForIdle()
    expect(f.snapshot().nodes[f.joinNode.id].status).toBe('ready')
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'B'])
    run(f.joinNode.id)
    await f.waitingReview()
    f.scheduler.review(
      {
        ...f.identity,
        nodeId: f.review.id,
        expectedRevision: f.snapshot().revision,
        decision: 'changes',
        targetNodeId: f.a.id,
        note: 'Revise A before releasing this review.',
      },
      'desktop-human',
    )
    await until(
      () => f.snapshot().nodes[f.a.id].status === 'awaiting-acceptance',
    )
    acceptA()
    await f.scheduler.waitForIdle()
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'B', 'Join', 'A'])
    expect(f.calls.at(-1)?.resumed).toBe('thread-A')
    expect(f.snapshot().nodes[f.end.id].status).not.toBe('completed')
    run(f.joinNode.id, 'followup')
    await f.waitingReview()
    f.approve()
    expect(f.snapshot().phase).toBe('completed')
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('done')
  })
  it('reopens integrated work for an explicit same-thread revision and requires new downstream review', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    f.approve()
    const plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(
      (
        await f.scheduler.integrate(
          {
            ...f.identity,
            expectedRevision: plan.workflowRevision,
            targetBranch: plan.targetBranch!,
            targetHead: plan.targetHead,
          },
          'desktop-human',
        )
      ).status,
    ).toBe('integrated')
    const approval = f.snapshot().nodes[f.review.id].acceptanceId
    f.scheduler.startNode({
      ...f.identity,
      nodeId: f.a.id,
      expectedGraphRevision: f.graph.revision,
      mode: 'followup',
      message: 'Refine the completed implementation.',
    })
    let state = f.snapshot()
    expect(state.phase).toBe('running')
    expect(state.nodes[f.review.id].acceptanceId).toBeUndefined()
    expect(state.nodes[f.end.id].acceptanceId).toBeUndefined()
    expect(state.integration).toBeUndefined()
    expect(state.integrationHistory).toHaveLength(1)
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('doing')
    await until(() => f.snapshot().nodes[f.a.id].status === 'completed')
    expect(f.calls).toHaveLength(4)
    f.begin()
    await f.waitingReview()
    expect(f.calls.filter((call) => call.name === 'A').at(-1)?.resumed).toBe(
      'thread-A',
    )
    expect(f.calls.map((call) => call.name)).toEqual([
      'A',
      'B',
      'Join',
      'A',
      'Join',
    ])
    expect(f.snapshot().nodes[f.end.id].status).not.toBe('completed')
    f.approve()
    state = f.snapshot()
    expect(state.phase).toBe('completed')
    expect(state.nodes[f.review.id].acceptanceId).not.toBe(approval)
    const second = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: state.revision,
    })
    expect(second.status).toBe('ready')
    expect(
      (
        await f.scheduler.integrate(
          {
            ...f.identity,
            expectedRevision: second.workflowRevision,
            targetBranch: second.targetBranch!,
            targetHead: second.targetHead,
          },
          'desktop-human',
        )
      ).status,
    ).toBe('integrated')
    expect(readFileSync(join(f.project.repoPath, 'A.txt'), 'utf8')).toContain(
      '4',
    )
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
  })
  it('keeps a paused review decision from scheduling End until explicit resume', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    await f.scheduler.pause(f.identity)
    f.approve()
    expect(f.snapshot().phase).toBe('paused')
    expect(f.snapshot().nodes[f.review.id].acceptedBy).toBe('human')
    expect(f.snapshot().nodes[f.end.id].status).not.toBe('completed')
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('doing')
    f.begin()
    expect(f.snapshot().phase).toBe('completed')
    expect(f.calls).toHaveLength(3)
  })
  it('serializes work across tasks in a project while letting another task proceed past a blocked workflow', async () => {
    const f = await fixture({ failA: true })
    const task = f.workspace.createTask({
      projectId: f.project.id,
      title: 'Second task',
      description: 'Work on C',
    })
    const identity = { projectId: f.project.id, taskId: task.id },
      graph = f.graphs.get(identity)
    const start = makeWorkflowNode('start', randomUUID(), { x: 0, y: 0 }),
      agent = makeWorkflowNode('agent', randomUUID(), { x: 200, y: 0 }),
      review = makeWorkflowNode('review', randomUUID(), { x: 400, y: 0 }),
      end = makeWorkflowNode('end', randomUUID(), { x: 600, y: 0 })
    if (agent.type !== 'agent') throw new Error('Expected agent')
    agent.data.title = 'C'
    agent.data.prompt = 'Work on C'
    agent.data.acceptance = 'auto'
    const nodes = [start, agent, review, end]
    const saved = f.graphs.save({
      ...identity,
      expectedRevision: graph.revision,
      commandId: randomUUID(),
      document: {
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
          id: randomUUID(),
          source: nodes[index].id,
          target: node.id,
        })),
        viewport: graph.document.viewport,
      },
    })
    f.begin()
    f.scheduler.start({ ...identity, expectedGraphRevision: saved.revision })
    await until(() => f.scheduler.get(identity).phase === 'waiting')
    expect(f.snapshot().phase).toBe('blocked')
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'C'])
    expect(f.maxRunning()).toBe(1)
    expect(
      f.workspace
        .getBoard({ projectId: f.project.id })
        .tasks.every((task) => task.status === 'doing'),
    ).toBe(true)
  })
  it('marks an in-flight result stale when its project context changes without accepting the old configuration', async () => {
    const f = await fixture({ hangA: true })
    f.begin()
    await until(() => f.calls.length === 1)
    const project = f.workspace.getBoard({ projectId: f.project.id }).project
    f.workspace.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name: project.name,
      description: 'Changed project context',
      instructions: '',
      devCommand: '',
      testCommand: '',
    })
    expect(f.snapshot().phase).toBe('paused')
    await f.execution.stopTask(f.identity)
    expect(f.snapshot().nodes[f.a.id].status).toBe('stale')
    expect(f.snapshot().nodes[f.a.id].acceptanceId).toBeUndefined()
    expect(f.calls).toHaveLength(1)
  })
  it('stops before archive and restores metadata in a paused state without rerunning code', async () => {
    const f = await fixture({ hangA: true })
    f.begin()
    await until(() => f.calls.length === 1)
    const task = f.workspace.getBoard({ projectId: f.project.id }).tasks[0]
    await f.scheduler.archive(f.identity)
    const archived = f.workspace.archiveTask({
      ...f.identity,
      expectedRevision: task.revision,
    })
    expect(f.snapshot().phase).toBe('archived')
    expect(f.execution.activeProject(f.project.id)).toBeNull()
    f.workspace.restoreTask({
      ...f.identity,
      expectedRevision: archived.revision,
    })
    expect(f.snapshot().phase).toBe('paused')
    expect(f.calls).toHaveLength(1)
  })
  it('runs ready branches serially, waits for every accepted predecessor, and lets only the human release review and End', async () => {
    const f = await fixture({ manualA: true })
    f.begin()
    await until(
      () =>
        f.snapshot().phase === 'waiting' &&
        f.snapshot().nodes[f.b.id].status === 'completed',
    )
    let state = f.snapshot()
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'B'])
    expect(state.nodes[f.a.id].status).toBe('awaiting-acceptance')
    expect(state.nodes[f.joinNode.id].status).toBe('pending')
    expect(f.maxRunning()).toBe(1)
    const boardTask = f.workspace.getBoard({ projectId: f.project.id }).tasks[0]
    expect(boardTask.status).toBe('doing')
    expect(() =>
      f.workspace.moveTask({
        ...f.identity,
        expectedRevision: boardTask.revision,
        status: 'done',
      }),
    ).toThrow(/controlled by its workflow/)
    expect(() =>
      f.scheduler.startNode({
        ...f.identity,
        nodeId: f.joinNode.id,
        expectedGraphRevision: f.graph.revision,
        mode: 'run',
      }),
    ).toThrow(/Every predecessor/)
    expect(() =>
      f.execution.start({
        ...f.identity,
        nodeId: f.joinNode.id,
        expectedGraphRevision: f.graph.revision,
        mode: 'run',
      }),
    ).toThrow()
    const accept = {
      ...f.identity,
      nodeId: f.a.id,
      runId: state.nodes[f.a.id].runId!,
      expectedRevision: state.revision,
    }
    expect(() => f.scheduler.accept(accept, 'worker')).toThrow(
      /Only an explicit human/,
    )
    f.scheduler.accept(accept, 'desktop-human')
    await f.waitingReview()
    state = f.snapshot()
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'B', 'Join'])
    const joinRun = f.execution
      .get({ ...f.identity, nodeId: f.joinNode.id })
      .runs.at(-1)!
    expect(
      joinRun.dependencyResults.map((result) => result.nodeId).sort(),
    ).toEqual([f.a.id, f.b.id].sort())
    expect(
      joinRun.dependencyResults.every(
        (result) => result.status === 'completed and accepted',
      ),
    ).toBe(true)
    expect(state.nodes[f.review.id].acceptedBy).toBeUndefined()
    expect(state.evidence[f.review.id].map((result) => result.title)).toEqual(
      expect.arrayContaining(['A', 'B', 'Join']),
    )
    const decision = {
      ...f.identity,
      nodeId: f.review.id,
      expectedRevision: state.revision,
      decision: 'approve' as const,
    }
    expect(() => f.scheduler.review(decision, 'manager')).toThrow(
      /Only an explicit human/,
    )
    expect(() =>
      f.scheduler.review({ ...decision, actor: 'human' }, 'desktop-human'),
    ).toThrow()
    f.approve()
    state = f.snapshot()
    expect(state.phase).toBe('completed')
    expect(state.nodes[f.review.id].acceptedBy).toBe('human')
    expect(state.nodes[f.end.id].status).toBe('completed')
    expect(state.summary.accepted).toBe(state.summary.total)
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('done')
    expect(
      f.database.db
        .select()
        .from(workflowDecisions)
        .all()
        .map((row) => row.document.actor),
    ).toEqual(['human', 'human'])
  })
  it('blocks on failure, never silently retries, and uses the successful retry at the join', async () => {
    const f = await fixture({ failA: true })
    f.begin()
    await until(() => f.snapshot().phase === 'blocked')
    expect(f.snapshot().nodes[f.a.id].status).toBe('failed')
    expect(f.calls.map((call) => call.name)).toEqual(['A'])
    const failedId = f.snapshot().nodes[f.a.id].runId
    f.begin()
    await until(() => f.snapshot().phase === 'blocked')
    expect(f.calls).toHaveLength(1)
    f.scheduler.startNode({
      ...f.identity,
      nodeId: f.a.id,
      expectedGraphRevision: f.graph.revision,
      mode: 'retry',
    })
    await until(() => f.snapshot().nodes[f.a.id].status === 'completed')
    expect(f.calls).toHaveLength(2)
    f.begin()
    await f.waitingReview()
    expect(f.calls.map((call) => call.name)).toEqual(['A', 'A', 'B', 'Join'])
    const dependencies = f.execution
      .get({ ...f.identity, nodeId: f.joinNode.id })
      .runs.at(-1)!.dependencyResults
    expect(dependencies.some((result) => result.runId === failedId)).toBe(false)
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('doing')
  })
  it('requests a revision in the upstream conversation and invalidates downstream results and prior review acceptance', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    const state = f.snapshot(),
      oldJoin = state.nodes[f.joinNode.id].runId
    f.scheduler.review(
      {
        ...f.identity,
        nodeId: f.review.id,
        expectedRevision: state.revision,
        decision: 'changes',
        targetNodeId: f.a.id,
        note: 'Improve the A result before approval.',
      },
      'desktop-human',
    )
    await f.waitingReview()
    expect(f.calls.map((call) => call.name)).toEqual([
      'A',
      'B',
      'Join',
      'A',
      'Join',
    ])
    expect(f.calls[3].resumed).toBe('thread-A')
    expect(f.calls[3].prompt).toContain('Improve the A result')
    expect(f.snapshot().nodes[f.joinNode.id].runId).not.toBe(oldJoin)
    expect(f.snapshot().nodes[f.review.id].acceptanceId).toBeUndefined()
    expect(f.snapshot().nodes[f.end.id].status).not.toBe('completed')
    f.approve()
    expect(f.snapshot().phase).toBe('completed')
  })
  it('pauses on graph edits, keeps unaffected accepted work, and reruns stale descendants only after explicit resume', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    f.approve()
    const oldB = f.snapshot().nodes[f.b.id].runId
    const graph = f.graphs.get(f.identity),
      document = structuredClone(graph.document)
    const node = document.nodes.find((node) => node.id === f.a.id)!
    if (node.type === 'agent') node.data.prompt = 'Updated instructions for A'
    const saved = f.graphs.save({
      ...f.identity,
      document,
      expectedRevision: graph.revision,
      commandId: randomUUID(),
    })
    expect(f.snapshot().phase).toBe('paused')
    expect(f.snapshot().nodes[f.a.id].status).toBe('stale')
    expect(f.snapshot().nodes[f.b.id].status).toBe('completed')
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].status,
    ).toBe('doing')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(f.calls).toHaveLength(3)
    f.scheduler.start({ ...f.identity, expectedGraphRevision: saved.revision })
    await f.waitingReview()
    expect(f.calls.map((call) => call.name)).toEqual([
      'A',
      'B',
      'Join',
      'A',
      'Join',
    ])
    expect(f.snapshot().nodes[f.b.id].runId).toBe(oldB)
    expect(f.calls[3].prompt).toContain('Updated instructions for A')
    f.approve()
    expect(f.snapshot().phase).toBe('completed')
  })
  it('rejects stale decisions and foreign IDs without approving or executing anything', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    const state = f.snapshot()
    expect(() =>
      f.scheduler.review(
        {
          ...f.identity,
          nodeId: f.review.id,
          expectedRevision: state.revision - 1,
          decision: 'approve',
        },
        'desktop-human',
      ),
    ).toThrow(/workflow changed/)
    expect(() =>
      f.scheduler.get({ ...f.identity, projectId: randomUUID() }),
    ).toThrow(/does not belong/)
    expect(() =>
      f.scheduler.review(
        {
          ...f.identity,
          nodeId: f.a.id,
          expectedRevision: state.revision,
          decision: 'approve',
        },
        'desktop-human',
      ),
    ).toThrow(/review is not ready/)
    expect(f.snapshot().nodes[f.review.id].status).toBe('waiting-review')
  })
  it('pauses recovery and does not rerun an interrupted node on restart or resume', async () => {
    const f = await fixture({ hangA: true })
    f.begin()
    await until(() => f.calls.length === 1)
    const record = f.database.db
      .select()
      .from(workflows)
      .where(eq(workflows.taskId, f.task.id))
      .get()!.document
    const run = f.database.db.select().from(nodeRuns).get()!.document
    await f.scheduler.shutdown()
    f.database.db
      .update(workflows)
      .set({ document: record })
      .where(eq(workflows.taskId, f.task.id))
      .run()
    f.database.db
      .update(nodeRuns)
      .set({ document: run })
      .where(eq(nodeRuns.id, run.id))
      .run()
    const execution = new NodeExecutionService(
      f.database,
      f.graphs,
      f.catalog,
      f.appData,
      f.client,
    )
    await execution.initialize()
    const scheduler = new WorkflowService(
      f.database,
      f.graphs,
      f.catalog,
      execution,
      f.workspace,
    )
    schedulers.push(scheduler)
    await scheduler.initialize()
    expect(scheduler.get(f.identity).phase).toBe('paused')
    expect(scheduler.get(f.identity).nodes[f.a.id].status).toBe('interrupted')
    scheduler.start({ ...f.identity, expectedGraphRevision: f.graph.revision })
    await until(() => scheduler.get(f.identity).phase === 'blocked')
    expect(f.calls).toHaveLength(1)
  })
})

describe('explicit task branch integration', () => {
  it('rejects a target commit changed after preview and preserves the new project commit', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    f.approve()
    const plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    writeFileSync(join(f.project.repoPath, 'new-local.txt'), 'new project work')
    commit(f.project.repoPath)
    const head = git(f.project.repoPath, 'rev-parse', 'HEAD')
    const result = await f.scheduler.integrate(
      {
        ...f.identity,
        expectedRevision: plan.workflowRevision,
        targetBranch: plan.targetBranch!,
        targetHead: plan.targetHead,
      },
      'desktop-human',
    )
    expect(result.status).toBe('failed')
    expect(result.message).toContain('changed after the preview')
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(f.project.repoPath, 'A.txt'))).toBe(false)
  })
  it('previews without changing the project, then integrates only on the human action', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    f.approve()
    const before = git(f.project.repoPath, 'rev-parse', 'HEAD')
    const plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(plan.status).toBe('ready')
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(f.project.repoPath, 'A.txt'))).toBe(false)
    const command = {
      ...f.identity,
      expectedRevision: plan.workflowRevision,
      targetBranch: plan.targetBranch!,
      targetHead: plan.targetHead,
    }
    await expect(f.scheduler.integrate(command, 'worker')).rejects.toThrow(
      /Only an explicit human/,
    )
    const integrated = await f.scheduler.integrate(command, 'desktop-human')
    expect(integrated.status).toBe('integrated')
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(integrated.commit)
    expect(readFileSync(join(f.project.repoPath, 'A.txt'), 'utf8')).toContain(
      'Result for A',
    )
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
  })
  it('reports conflicts without modifying either checkout or starting a merge in the project', async () => {
    const f = await fixture({ editInput: true })
    f.begin()
    await f.waitingReview()
    f.approve()
    writeFileSync(join(f.project.repoPath, 'input.txt'), 'user change\n')
    commit(f.project.repoPath)
    const before = git(f.project.repoPath, 'rev-parse', 'HEAD')
    const plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(plan.status).toBe('conflicts')
    expect(plan.conflicts).toContain('input.txt')
    expect(readFileSync(join(f.project.repoPath, 'input.txt'), 'utf8')).toBe(
      'user change\n',
    )
    expect(git(f.project.repoPath, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
    expect(f.snapshot().phase).toBe('completed')
    expect(f.workspace.getSnapshot().workflows?.[0].integration).toBe(
      'conflicts',
    )
  })
  it('refuses dirty project files and changes made after the accepted task snapshot', async () => {
    const f = await fixture()
    f.begin()
    await f.waitingReview()
    f.approve()
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'preserve me')
    let plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(plan.status).toBe('blocked')
    expect(plan.message).toContain('uncommitted or untracked')
    rmSync(join(f.project.repoPath, 'local.txt'))
    writeFileSync(
      join(f.execution.worktrees.get(f.task.id)!.path, 'external.txt'),
      'not accepted',
    )
    plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(plan.status).toBe('blocked')
    expect(plan.message).toContain('changed after the accepted')
    expect(existsSync(join(f.project.repoPath, 'external.txt'))).toBe(false)
  })
  it('integrates a clean initially empty repository without requiring a manual first commit', async () => {
    const f = await fixture({ empty: true })
    const initialHead = git(f.project.repoPath, 'rev-parse', 'HEAD')
    f.begin()
    await f.waitingReview()
    f.approve()
    const plan = await f.scheduler.previewIntegration({
      ...f.identity,
      expectedRevision: f.snapshot().revision,
    })
    expect(plan.targetHead).toBe(initialHead)
    expect(plan.status).toBe('ready')
    const integrated = await f.scheduler.integrate(
      {
        ...f.identity,
        expectedRevision: plan.workflowRevision,
        targetBranch: plan.targetBranch!,
        targetHead: initialHead,
      },
      'desktop-human',
    )
    expect(integrated.status).toBe('integrated')
    expect(existsSync(join(f.project.repoPath, 'Join.txt'))).toBe(true)
  })
  it('integrates two todo branches created before the first integration from a new empty project', async () => {
    const f = await fixture({ empty: true })
    const initialHead = git(f.project.repoPath, 'rev-parse', 'HEAD')
    const secondTask = f.workspace.createTask({
      projectId: f.project.id,
      title: 'Second todo',
    })
    const worktrees = f.execution.worktrees
    const first = await worktrees.ensure(f.project, f.task)
    const second = await worktrees.ensure(f.project, secondTask)
    expect(first.sourceHead).toBe(initialHead)
    expect(second.sourceHead).toBe(initialHead)
    writeFileSync(join(first.path, 'first.txt'), 'First task result')
    writeFileSync(join(second.path, 'second.txt'), 'Second task result')
    const firstResult = await worktrees.capture(
      first.path,
      'Accepted first todo',
    )
    const secondResult = await worktrees.capture(
      second.path,
      'Accepted second todo',
    )
    const integration = new BranchIntegrationService(worktrees)
    const firstPlan = await integration.preview(
      f.project,
      first,
      firstResult,
      1,
    )
    expect(firstPlan.status).toBe('ready')
    const firstIntegration = await integration.apply(
      f.project,
      first,
      firstResult,
      {
        targetBranch: firstPlan.targetBranch!,
        targetHead: firstPlan.targetHead,
      },
      1,
    )
    expect(firstIntegration.status).toBe('integrated')
    const secondPlan = await integration.preview(
      f.project,
      second,
      secondResult,
      1,
    )
    expect(secondPlan.status).toBe('ready')
    const secondIntegration = await integration.apply(
      f.project,
      second,
      secondResult,
      {
        targetBranch: secondPlan.targetBranch!,
        targetHead: secondPlan.targetHead,
      },
      1,
    )
    expect(secondIntegration.status).toBe('integrated')
    expect(readFileSync(join(f.project.repoPath, 'first.txt'), 'utf8')).toBe(
      'First task result',
    )
    expect(readFileSync(join(f.project.repoPath, 'second.txt'), 'utf8')).toBe(
      'Second task result',
    )
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
  })
})
