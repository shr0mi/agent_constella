import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { WorkspaceService } from '../src/main/application/workspace-service'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { migrations } from '../src/main/db/migrations'
import {
  graphDocumentSchema,
  makeWorkflowNode,
  type GraphDocument,
  type GraphSnapshot,
  type WorkflowNode,
} from '../src/shared/graph'
import {
  resolveNodeModel,
  validateGraph,
  validateTopology,
} from '../src/shared/graph-validation'
import type { ModelOption } from '../src/shared/contracts'

const roots: string[] = [],
  databases: WorkspaceDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { force: true, recursive: true }))
})
const models: ModelOption[] = [
  {
    id: 'fixture-model',
    name: 'Fixture model',
    isDefault: true,
    efforts: ['low', 'high'],
  },
]
const profileInput = (projectId: string | null, skillIds: string[] = []) => ({
  projectId,
  name: 'Builder',
  roleInstructions: 'Implement the requested work.',
  styleGuide: 'Use clear names.',
  skillIds,
  model: null,
  effort: null,
})
const identity = (snapshot: GraphSnapshot) => ({
  projectId: snapshot.project.id,
  taskId: snapshot.task.id,
})
const saveInput = (snapshot: GraphSnapshot, document = snapshot.document) => ({
  ...identity(snapshot),
  expectedRevision: snapshot.revision,
  commandId: randomUUID(),
  document,
})
const agent = (document: GraphDocument) =>
  document.nodes.find(
    (node): node is Extract<WorkflowNode, { type: 'agent' }> =>
      node.type === 'agent',
  )!
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-graphs-'))
  roots.push(root)
  const appData = join(root, 'data'),
    file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database)
  const a = await workspace.createProject({ path: join(root, 'alpha') })
  const b = await workspace.createProject({ path: join(root, 'beta') })
  const task = workspace.createTask({
    projectId: a.id,
    title: 'Build a useful feature',
    description: 'Implement this feature carefully.',
    acceptanceCriteria: 'The behavior matches the brief.',
  })
  const catalog = new CatalogService(database, appData)
  const profile = await catalog.createProfile(profileInput(null))
  let currentModels = models
  const graphs = new GraphService(database, catalog, () => currentModels)
  const snapshot = graphs.get({ projectId: a.id, taskId: task.id })
  function configured() {
    const document = structuredClone(snapshot.document)
    agent(document).data.profileId = profile.id
    return document
  }
  return {
    root,
    file,
    appData,
    database,
    workspace,
    catalog,
    graphs,
    a,
    b,
    task,
    profile,
    snapshot,
    configured,
    setModels: (next: ModelOption[]) => {
      currentModels = next
    },
  }
}

describe('persistent task graph application service', () => {
  it('creates one graph per task, stores settings, edges and positions, and reopens the same revision', async () => {
    const f = await fixture()
    expect(f.snapshot.document.nodes.map((node) => node.type)).toEqual([
      'start',
      'agent',
      'review',
      'end',
    ])
    expect(agent(f.snapshot.document).data).toMatchObject({
      title: f.task.title,
      prompt: f.task.description,
      acceptanceCriteria: f.task.acceptanceCriteria,
    })
    expect(f.graphs.get(identity(f.snapshot))).toEqual(f.snapshot)
    const document = f.configured()
    const node = agent(document)
    node.position = { x: 333, y: 444 }
    node.data = {
      ...node.data,
      model: models[0].id,
      effort: 'high',
      acceptance: 'auto',
    }
    document.viewport = { x: 34, y: -40, zoom: 0.75 }
    const saved = f.graphs.save(saveInput(f.snapshot, document))
    expect(saved.validation.valid).toBe(true)
    const otherTask = f.workspace.createTask({
      projectId: f.b.id,
      title: 'Independent task',
    })
    const other = f.graphs.get({ projectId: f.b.id, taskId: otherTask.id })
    expect(other.document.nodes[0].id).not.toBe(document.nodes[0].id)
    expect(other.revision).toBe(1)
    f.database.close()
    const reopened = openWorkspaceDatabase(f.file)
    databases.push(reopened)
    const restored = new GraphService(
      reopened,
      new CatalogService(reopened, f.appData),
      () => models,
    )
    expect(restored.get(identity(saved))).toMatchObject({
      revision: 2,
      document,
      validation: { valid: true },
    })
    expect(
      reopened.sqlite
        .prepare('SELECT COUNT(*) AS n FROM graph_revisions WHERE task_id = ?')
        .get(f.task.id),
    ).toEqual({ n: 2 })
  })
  it('rejects cyclic and dangling edges atomically without advancing the saved revision', async () => {
    const f = await fixture(),
      document = f.configured()
    document.edges.push({
      id: randomUUID(),
      source: document.nodes[2].id,
      target: document.nodes[1].id,
    })
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /cycle/,
    )
    document.edges.at(-1)!.target = randomUUID()
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /missing node/,
    )
    expect(f.graphs.get(identity(f.snapshot)).revision).toBe(1)
    expect(
      f.database.sqlite
        .prepare('SELECT COUNT(*) AS n FROM graph_commands')
        .get(),
    ).toEqual({ n: 0 })
    // Even an invalid graph introduced outside the service cannot pass admission.
    document.edges.at(-1)!.target = document.nodes[1].id
    f.database.sqlite
      .prepare('UPDATE task_graphs SET document = ? WHERE task_id = ?')
      .run(JSON.stringify(document), f.task.id)
    await expect(
      f.graphs.prepareStart({ ...identity(f.snapshot), expectedRevision: 1 }),
    ).rejects.toThrow(/cycle/)
  })
  it('saves incomplete drafts but requires exactly one Start/End and a path through every node before admission', async () => {
    const f = await fixture()
    let draft = f.configured()
    draft.edges = draft.edges.slice(1)
    let saved = f.graphs.save(saveInput(f.snapshot, draft))
    expect(saved.validation.canSave).toBe(true)
    expect(
      saved.validation.issues.some(
        (issue) => issue.code === 'DISCONNECTED_NODE',
      ),
    ).toBe(true)
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/path from Start to End/)
    draft = {
      ...draft,
      nodes: draft.nodes.filter((node) => node.type !== 'start'),
    }
    saved = f.graphs.save(saveInput(saved, draft))
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/exactly one Start/)
    expect(() =>
      f.graphs.save(
        saveInput(saved, {
          ...draft,
          nodes: [
            ...draft.nodes,
            makeWorkflowNode('end', randomUUID(), { x: 0, y: 0 }),
          ],
        }),
      ),
    ).toThrow(/exactly one End/)
  })
  it('checks global/local assignments against the actual task project and rechecks removed profiles and skills', async () => {
    const f = await fixture()
    const foreign = await f.catalog.createProfile(profileInput(f.b.id))
    const document = f.configured()
    agent(document).data.profileId = foreign.id
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /another project/,
    )
    agent(document).data.profileId = f.profile.id
    const skill = await f.catalog.createSkill({
      projectId: f.a.id,
      name: 'project-style',
      description: 'Project conventions',
      instructions: 'Read the repository before implementing.',
    })
    const foreignSkill = await f.catalog.createSkill({
      projectId: f.b.id,
      name: 'other-style',
      description: 'Other project',
      instructions: 'Other project instructions.',
    })
    agent(document).data.skillIds = [foreignSkill.id]
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /another project/,
    )
    agent(document).data.skillIds = [skill.id]
    const saved = f.graphs.save(saveInput(f.snapshot, document))
    await f.graphs.prepareStart({
      ...identity(saved),
      expectedRevision: saved.revision,
    })
    await f.catalog.setSkillActive({
      projectId: f.a.id,
      id: skill.id,
      expectedRevision: skill.revision,
      active: false,
    })
    expect(f.graphs.get(identity(saved)).prepared).toBeNull()
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/skill is removed/)
    agent(document).data.skillIds = []
    const next = f.graphs.save(saveInput(saved, document))
    await f.catalog.setProfileActive({
      projectId: null,
      id: f.profile.id,
      expectedRevision: f.profile.revision,
      active: false,
    })
    await expect(
      f.graphs.prepareStart({
        ...identity(next),
        expectedRevision: next.revision,
      }),
    ).rejects.toThrow(/profile is removed/)
  })
  it('uses inherited model settings and rejects unsupported effort/model pairs', async () => {
    const f = await fixture(),
      document = f.configured()
    const profile = await f.catalog.updateProfile({
      ...profileInput(null),
      id: f.profile.id,
      expectedRevision: f.profile.revision,
      model: models[0].id,
      effort: 'high',
    })
    expect(resolveNodeModel(agent(document), profile)).toEqual({
      model: models[0].id,
      effort: 'high',
    })
    agent(document).data.effort = 'minimal'
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /not supported/,
    )
    agent(document).data.effort = null
    expect(resolveNodeModel(agent(document), profile)).toEqual({
      model: models[0].id,
      effort: undefined,
    })
    agent(document).data.model = null
    expect(resolveNodeModel(agent(document), profile)).toEqual({
      model: undefined,
      effort: undefined,
    })
    agent(document).data.effort = 'high'
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /explicit model/,
    )
    agent(document).data.model = 'missing-model'
    expect(() => f.graphs.save(saveInput(f.snapshot, document))).toThrow(
      /not supported/,
    )
    agent(document).data.model = models[0].id
    const saved = f.graphs.save(saveInput(f.snapshot, document))
    f.setModels([])
    expect(f.graphs.get(identity(saved)).validation.canSave).toBe(true)
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/Refresh runtime model/)
  })
  it('rejects stale changes, deduplicates exact retries, and rejects reused command IDs with different edits', async () => {
    const f = await fixture(),
      input = saveInput(f.snapshot, f.configured())
    const saved = f.graphs.save(input)
    const retry = f.graphs.save(input)
    expect(retry.revision).toBe(saved.revision)
    expect(retry.appliedRevision).toBe(2)
    expect(() => f.graphs.save({ ...input, expectedRevision: 2 })).toThrow(
      /already used/,
    )
    expect(() => f.graphs.save(saveInput(f.snapshot, f.configured()))).toThrow(
      /changed after it was opened/,
    )
    const newer = f.graphs.save(saveInput(saved))
    expect(f.graphs.save(input)).toMatchObject({
      revision: newer.revision,
      appliedRevision: 2,
    })
    expect(
      f.database.sqlite
        .prepare('SELECT COUNT(*) AS n FROM graph_commands')
        .get(),
    ).toEqual({ n: 2 })
  })
  it('checks skill files, records readiness for the saved revision, and invalidates it after project or graph changes', async () => {
    const f = await fixture()
    const skill = await f.catalog.createSkill({
      projectId: null,
      name: 'shared-style',
      description: 'Common style',
      instructions: 'Follow the style guide.',
    })
    const document = f.configured()
    agent(document).data.skillIds = [skill.id]
    const saved = f.graphs.save(saveInput(f.snapshot, document))
    const prepared = await f.graphs.prepareStart({
      ...identity(saved),
      expectedRevision: saved.revision,
    })
    expect(prepared.executionAvailable).toBe(false)
    expect(prepared.nodeOrder).toEqual(document.nodes.map((node) => node.id))
    expect(f.graphs.get(identity(saved)).prepared?.revision).toBe(2)
    expect(f.workspace.getBoard({ projectId: f.a.id }).tasks[0].status).toBe(
      'todo',
    )
    f.workspace.updateProject({
      projectId: f.a.id,
      expectedRevision: f.a.revision,
      name: 'Updated project brief',
      description: 'New context',
      instructions: '',
      devCommand: '',
      testCommand: '',
    })
    expect(f.graphs.get(identity(saved)).prepared).toBeNull()
    await f.graphs.prepareStart({
      ...identity(saved),
      expectedRevision: saved.revision,
    })
    rmSync(join(skill.folderPath, 'SKILL.md'))
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow()
    expect(f.graphs.get(identity(saved)).prepared).toBeNull()
    const newer = f.graphs.save(saveInput(saved))
    expect(newer.prepared).toBeNull()
    await expect(
      f.graphs.prepareStart({
        ...identity(newer),
        expectedRevision: newer.revision,
      }),
    ).rejects.toThrow()
    expect(f.graphs.get(identity(newer)).prepared).toBeNull()
  })
  it('refuses cross-project and archived graph writes or preparation', async () => {
    const f = await fixture()
    expect(() =>
      f.graphs.get({ projectId: f.b.id, taskId: f.task.id }),
    ).toThrow(/does not belong/)
    const saved = f.graphs.save(saveInput(f.snapshot, f.configured()))
    expect(() =>
      f.graphs.save({ ...saveInput(saved), projectId: f.b.id }),
    ).toThrow(/does not belong/)
    f.workspace.archiveTask({
      projectId: f.a.id,
      taskId: f.task.id,
      expectedRevision: f.task.revision,
    })
    expect(() => f.graphs.save(saveInput(saved))).toThrow(/read-only/)
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/Restore this task/)
    expect(f.graphs.get(identity(saved)).document).toEqual(saved.document)
  })
  it('rechecks assignments after asynchronous file verification before recording readiness', async () => {
    const f = await fixture(),
      saved = f.graphs.save(saveInput(f.snapshot, f.configured()))
    f.catalog.verifySelectionFiles = async () => {
      f.graphs.save(saveInput(saved))
    }
    await expect(
      f.graphs.prepareStart({
        ...identity(saved),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow(/changed during the readiness check/)
    expect(f.graphs.get(identity(saved)).prepared).toBeNull()
  })
  it('upgrades a version 2 database without losing projects, tasks or profiles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'constella-graph-migration-'))
    roots.push(root)
    const file = join(root, 'workspace.sqlite'),
      original = new Database(file)
    original.exec(
      'CREATE TABLE app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    for (const migration of migrations.slice(0, 2)) {
      original.exec(migration.sql)
      original
        .prepare('INSERT INTO app_schema_migrations VALUES (?, ?, ?, ?)')
        .run(
          migration.version,
          migration.name,
          createHash('sha256').update(migration.sql).digest('hex'),
          '2026-10-25',
        )
    }
    const projectId = randomUUID(),
      taskId = randomUUID(),
      profileId = randomUUID()
    original
      .prepare(
        'INSERT INTO projects (id, repo_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(projectId, '/tmp/fixture', 'Existing', 'before', 'before')
    original
      .prepare(
        'INSERT INTO tasks (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, projectId, 'Existing task', 0, 'before', 'before')
    original
      .prepare(
        'INSERT INTO agent_profiles (id, name, skill_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(profileId, 'Existing profile', '[]', 'before', 'before')
    original.close()
    const database = openWorkspaceDatabase(file)
    databases.push(database)
    const catalog = new CatalogService(database, root),
      graphs = new GraphService(database, catalog)
    expect(graphs.get({ projectId, taskId }).task.title).toBe('Existing task')
    expect(catalog.getSnapshot({ projectId }).profiles[0].id).toBe(profileId)
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS n FROM app_schema_migrations')
        .get(),
    ).toEqual({ n: 3 })
  })
})

describe('graph schema and topology rules', () => {
  it('rejects self loops, duplicate connections, reversed boundary edges, and duplicate node IDs', async () => {
    const f = await fixture(),
      document = f.configured()
    const edge = document.edges[0]
    for (const candidate of [
      {
        ...document,
        edges: [
          ...document.edges,
          { id: randomUUID(), source: edge.target, target: edge.target },
        ],
      },
      {
        ...document,
        edges: [...document.edges, { ...edge, id: randomUUID() }],
      },
      {
        ...document,
        edges: [
          ...document.edges,
          {
            id: randomUUID(),
            source: document.nodes[3].id,
            target: document.nodes[0].id,
          },
        ],
      },
      { ...document, nodes: [...document.nodes, document.nodes[1]] },
    ])
      expect(validateTopology(candidate).canSave).toBe(false)
  })
  it('allows a branching DAG with a join, requires prompt/profile settings, and forbids autoaccept fields on a review node', async () => {
    const f = await fixture(),
      document = f.configured(),
      parallel = makeWorkflowNode('agent', randomUUID(), { x: 300, y: 350 })
    if (parallel.type !== 'agent') throw new Error('Expected agent')
    parallel.data.profileId = f.profile.id
    parallel.data.prompt = 'Independent branch'
    document.nodes.push(parallel)
    document.edges.push(
      { id: randomUUID(), source: document.nodes[0].id, target: parallel.id },
      { id: randomUUID(), source: parallel.id, target: document.nodes[2].id },
    )
    const validation = validateGraph(document, {
      catalog: f.catalog.getSnapshot({ projectId: f.a.id }),
      models,
    })
    expect(validation.valid).toBe(true)
    expect(
      validation.topologicalOrder.indexOf(document.nodes[2].id),
    ).toBeGreaterThan(validation.topologicalOrder.indexOf(parallel.id))
    parallel.data.profileId = null
    parallel.data.prompt = ''
    expect(
      validateGraph(document, {
        catalog: f.catalog.getSnapshot({ projectId: f.a.id }),
        models,
      }).issues.map((issue) => issue.code),
    ).toEqual(expect.arrayContaining(['PROFILE_REQUIRED', 'AGENT_PROMPT']))
    const invalid = structuredClone(document)
    Object.assign(invalid.nodes[2].data, { acceptance: 'auto' })
    expect(graphDocumentSchema.safeParse(invalid).success).toBe(false)
    invalid.nodes[0].position.x = Infinity
    expect(graphDocumentSchema.safeParse(invalid).success).toBe(false)
  })
})
