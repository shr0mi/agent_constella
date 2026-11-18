import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEvent, ThreadOptions } from '../src/main/terminal/types'
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

const roots: string[] = [],
  databases: WorkspaceDatabase[] = [],
  managers: ManagerService[] = [],
  workflows: WorkflowService[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(workflows.splice(0).map((workflow) => workflow.shutdown()))
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => removeTemp(root))
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-delete-'))
  roots.push(root)
  const appData = join(root, 'data'),
    file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database)
  const a = await workspace.createProject({ path: join(root, 'alpha') })
  const b = await workspace.createProject({ path: join(root, 'beta') })
  writeFileSync(join(a.repoPath, 'keep.txt'), 'Keep the repository files')
  execFileSync('git', ['-C', a.repoPath, 'add', '.'])
  execFileSync(
    'git',
    [
      '-C',
      a.repoPath,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Save fixture files',
    ],
    { stdio: 'pipe' },
  )
  const task = workspace.createTask({
    projectId: a.id,
    title: 'First task',
    description: 'Build the feature.',
  })
  const otherTask = workspace.createTask({
    projectId: b.id,
    title: 'Other task',
    description: 'Keep this project.',
  })
  const catalog = new CatalogService(database, appData),
    graphs = new GraphService(database, catalog)
  const thread = (options: ThreadOptions) => ({
    async runStreamed() {
      return {
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          writeFileSync(
            join(options.workingDirectory!, 'unintegrated.txt'),
            'Keep unintegrated task code',
          )
          yield { type: 'thread.started', thread_id: randomUUID() }
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
        })(),
      }
    },
  })
  const execution = new NodeExecutionService(
    database,
    graphs,
    catalog,
    appData,
    { startThread: thread, resumeThread: (_id, options) => thread(options) },
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
  const tools = new ManagerTools(database, workspace, graphs, catalog, workflow)
  const manager = new ManagerService(database, tools, new LocalMcpServer(tools))
  managers.push(manager)
  workspace.setProjectDeletionGuard((id) =>
    workflow.hasActiveProject(id)
      ? 'Worker or integration active'
      : manager.hasActiveProject(id)
        ? 'Manager active'
        : catalog.hasPendingOperations()
          ? 'Catalog busy'
          : undefined,
  )
  return {
    root,
    file,
    appData,
    database,
    workspace,
    a,
    b,
    task,
    otherTask,
    catalog,
    graphs,
    execution,
    workflow,
    tools,
    manager,
  }
}
const fields = {
  name: 'Changed project',
  description: '',
  instructions: '',
  devCommand: '',
  testCommand: '',
}

describe('confirmed project deletion', () => {
  it('requires a desktop confirmation and cancelling leaves all saved data unchanged', async () => {
    const f = await fixture(),
      confirm = vi.fn().mockResolvedValue(false)
    const input = { projectId: f.a.id, expectedRevision: f.a.revision },
      before = f.workspace.getSnapshot()
    await expect(
      f.workspace.deleteProject(input, confirm),
    ).rejects.toMatchObject({ code: 'HUMAN_ONLY' })
    expect(confirm).not.toHaveBeenCalled()
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(f.a)
    expect(f.workspace.getSnapshot()).toEqual(before)
    await expect(
      f.workspace.deleteProject(
        { ...input, confirmed: true },
        confirm,
        'desktop-human',
      ),
    ).rejects.toThrow()
    await expect(
      f.workspace.deleteProject(
        { ...input, projectId: randomUUID() },
        confirm,
        'desktop-human',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })
  it('rejects settings changes or active work that appear while the confirmation is open', async () => {
    const f = await fixture(),
      input = { projectId: f.a.id, expectedRevision: f.a.revision }
    await expect(
      f.workspace.deleteProject(
        input,
        async () => {
          f.workspace.updateProject({ ...fields, ...input })
          return true
        },
        'desktop-human',
      ),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    const confirm = vi.fn().mockResolvedValue(true)
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    expect(confirm).not.toHaveBeenCalled()
    const current = f.workspace.getBoard({ projectId: f.a.id }).project
    let busy = false
    f.workspace.setProjectDeletionGuard(() =>
      busy ? 'Integration active' : undefined,
    )
    await expect(
      f.workspace.deleteProject(
        { projectId: current.id, expectedRevision: current.revision },
        async () => {
          busy = true
          return true
        },
        'desktop-human',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_BUSY' })
    expect(f.workspace.getBoard({ projectId: f.a.id }).project).toEqual(current)
  })
  it('removes only the selected project metadata and keeps repository files, task worktrees, Git branches and global catalogs', async () => {
    const f = await fixture()
    const globalSkill = await f.catalog.createSkill({
      projectId: null,
      name: 'global-skill',
      description: 'Shared',
      instructions: 'Keep this skill.',
    })
    const localSkill = await f.catalog.createSkill({
      projectId: f.a.id,
      name: 'local-skill',
      description: 'Local',
      instructions: 'Keep the skill folder.',
    })
    const globalProfile = await f.catalog.createProfile({
      projectId: null,
      name: 'Shared profile',
      roleInstructions: '',
      styleGuide: '',
      skillIds: [globalSkill.id],
      model: null,
      effort: null,
    })
    await f.catalog.createProfile({
      projectId: f.a.id,
      name: 'Local profile',
      roleInstructions: '',
      styleGuide: '',
      skillIds: [localSkill.id],
      model: null,
      effort: null,
    })
    const identity = { projectId: f.a.id, taskId: f.task.id }
    execFileSync('git', ['-C', f.a.repoPath, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        f.a.repoPath,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Save project skills',
      ],
      { stdio: 'pipe' },
    )
    const graph = f.graphs.get(identity),
      node = graph.document.nodes.find((node) => node.type === 'agent')!
    f.workflow.startNode({
      ...identity,
      nodeId: node.id,
      expectedGraphRevision: graph.revision,
      mode: 'run',
    })
    await f.workflow.waitForIdle()
    const worktree = f.execution.worktrees.get(f.task.id)!
    const board = { projectId: f.a.id, taskId: null }
    const oldChat = f.manager.get(board)
    f.manager.newChat({ ...board, expectedChatId: oldChat.id })
    f.manager.get(identity)
    const commandId = randomUUID()
    await f.tools.call(board, 'todo_update', {
      taskId: f.task.id,
      expectedRevision: f.workspace.getBoard({ projectId: f.a.id }).tasks[0]
        .revision,
      commandId,
      title: 'Changed task title',
    })
    const other = { projectId: f.b.id, taskId: null },
      otherChat = f.manager.get(other)
    const otherCommand = randomUUID()
    await f.tools.call(other, 'todo_update', {
      taskId: f.otherTask.id,
      expectedRevision: f.otherTask.revision,
      commandId: otherCommand,
      title: 'Keep this task',
    })
    const otherBoard = f.workspace.getBoard({ projectId: f.b.id }),
      beforeRevision = f.workspace.getSnapshot().revision
    const listener = vi.fn()
    f.workspace.subscribe(listener)
    expect(
      await f.workspace.deleteProject(
        { projectId: f.a.id, expectedRevision: f.a.revision },
        async () => true,
        'desktop-human',
      ),
    ).toBe(true)
    expect(f.workspace.getSnapshot().revision).toBe(beforeRevision + 1)
    expect(listener).toHaveBeenCalled()
    expect(
      f.workspace.getSnapshot().projects.map((project) => project.id),
    ).toEqual([f.b.id])
    expect(f.workspace.getBoard({ projectId: f.b.id })).toEqual(otherBoard)
    expect(f.manager.get(other)).toEqual(otherChat)
    for (const table of [
      'tasks',
      'task_graphs',
      'graph_revisions',
      'graph_commands',
      'task_worktrees',
      'node_threads',
      'node_runs',
      'workflows',
      'workflow_decisions',
      'catalog_skills',
      'agent_profiles',
      'manager_chats',
      'change_history',
      'manager_commands',
    ]) {
      expect(
        f.database.sqlite
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`)
          .get(f.a.id),
      ).toEqual({ n: 0 })
    }
    expect(
      f.database.sqlite
        .prepare('SELECT id FROM manager_commands WHERE id = ?')
        .get(otherCommand),
    ).toEqual({ id: otherCommand })
    expect(
      f.catalog
        .getSnapshot({ projectId: null })
        .profiles.map((profile) => profile.id),
    ).toContain(globalProfile.id)
    expect(existsSync(join(globalSkill.folderPath, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(localSkill.folderPath, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(f.a.repoPath, 'keep.txt'), 'utf8')).toBe(
      'Keep the repository files',
    )
    expect(readFileSync(join(worktree.path, 'unintegrated.txt'), 'utf8')).toBe(
      'Keep unintegrated task code',
    )
    expect(
      execFileSync(
        'git',
        [
          '-C',
          f.a.repoPath,
          'show-ref',
          '--verify',
          `refs/heads/${worktree.branch}`,
        ],
        { encoding: 'utf8' },
      ),
    ).toContain(worktree.branch)
    expect(f.database.sqlite.pragma('foreign_key_check')).toEqual([])
    const reopened = openWorkspaceDatabase(f.file)
    expect(
      new WorkspaceService(reopened)
        .getSnapshot()
        .projects.map((project) => project.id),
    ).toEqual([f.b.id])
    reopened.close()
  })
  it('blocks deletion while catalog work or a manager turn is pending', async () => {
    const f = await fixture(),
      input = { projectId: f.a.id, expectedRevision: f.a.revision },
      confirm = vi.fn().mockResolvedValue(true)
    const pendingProfile = f.catalog.createProfile({
      projectId: f.a.id,
      name: 'Pending profile',
      roleInstructions: '',
      styleGuide: '',
      skillIds: [],
      model: null,
      effort: null,
    })
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).rejects.toMatchObject({ code: 'PROJECT_BUSY' })
    await pendingProfile
    const board = { projectId: f.a.id, taskId: null },
      packet = await f.tools.context(board)
    let release!: (value: typeof packet) => void
    vi.spyOn(f.tools, 'context').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const sending = f.manager.send({
      ...board,
      message: 'Pending manager turn',
    })
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).rejects.toMatchObject({ code: 'PROJECT_BUSY' })
    expect(confirm).not.toHaveBeenCalled()
    await f.manager.stop(board)
    release(packet)
    await expect(sending).rejects.toThrow()
    expect(f.workspace.getBoard({ projectId: f.a.id }).project.id).toBe(f.a.id)
  })
  it('blocks deletion while a worker is starting and rolls back all rows if deletion fails', async () => {
    const f = await fixture(),
      input = { projectId: f.a.id, expectedRevision: f.a.revision },
      confirm = vi.fn().mockResolvedValue(true)
    const identity = { projectId: f.a.id, taskId: f.task.id },
      graph = f.graphs.get(identity)
    f.workflow.startNode({
      ...identity,
      nodeId: graph.document.nodes.find((node) => node.type === 'agent')!.id,
      expectedGraphRevision: graph.revision,
      mode: 'run',
    })
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).rejects.toMatchObject({ code: 'PROJECT_BUSY' })
    expect(confirm).not.toHaveBeenCalled()
    await f.workflow.waitForIdle()
    const before = f.workspace.getSnapshot(),
      history = f.tools.history({ projectId: f.a.id, taskId: null })
    f.database.sqlite.exec(
      "CREATE TRIGGER fail_project_deletion AFTER DELETE ON projects BEGIN SELECT RAISE(ABORT, 'Deletion fixture failure'); END;",
    )
    await expect(
      f.workspace.deleteProject(input, confirm, 'desktop-human'),
    ).rejects.toThrow('Deletion fixture failure')
    expect(f.workspace.getSnapshot()).toEqual(before)
    expect(f.tools.history({ projectId: f.a.id, taskId: null })).toEqual(
      history,
    )
    expect(f.execution.worktrees.get(f.task.id)).not.toBeNull()
    expect(f.database.sqlite.pragma('foreign_key_check')).toEqual([])
  })
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
