import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexOptions,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { NodeExecutionService } from '../src/main/application/node-execution-service'
import { WorkflowService } from '../src/main/application/workflow-service'
import { ManagerTools } from '../src/main/application/manager-tools'
import { ManagerService } from '../src/main/application/manager-service'
import { LocalMcpServer } from '../src/main/mcp/server'
import { makeWorkflowNode, type GraphSnapshot } from '../src/shared/graph'
import type { ChangeEntry, ManagerScope } from '../src/shared/manager'
import { migrations } from '../src/main/db/migrations'
import type { Project } from '../src/shared/workspace'

const roots: string[] = [],
  databases: WorkspaceDatabase[] = [],
  servers: LocalMcpServer[] = [],
  managers: ManagerService[] = [],
  workflows: WorkflowService[] = [],
  clients: Client[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.shutdown()))
  await Promise.all(workflows.splice(0).map((workflow) => workflow.shutdown()))
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-manager-'))
  roots.push(root)
  const database = openWorkspaceDatabase(join(root, 'data', 'workspace.sqlite'))
  databases.push(database)
  const workspace = new WorkspaceService(database, () => [
    {
      id: 'fixture-model',
      name: 'Fixture',
      isDefault: true,
      efforts: ['high'],
    },
  ])
  const project = await workspace.createProject({ path: join(root, 'project') })
  const other = await workspace.createProject({ path: join(root, 'other') })
  workspace.updateProject({
    projectId: project.id,
    expectedRevision: project.revision,
    name: 'Project Alpha',
    description: 'A local CSV tool',
    instructions: 'Prefer small changes.',
    devCommand: 'npm run dev',
    testCommand: 'npm test',
  })
  writeFileSync(join(project.repoPath, 'AGENTS.md'), 'Use clear domain names.')
  writeFileSync(
    join(project.repoPath, 'README.md'),
    'CSV exports for local users.',
  )
  const task = workspace.createTask({
    projectId: project.id,
    title: 'CSV export',
    description: 'Add CSV export.',
  })
  const otherTask = workspace.createTask({
    projectId: other.id,
    title: 'Other project task',
  })
  const catalog = new CatalogService(database, join(root, 'data'), () => [
    {
      id: 'fixture-model',
      name: 'Fixture',
      isDefault: true,
      efforts: ['high'],
    },
  ])
  const graphs = new GraphService(database, catalog, () => [
    {
      id: 'fixture-model',
      name: 'Fixture',
      isDefault: true,
      efforts: ['high'],
    },
  ])
  const execution = new NodeExecutionService(
    database,
    graphs,
    catalog,
    join(root, 'data'),
  )
  await execution.initialize()
  const workflow = new WorkflowService(
    database,
    graphs,
    catalog,
    execution,
    workspace,
  )
  workflows.push(workflow)
  await workflow.initialize()
  const tools = new ManagerTools(
    database,
    workspace,
    graphs,
    catalog,
    workflow,
    () => [
      {
        id: 'fixture-model',
        name: 'Fixture',
        isDefault: true,
        efforts: ['high'],
      },
    ],
  )
  const board: ManagerScope = { projectId: project.id, taskId: null },
    scope: ManagerScope = { projectId: project.id, taskId: task.id }
  const graph = graphs.get({ projectId: project.id, taskId: task.id })
  return {
    root,
    database,
    workspace,
    project,
    other,
    task,
    otherTask,
    catalog,
    graphs,
    execution,
    workflow,
    tools,
    board,
    scope,
    graph,
  }
}
const command = () => randomUUID()

describe('manager metadata commands', () => {
  it('edits only requested project settings, publishes saved state and handles identical retries once', async () => {
    const f = await fixture(),
      listener = vi.fn()
    f.workspace.subscribe(listener)
    const before = f.workspace.getBoard({ projectId: f.project.id }).project
    const input = {
      expectedRevision: before.revision,
      commandId: command(),
      description: 'CSV exports for offline teams.',
      instructions: 'Use strict TypeScript and keep changes small.',
      devCommand: 'npm run preview',
      testCommand: 'npm run test:unit',
      defaultModel: 'fixture-model',
      defaultEffort: 'high',
    }
    const saved = (await f.tools.call(
      f.board,
      'project_update',
      input,
    )) as Project
    expect(saved).toMatchObject({
      name: before.name,
      repoPath: before.repoPath,
      revision: before.revision + 1,
      description: input.description,
      instructions: input.instructions,
      devCommand: input.devCommand,
      testCommand: input.testCommand,
      defaultModel: input.defaultModel,
      defaultEffort: input.defaultEffort,
    })
    expect(listener).toHaveBeenCalled()
    expect(
      listener.mock.lastCall![0].projects.find(
        (project: Project) => project.id === saved.id,
      ),
    ).toEqual(saved)
    expect(await f.tools.call(f.board, 'project_update', input)).toEqual(saved)
    expect(
      f.tools
        .history(f.board)
        .filter(
          (entry) =>
            entry.kind === 'project' && entry.revision === saved.revision,
        ),
    ).toHaveLength(1)
    expect(
      f.workspace.getBoard({ projectId: f.other.id }).project.testCommand,
    ).toBe('')
    expect((await f.tools.context(f.board)).project).toEqual(saved)
    await expect(
      f.tools.call(f.board, 'project_update', {
        ...input,
        testCommand: 'different',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const cleared = (await f.tools.call(f.board, 'project_update', {
      expectedRevision: saved.revision,
      commandId: command(),
      testCommand: '',
    })) as Project
    expect(cleared).toMatchObject({
      testCommand: '',
      instructions: saved.instructions,
      defaultModel: saved.defaultModel,
      defaultEffort: saved.defaultEffort,
    })
  })
  it('rejects stale, invalid and out-of-scope project edits without partial changes', async () => {
    const f = await fixture(),
      before = f.workspace.getBoard({ projectId: f.project.id }).project
    const snapshot = f.workspace.getSnapshot(),
      history = f.tools.history(f.board)
    await expect(
      f.tools.call(f.board, 'project_update', {
        expectedRevision: before.revision - 1,
        commandId: command(),
        instructions: 'Stale edit',
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    await expect(
      f.tools.call(f.board, 'project_update', {
        expectedRevision: before.revision,
        commandId: command(),
        description: 'Must not save',
        defaultModel: 'fixture-model',
        defaultEffort: 'ultra',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_OPTIONS' })
    await expect(
      f.tools.call(f.board, 'project_update', {
        expectedRevision: before.revision,
        commandId: command(),
      }),
    ).rejects.toThrow('Provide at least one')
    await expect(
      f.tools.call(f.board, 'project_update', {
        expectedRevision: before.revision,
        commandId: command(),
        projectId: f.other.id,
        testCommand: 'wrong project',
      }),
    ).rejects.toThrow()
    await expect(
      f.tools.call(f.board, 'project_update', {
        expectedRevision: before.revision,
        commandId: command(),
        repoPath: f.other.repoPath,
      }),
    ).rejects.toThrow()
    await expect(
      f.tools.call(f.scope, 'project_update', {
        expectedRevision: before.revision,
        commandId: command(),
        testCommand: 'task manager edit',
      }),
    ).rejects.toMatchObject({ code: 'MANAGER_SCOPE' })
    expect(f.workspace.getSnapshot()).toEqual(snapshot)
    expect(f.tools.history(f.board)).toEqual(history)
  })
  it('records project settings from UI and MCP and undoes only the matching live revision', async () => {
    const f = await fixture(),
      before = f.workspace.getBoard({ projectId: f.project.id }).project
    const saved = (await f.tools.call(f.board, 'project_update', {
      expectedRevision: before.revision,
      commandId: command(),
      description: 'New brief',
      instructions: 'New guidance',
      devCommand: 'new dev',
      testCommand: 'new tests',
    })) as Project
    const entry = f.tools.history(f.board)[0]
    expect(entry).toMatchObject({
      kind: 'project',
      taskId: null,
      before,
      after: saved,
    })
    expect(
      f.tools.history(f.scope).some((change) => change.id === entry.id),
    ).toBe(false)
    await expect(
      f.tools.undo({ ...f.scope, changeId: entry.id, commandId: command() }),
    ).rejects.toMatchObject({ code: 'MANAGER_SCOPE' })
    const undoInput = { ...f.board, changeId: entry.id, commandId: command() }
    await f.tools.undo(undoInput)
    await f.tools.undo(undoInput)
    const restored = f.workspace.getBoard({ projectId: f.project.id }).project
    expect(restored).toMatchObject({
      name: before.name,
      description: before.description,
      instructions: before.instructions,
      devCommand: before.devCommand,
      testCommand: before.testCommand,
      defaultModel: before.defaultModel,
      defaultEffort: before.defaultEffort,
      repoPath: before.repoPath,
      revision: saved.revision + 1,
    })
    expect(
      f.tools.history(f.board).find((change) => change.id === entry.id)
        ?.undoneAt,
    ).toBeTruthy()
    const restoration = f.tools.history(f.board)[0]
    f.workspace.updateProject({
      projectId: restored.id,
      expectedRevision: restored.revision,
      name: restored.name,
      description: restored.description,
      instructions: 'Later UI instructions',
      devCommand: restored.devCommand,
      testCommand: restored.testCommand,
    })
    expect(f.tools.history(f.board)[0]).toMatchObject({
      kind: 'project',
      before: restored,
      after: { instructions: 'Later UI instructions' },
    })
    await expect(
      f.tools.undo({
        ...f.board,
        changeId: restoration.id,
        commandId: command(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_UNDO' })
    expect(
      f.workspace.getBoard({ projectId: restored.id }).project.instructions,
    ).toBe('Later UI instructions')
  })
  it('preserves version 7 task history while migrating to project-level history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'constella-history-upgrade-'))
    roots.push(root)
    const file = join(root, 'old.sqlite'),
      original = new Database(file)
    original.exec(
      'CREATE TABLE app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    for (const migration of migrations.slice(0, 7)) {
      original.exec(migration.sql)
      original
        .prepare('INSERT INTO app_schema_migrations VALUES (?, ?, ?, ?)')
        .run(
          migration.version,
          migration.name,
          createHash('sha256').update(migration.sql).digest('hex'),
          'before',
        )
    }
    const projectId = command(),
      taskId = command(),
      changeId = command()
    original
      .prepare(
        'INSERT INTO projects (id, repo_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(projectId, root, 'Existing project', 'before', 'before')
    original
      .prepare(
        'INSERT INTO tasks (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, projectId, 'Existing task', 0, 'before', 'before')
    const entry: ChangeEntry = {
      id: changeId,
      projectId,
      taskId,
      kind: 'task',
      action: 'Create task',
      before: null,
      after: {
        id: taskId,
        projectId,
        title: 'Existing task',
        description: '',
        acceptanceCriteria: '',
        status: 'todo',
        position: 0,
        revision: 1,
        archivedAt: null,
        createdAt: 'before',
        updatedAt: 'before',
      },
      revision: 1,
      createdAt: 'before',
      undoneAt: null,
    }
    original
      .prepare(
        'INSERT INTO change_history (id, project_id, task_id, document) VALUES (?, ?, ?, ?)',
      )
      .run(changeId, projectId, taskId, JSON.stringify(entry))
    original.close()
    const upgraded = openWorkspaceDatabase(file)
    databases.push(upgraded)
    expect(
      JSON.parse(
        (
          upgraded.sqlite
            .prepare('SELECT document FROM change_history WHERE id = ?')
            .get(changeId) as { document: string }
        ).document,
      ),
    ).toEqual(entry)
    new WorkspaceService(upgraded).updateProject({
      projectId,
      expectedRevision: 1,
      name: 'Existing project',
      description: 'Updated after migration',
      instructions: '',
      devCommand: '',
      testCommand: '',
    })
    const projectChange = upgraded.sqlite
      .prepare(
        'SELECT task_id, document FROM change_history WHERE task_id IS NULL',
      )
      .get() as { task_id: null; document: string }
    expect(JSON.parse(projectChange.document)).toMatchObject({
      kind: 'project',
      projectId,
      taskId: null,
    })
    expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([])
  })
  it('includes project instructions, repository guidance, selections, live revisions and scoped catalogs', async () => {
    const f = await fixture()
    const node = f.graph.document.nodes.find((node) => node.type === 'agent')!
    const packet = await f.tools.context(f.scope, node.id)
    expect(packet.project).toMatchObject({
      name: 'Project Alpha',
      description: 'A local CSV tool',
      instructions: 'Prefer small changes.',
      testCommand: 'npm test',
    })
    expect(packet.guidance.map((item) => item.text).join('\n')).toContain(
      'Use clear domain names.',
    )
    expect(packet.guidance.map((item) => item.text).join('\n')).toContain(
      'CSV exports for local users.',
    )
    expect(packet.graph?.revision).toBe(f.graph.revision)
    expect(packet.selectedNodeId).toBe(node.id)
    expect(packet.tasks.map((task) => task.id)).toEqual([f.task.id])
    await expect(f.tools.context(f.scope, randomUUID())).rejects.toMatchObject({
      code: 'MANAGER_SELECTION',
    })
    await expect(
      f.tools.call(f.scope, 'graph_get', { taskId: f.otherTask.id }),
    ).rejects.toMatchObject({ code: 'MANAGER_SCOPE' })
    await expect(
      f.tools.call(f.board, 'todo_update', {
        taskId: f.otherTask.id,
        expectedRevision: 1,
        title: 'Escaped',
        commandId: command(),
      }),
    ).rejects.toMatchObject({ code: 'MANAGER_SCOPE' })
  })
  it('creates a task and graph once, rejects conflicting retries, and rolls back invalid multi-entity creation', async () => {
    const f = await fixture(),
      input = {
        title: 'Export settings',
        description: 'Let users choose a delimiter.',
        commandId: command(),
      }
    const listener = vi.fn()
    f.workspace.subscribe(listener)
    const first = await f.tools.call(f.board, 'todo_create', input)
    expect(await f.tools.call(f.board, 'todo_create', input)).toEqual(first)
    expect(
      f.workspace
        .getBoard({ projectId: f.project.id })
        .tasks.filter((task) => task.title === input.title),
    ).toHaveLength(1)
    expect(listener).toHaveBeenCalled()
    await expect(
      f.tools.call(f.board, 'todo_create', {
        ...input,
        title: 'A different request',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const before = f.workspace.getSnapshot(),
      history = f.tools.history(f.board)
    const invalid = structuredClone(f.graph.document)
    invalid.edges.push({
      id: command(),
      source: invalid.nodes[2].id,
      target: invalid.nodes[1].id,
    })
    await expect(
      f.tools.call(f.board, 'todo_create', {
        ...input,
        commandId: command(),
        graph: invalid,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_INVALID' })
    expect(f.workspace.getSnapshot()).toEqual(before)
    expect(f.tools.history(f.board)).toEqual(history)
  })
  it('edits nodes and assignments atomically, rejects stale/invalid edits and reverses a graph change through the same service', async () => {
    const f = await fixture()
    const profile = await f.catalog.createProfile({
      projectId: f.project.id,
      name: 'Builder',
      roleInstructions: 'Build UI',
      styleGuide: '',
      skillIds: [],
      model: null,
      effort: null,
    })
    const skill = await f.catalog.createSkill({
      projectId: f.project.id,
      name: 'csv-style',
      description: 'CSV conventions',
      instructions: 'Use UTF-8.',
    })
    const node = structuredClone(
      f.graph.document.nodes.find((node) => node.type === 'agent')!,
    )
    if (node.type !== 'agent') throw new Error('Expected agent')
    node.data = {
      ...node.data,
      prompt: 'Build CSV export with settings.',
      profileId: profile.id,
      skillIds: [skill.id],
      model: 'fixture-model',
      effort: 'high',
      acceptance: 'auto',
    }
    const added = makeWorkflowNode('agent', command(), { x: 400, y: 350 })
    const input = {
      taskId: f.task.id,
      expectedRevision: f.graph.revision,
      commandId: command(),
      changes: [
        { op: 'update_node', node },
        { op: 'add_node', node: added },
      ],
    }
    const listener = vi.fn()
    f.graphs.subscribe(listener)
    const saved = (await f.tools.call(
      f.scope,
      'graph_apply_changes',
      input,
    )) as GraphSnapshot
    expect(saved.document.nodes).toContainEqual(node)
    expect(saved.document.nodes).toContainEqual(added)
    expect(listener).toHaveBeenCalled()
    expect(await f.tools.call(f.scope, 'graph_apply_changes', input)).toEqual(
      saved,
    )
    await expect(
      f.tools.call(f.scope, 'graph_apply_changes', {
        ...input,
        commandId: command(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_GRAPH' })
    const bad = structuredClone(node)
    bad.data.profileId = randomUUID()
    await expect(
      f.tools.call(f.scope, 'graph_apply_changes', {
        taskId: f.task.id,
        expectedRevision: saved.revision,
        commandId: command(),
        changes: [
          { op: 'remove_node', nodeId: added.id },
          { op: 'update_node', node: bad },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_INVALID' })
    expect(
      f.graphs.get({ projectId: f.project.id, taskId: f.task.id }).document,
    ).toEqual(saved.document)
    const entry = f.tools.history(f.scope)[0],
      undoInput = { ...f.scope, changeId: entry.id, commandId: command() }
    await f.tools.undo(undoInput)
    expect(
      f.graphs.get({ projectId: f.project.id, taskId: f.task.id }).document,
    ).toEqual(f.graph.document)
    await expect(f.tools.undo(undoInput)).resolves.toBeUndefined()
    expect(
      f.tools.history(f.scope).find((change) => change.id === entry.id)
        ?.undoneAt,
    ).toBeTruthy()
  })
  it('removes incident edges with a node and rejects a stale Undo after a later UI edit', async () => {
    const f = await fixture(),
      removed = f.graph.document.nodes[1]
    const saved = (await f.tools.call(f.scope, 'graph_apply_changes', {
      taskId: f.task.id,
      expectedRevision: f.graph.revision,
      commandId: command(),
      changes: [{ op: 'remove_node', nodeId: removed.id }],
    })) as GraphSnapshot
    expect(saved.document.nodes.some((node) => node.id === removed.id)).toBe(
      false,
    )
    expect(
      saved.document.edges.some(
        (edge) => edge.source === removed.id || edge.target === removed.id,
      ),
    ).toBe(false)
    const entry = f.tools.history(f.scope)[0]
    f.graphs.save({
      projectId: f.project.id,
      taskId: f.task.id,
      expectedRevision: saved.revision,
      commandId: command(),
      document: { ...saved.document, viewport: { x: 40, y: 20, zoom: 1 } },
    })
    await expect(
      f.tools.undo({ ...f.scope, changeId: entry.id, commandId: command() }),
    ).rejects.toMatchObject({ code: 'STALE_GRAPH' })
    expect(
      f.graphs.get({ projectId: f.project.id, taskId: f.task.id }).document
        .viewport.x,
    ).toBe(40)
  })
  it('uses task revisions for updates/archive, stops execution once for duplicate archive calls and supports Undo', async () => {
    const f = await fixture(),
      stop = vi.spyOn(f.workflow, 'archive')
    await f.tools.call(f.scope, 'todo_update', {
      taskId: f.task.id,
      expectedRevision: 1,
      commandId: command(),
      title: 'Export CSV',
    })
    await expect(
      f.tools.call(f.scope, 'todo_archive', {
        taskId: f.task.id,
        expectedRevision: 1,
        commandId: command(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    expect(stop).not.toHaveBeenCalled()
    const input = {
      taskId: f.task.id,
      expectedRevision: 2,
      commandId: command(),
    }
    await f.tools.call(f.scope, 'todo_archive', input)
    await f.tools.call(f.scope, 'todo_archive', input)
    expect(stop).toHaveBeenCalledOnce()
    const entry = f.tools.history(f.scope)[0]
    await f.tools.undo({ ...f.scope, changeId: entry.id, commandId: command() })
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0],
    ).toMatchObject({ title: 'Export CSV', archivedAt: null })
    expect(
      f.workflow.get({ projectId: f.project.id, taskId: f.task.id }).phase,
    ).not.toBe('running')
    const restoration = f.tools.history(f.scope)[0]
    stop.mockClear()
    await f.tools.undo({
      ...f.scope,
      changeId: restoration.id,
      commandId: command(),
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).tasks[0].archivedAt,
    ).toBeTruthy()
  })
  it('persists UI change history and refuses to undo an edit superseded by another task update', async () => {
    const f = await fixture()
    const updated = f.workspace.updateTask({
      projectId: f.project.id,
      taskId: f.task.id,
      expectedRevision: 1,
      title: 'From UI',
      description: '',
      acceptanceCriteria: '',
    })
    const entry = f.tools.history(f.scope)[0]
    f.workspace.updateTask({
      projectId: f.project.id,
      taskId: f.task.id,
      expectedRevision: updated.revision,
      title: 'Newer edit',
      description: '',
      acceptanceCriteria: '',
    })
    await expect(
      f.tools.undo({ ...f.scope, changeId: entry.id, commandId: command() }),
    ).rejects.toMatchObject({ code: 'STALE_UNDO' })
    const reopened = openWorkspaceDatabase(
      join(f.root, 'data', 'workspace.sqlite'),
    )
    expect(
      reopened.sqlite.prepare('SELECT count(*) AS n FROM change_history').get(),
    ).toEqual(
      f.database.sqlite
        .prepare('SELECT count(*) AS n FROM change_history')
        .get(),
    )
    reopened.close()
  })
})

describe('local MCP transport and manager sessions', () => {
  it('persists client initialization errors and releases the manager slot for a retry', async () => {
    const f = await fixture(),
      server = new LocalMcpServer(f.tools)
    servers.push(server)
    await server.start()
    const manager = new ManagerService(f.database, f.tools, server, () => {
      throw new Error('Runtime unavailable')
    })
    managers.push(manager)
    await expect(
      manager.send({ ...f.board, message: 'Create a task.' }),
    ).rejects.toThrow('Runtime unavailable')
    expect(manager.get(f.board).turns[0]).toMatchObject({
      status: 'failed',
      error: { message: 'Runtime unavailable' },
    })
    await expect(
      manager.send({ ...f.board, message: 'Try again.' }),
    ).rejects.toThrow('Runtime unavailable')
    expect(manager.get(f.board).turns).toHaveLength(2)
  })
  async function connect(
    server: LocalMcpServer,
    scope: ManagerScope,
    role: 'manager' | 'worker' = 'manager',
  ) {
    const grant = server.issue(scope, role)
    const servers = grant.options.config!.mcp_servers as {
      agent_constella: { url: string }
    }
    const token = grant.options.env!.CONSTELLA_MCP_TOKEN
    const client = new Client({ name: 'manager-test', version: '1' })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(servers.agent_constella.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    return { client, grant, url: servers.agent_constella.url, token }
  }
  it('authenticates real MCP requests, isolates projects, hides mutating tools from workers and revokes completed sessions', async () => {
    const f = await fixture(),
      server = new LocalMcpServer(f.tools)
    servers.push(server)
    await server.start()
    const { client, grant, url, token } = await connect(server, f.board)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain(
      'graph_apply_changes',
    )
    expect(tools.tools.map((tool) => tool.name)).toContain('project_update')
    expect(tools.tools.map((tool) => tool.name)).not.toContain('workflow_start')
    const result = await client.callTool({
      name: 'todo_create',
      arguments: { title: 'Made over MCP', commandId: command() },
    })
    expect(result.isError).not.toBe(true)
    expect(
      f.workspace
        .getBoard({ projectId: f.project.id })
        .tasks.some((task) => task.title === 'Made over MCP'),
    ).toBe(true)
    const project = f.workspace.getBoard({ projectId: f.project.id }).project
    expect(
      (
        await client.callTool({
          name: 'project_update',
          arguments: {
            expectedRevision: project.revision,
            commandId: command(),
            description: 'Saved through MCP',
            instructions: 'Keep commands documented.',
            devCommand: 'npm run preview',
            testCommand: 'npm run check',
          },
        })
      ).isError,
    ).not.toBe(true)
    expect(
      f.workspace.getBoard({ projectId: f.project.id }).project,
    ).toMatchObject({
      description: 'Saved through MCP',
      instructions: 'Keep commands documented.',
      devCommand: 'npm run preview',
      testCommand: 'npm run check',
    })
    expect(
      (
        await client.callTool({
          name: 'graph_get',
          arguments: { taskId: f.otherTask.id },
        })
      ).isError,
    ).toBe(true)
    const worker = await connect(server, f.scope, 'worker')
    expect(
      (await worker.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(['workspace_get_context', 'graph_get']))
    expect(
      (await worker.client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain('project_update')
    const taskManager = await connect(server, f.scope)
    expect(
      (await taskManager.client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain('project_update')
    expect(
      (
        await taskManager.client.callTool({
          name: 'project_update',
          arguments: {
            expectedRevision: project.revision + 1,
            commandId: command(),
            testCommand: 'forbidden',
          },
        })
      ).isError,
    ).toBe(true)
    expect(
      (
        await worker.client.callTool({
          name: 'todo_create',
          arguments: { title: 'Forbidden', commandId: command() },
        })
      ).isError,
    ).toBe(true)
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            Origin: 'http://untrusted.example',
            Authorization: `Bearer ${token}`,
          },
        })
      ).status,
    ).toBe(403)
    grant.release()
    await expect(client.listTools()).rejects.toThrow()
  })
  it('stores independent board/task conversations, resumes their threads with fresh context and reconciles interrupted turns', async () => {
    const f = await fixture(),
      server = new LocalMcpServer(f.tools)
    servers.push(server)
    await server.start()
    const calls: {
      prompt: string
      threadId?: string
      options: ThreadOptions
      config: CodexOptions
    }[] = []
    const manager = new ManagerService(
      f.database,
      f.tools,
      server,
      (config) => {
        const thread = (options: ThreadOptions, threadId?: string) => ({
          async runStreamed(prompt: string) {
            calls.push({ prompt, threadId, options, config })
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield {
                  type: 'thread.started',
                  thread_id: threadId ?? `thread-${calls.length}`,
                }
                yield {
                  type: 'item.completed',
                  item: {
                    id: 'reply',
                    type: 'agent_message',
                    text: 'Saved the requested changes.',
                  },
                }
                yield {
                  type: 'turn.completed',
                  usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    reasoning_output_tokens: 0,
                  },
                }
              })(),
            }
          },
        })
        return {
          startThread: (options) => thread(options),
          resumeThread: (id, options) => thread(options, id),
        }
      },
    )
    managers.push(manager)
    manager.initialize()
    const currentProject = f.workspace.getBoard({
      projectId: f.project.id,
    }).project
    f.workspace.updateProject({
      projectId: currentProject.id,
      expectedRevision: currentProject.revision,
      name: currentProject.name,
      description: currentProject.description,
      instructions: currentProject.instructions,
      devCommand: currentProject.devCommand,
      testCommand: currentProject.testCommand,
      defaultModel: 'fixture-model',
      defaultEffort: 'high',
    })
    await manager.send({ ...f.board, message: 'Create a task.' })
    await manager.stop(f.board)
    await manager.send({
      ...f.scope,
      message: 'Update the prompt.',
      selectedNodeId: f.graph.document.nodes[1].id,
    })
    await manager.stop(f.scope)
    await manager.send({
      ...f.board,
      message: 'Archive it.',
      model: null,
      effort: null,
    })
    await manager.stop(f.board)
    expect(calls[2].threadId).toBe('thread-1')
    expect(calls[0].options.sandboxMode).toBe('read-only')
    expect(calls[0].options).toMatchObject({
      model: 'fixture-model',
      modelReasoningEffort: 'high',
    })
    expect(calls[1].options).toMatchObject({
      model: 'fixture-model',
      modelReasoningEffort: 'high',
    })
    expect(calls[2].options).toMatchObject({
      model: undefined,
      modelReasoningEffort: undefined,
    })
    expect(calls[1].prompt).toContain('A local CSV tool')
    expect(calls[1].prompt).toContain('Use clear domain names.')
    expect(calls[1].config.config?.developer_instructions).toContain(
      'AgentConstella project manager',
    )
    expect(manager.get(f.board).turns).toHaveLength(2)
    expect(manager.get(f.scope).turns).toHaveLength(1)
    const saved = manager.get(f.scope)
    saved.turns[0].status = 'running'
    f.database.sqlite
      .prepare('UPDATE manager_chats SET document = ? WHERE id = ?')
      .run(JSON.stringify(saved), saved.id)
    manager.initialize()
    expect(manager.get(f.scope).turns[0].status).toBe('interrupted')
  })
})
