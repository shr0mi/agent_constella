import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it } from 'vitest'
import { openWorkspaceDatabase } from '../src/main/db/database'
import { nodeRuns, taskGraphs, tasks, workflows } from '../src/main/db/schema'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { NodeExecutionService } from '../src/main/application/node-execution-service'
import { makeWorkflowNode } from '../src/shared/graph'
import type { NodeRun } from '../src/shared/execution'
import type { WorkflowNodeStatus, WorkflowRecord } from '../src/shared/workflow'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-sessions-'))
  const database = openWorkspaceDatabase(':memory:')
  cleanups.push(() => { database.close(); rmSync(root, { recursive: true, force: true }) })
  const workspace = new WorkspaceService(database)
  const project = await workspace.createProject({ path: join(root, 'project') })
  const task = workspace.createTask({ projectId: project.id, title: 'Build the editor', description: '' })
  const catalog = new CatalogService(database, root)
  const graphs = new GraphService(database, catalog)
  const graph = graphs.get({ projectId: project.id, taskId: task.id })
  const execution = new NodeExecutionService(database, graphs, catalog, root)
  const record: WorkflowRecord = {
    projectId: project.id, taskId: task.id, revision: 1, graphRevision: graph.revision,
    phase: 'waiting', updatedAt: '2026-11-07T00:00:00Z', nodes: {},
  }
  function saveGraph() {
    database.db.update(taskGraphs).set({ document: graph.document }).where(eq(taskGraphs.taskId, task.id)).run()
  }
  function add(status: NodeRun['status'], workflowStatus?: WorkflowNodeStatus, time = '2026-11-07T00:00:00Z') {
    const node = makeWorkflowNode('agent', randomUUID(), { x: 0, y: 0 })
    if (node.type !== 'agent') throw new Error('Expected agent')
    node.data.title = `Node ${graph.document.nodes.length}`
    graph.document.nodes.push(node)
    saveGraph()
    const run: NodeRun = {
      id: randomUUID(), nodeId: node.id, projectId: project.id, taskId: task.id,
      graphRevision: graph.revision, mode: 'run', status, nodeSnapshot: node,
      taskSnapshot: task, projectContext: project, dependencyResults: [],
      prompt: 'Implement the editor', resolvedPrompt: '', options: { sandbox: 'workspace-write', skillIds: [] }, skillSnapshots: [],
      startedAt: time, items: [], events: [], tests: { command: '', status: 'not-run', output: '', truncated: false, exitCode: null },
    }
    saveRun(run)
    if (workflowStatus) {
      record.nodes[node.id] = {
        id: node.id, title: node.data.title, type: 'agent', signature: 'fixture',
        status: workflowStatus, runId: run.id,
        ...(workflowStatus === 'completed' ? { acceptanceId: randomUUID() } : {}),
      }
      database.db.insert(workflows).values({ taskId: task.id, projectId: project.id, document: record })
        .onConflictDoUpdate({ target: workflows.taskId, set: { document: record } }).run()
    }
    return { node, run }
  }
  function saveRun(run: NodeRun) {
    database.db.insert(nodeRuns).values({ id: run.id, nodeId: run.nodeId, taskId: run.taskId, projectId: run.projectId, startedAt: run.startedAt, document: run }).run()
  }
  return { database, execution, graph, task, project, record, add, saveRun, saveGraph, graphs, catalog, root }
}

it('lists running, attention, and accepted results using current node names and workflow acceptance', async () => {
  const f = await fixture()
  expect(f.execution.listSessions()).toEqual([])
  const running = f.add('testing', 'running')
  const attention = f.add('completed', 'awaiting-acceptance')
  const done = f.add('completed', 'completed')
  f.add('failed', 'failed')
  f.add('cancelled', 'stopped')
  f.add('interrupted', 'interrupted')
  f.add('completed', 'stale')
  f.add('completed')
  running.node.data.title = 'Verify a long node title with renamed scope'
  f.saveGraph()
  const sessions = f.execution.listSessions()
  expect(sessions).toHaveLength(8)
  expect(sessions.find((s) => s.nodeId === running.node.id)).toMatchObject({
    state: 'running', detail: 'Running checks', title: running.node.data.title,
    projectName: f.project.name, taskTitle: f.task.title,
  })
  expect(sessions.find((s) => s.nodeId === attention.node.id)).toMatchObject({ state: 'attention', detail: 'Awaiting acceptance' })
  expect(sessions.find((s) => s.nodeId === done.node.id)?.state).toBe('done')
  expect(sessions.filter((s) => s.state === 'attention')).toHaveLength(6)
  expect(sessions.at(-1)?.state).toBe('done')
})

it('uses the latest attempt, keeps every active node, and bounds recent done sessions', async () => {
  const f = await fixture()
  const original = f.add('completed', 'completed')
  const retry = { ...original.run, id: randomUUID(), status: 'completed' as const }
  f.saveRun(retry)
  for (let n = 1; n <= 12; n++) f.add('completed', 'completed', `2026-11-07T00:${String(n).padStart(2, '0')}:00Z`)
  for (let n = 0; n < 10; n++) f.add('running', 'running')
  const sessions = f.execution.listSessions()
  expect(sessions.filter((s) => s.nodeId === original.node.id)).toHaveLength(1)
  expect(sessions.find((s) => s.nodeId === original.node.id)?.state).toBe('attention')
  expect(sessions[0].nodeId).toBe(original.node.id)
  expect(sessions.filter((s) => s.state === 'running')).toHaveLength(10)
  expect(sessions.filter((s) => s.state === 'done')).toHaveLength(8)
  expect(sessions.find((s) => s.state === 'done')?.updatedAt).toBe('2026-11-07T00:12:00Z')
})

it('restores recent sessions from storage and excludes removed nodes and archived tasks', async () => {
  const f = await fixture()
  const kept = f.add('completed', 'completed')
  const removed = f.add('failed', 'failed')
  f.graph.document.nodes = f.graph.document.nodes.filter((node) => node.id !== removed.node.id)
  f.saveGraph()
  const reopened = new NodeExecutionService(f.database, f.graphs, f.catalog, f.root)
  expect(reopened.listSessions().map((s) => s.nodeId)).toEqual([kept.node.id])
  f.database.db.update(tasks).set({ archivedAt: new Date().toISOString() }).where(eq(tasks.id, f.task.id)).run()
  expect(reopened.listSessions()).toEqual([])
})
