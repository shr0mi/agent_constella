import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { taskWorktrees } from '../src/main/db/schema'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { TaskWorktreeService } from '../src/main/application/task-worktrees'

const roots: string[] = [],
  databases: WorkspaceDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  roots
    .splice(0)
    .forEach((root) => removeTemp(root))
})
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "constella task's-")))
  roots.push(root)
  const appData = join(root, 'app'),
    database = openWorkspaceDatabase(join(appData, 'workspace.sqlite'))
  databases.push(database)
  const workspace = new WorkspaceService(database)
  const project = await workspace.createProject({ path: join(root, 'project') })
  const service = new TaskWorktreeService(database, appData)
  const task = (title: string) =>
    workspace.createTask({ projectId: project.id, title })
  return { root, database, workspace, project, service, task }
}

describe('readable task branches', () => {
  it('uses the title, avoids existing branches and reserves concurrent names without touching other work', async () => {
    const f = await fixture()
    git(f.project.repoPath, 'branch', 'codex/add-csv-export')
    const original = git(
      f.project.repoPath,
      'rev-parse',
      'codex/add-csv-export',
    )
    const a = f.task('Add CSV Export!'),
      b = f.task('Add CSV export')
    const worktrees = await Promise.all([
      f.service.ensure(f.project, a),
      f.service.ensure(f.project, b),
    ])
    expect(worktrees.map((worktree) => worktree.branch).sort()).toEqual([
      'codex/add-csv-export-2',
      'codex/add-csv-export-3',
    ])
    for (const worktree of worktrees)
      await f.service.verify(worktree, f.project.repoPath, false)
    expect(git(f.project.repoPath, 'rev-parse', 'codex/add-csv-export')).toBe(
      original,
    )
  })
  it('makes valid bounded names from Unicode, punctuation and long titles', async () => {
    const f = await fixture()
    for (const [title, expected] of [
      ['Settings: ../[new] @{name}.lock', 'settings-new-name-lock'],
      ['নতুন কাজ', 'নতুন-কাজ'],
      ['!!!', 'task'],
      ['A'.repeat(120), 'a'.repeat(60)],
    ]) {
      const worktree = await f.service.ensure(f.project, f.task(title))
      expect(worktree.branch).toBe(`codex/${expected}`)
      expect(
        git(
          f.project.repoPath,
          'check-ref-format',
          '--branch',
          worktree.branch,
        ),
      ).toBe(worktree.branch)
    }
  })
  it('keeps an existing worktree and branch after its task is renamed', async () => {
    const f = await fixture(),
      task = f.task('Original title')
    const original = await f.service.ensure(f.project, task)
    expect(original.path).not.toBe(f.project.repoPath)
    expect(existsSync(join(f.root, 'app', 'task-worktrees'))).toBe(false)
    const renamed = f.workspace.updateTask({
      taskId: task.id,
      projectId: f.project.id,
      expectedRevision: task.revision,
      title: 'New title',
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
    })
    expect(await f.service.ensure(f.project, renamed)).toEqual(original)
    expect(git(original.path, 'status', '--porcelain')).toBe('')
  })
  it('reuses legacy isolated worktrees without changing their files or index', async () => {
    const f = await fixture(), task = f.task('Legacy task')
    const branch = `codex/legacy-${task.id}`
    const path = join(f.root, 'app', 'task-worktrees', f.project.id, task.id)
    const baseRevision = git(f.project.repoPath, 'rev-parse', 'main')
    git(f.project.repoPath, 'worktree', 'add', '-b', branch, path, 'main')
    writeFileSync(join(path, 'legacy.txt'), 'staged')
    git(path, 'add', '.')
    writeFileSync(join(path, 'legacy.txt'), 'unstaged')
    const index = git(path, 'diff', '--cached')
    f.database.db.insert(taskWorktrees).values({ taskId: task.id, projectId: f.project.id, document: {
      taskId: task.id, projectId: f.project.id, path, branch, baseRevision, sourceHead: baseRevision, sourceBranch: 'main', state: 'ready', createdAt: new Date().toISOString(),
    } }).run()
    expect(await f.service.adopt(f.project, task)).toMatchObject({ mode: 'isolated', path, branch })
    expect(readFileSync(join(path, 'legacy.txt'), 'utf8')).toBe('unstaged')
    expect(git(path, 'diff', '--cached')).toBe(index)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
  })
  it('creates independent task worktrees while preserving dirty original files and index', async () => {
    const f = await fixture()
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'staged')
    git(f.project.repoPath, 'add', '.')
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'unstaged')
    const index = git(f.project.repoPath, 'diff', '--cached')
    const [a, b] = await Promise.all([f.service.ensure(f.project, f.task('First')), f.service.ensure(f.project, f.task('Second'))])
    expect(a.path).not.toBe(b.path)
    expect(existsSync(join(a.path, 'local.txt'))).toBe(false)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
    expect(git(f.project.repoPath, 'diff', '--cached')).toBe(index)
    expect(readFileSync(join(f.project.repoPath, 'local.txt'), 'utf8')).toBe('unstaged')
  })
  it('resumes a selected task branch with staged, unstaged and untracked files intact', async () => {
    const f = await fixture(),
      task = f.task('Continue unfinished work')
    const worktree = await f.service.ensure(f.project, task)
    writeFileSync(join(worktree.path, 'local.txt'), 'staged')
    git(worktree.path, 'add', '.')
    writeFileSync(join(worktree.path, 'local.txt'), 'unstaged')
    writeFileSync(join(worktree.path, 'new.txt'), 'untracked')
    const head = git(worktree.path, 'rev-parse', 'HEAD'),
      index = git(worktree.path, 'diff', '--cached'),
      status = git(worktree.path, 'status', '--porcelain')
    expect(await f.service.ensure(f.project, task)).toEqual(worktree)
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(worktree.path, 'diff', '--cached')).toBe(index)
    expect(git(worktree.path, 'status', '--porcelain')).toBe(status)
    expect(readFileSync(join(worktree.path, 'local.txt'), 'utf8')).toBe(
      'unstaged',
    )
    expect(readFileSync(join(worktree.path, 'new.txt'), 'utf8')).toBe(
      'untracked',
    )
  })
  it('moves project-mode task branches into isolated folders without losing committed work', async () => {
    const f = await fixture(), task = f.task('Previously shared')
    const baseRevision = git(f.project.repoPath, 'rev-parse', 'main'), branch = 'codex/previously-shared'
    git(f.project.repoPath, 'switch', '-c', branch)
    const old = { mode: 'project' as const, taskId: task.id, projectId: f.project.id, path: f.project.repoPath, branch, baseRevision, sourceHead: baseRevision, sourceBranch: 'main', state: 'ready' as const, createdAt: new Date().toISOString() }
    writeFileSync(join(old.path, 'saved.txt'), 'keep this work')
    await f.service.checkpoint(old, await f.service.capture(old.path, 'Save existing task'))
    f.database.db.insert(taskWorktrees).values({ taskId: task.id, projectId: f.project.id, document: old }).run()
    const migrated = await f.service.ensure(f.project, task)
    expect(migrated.mode).toBe('isolated')
    expect(migrated.path).not.toBe(old.path)
    expect(readFileSync(join(migrated.path, 'saved.txt'), 'utf8')).toBe('keep this work')
    expect(existsSync(join(f.project.repoPath, 'saved.txt'))).toBe(false)
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe('main')
  })
  it('blocks migration of a selected project-mode task with dirty files and preserves them', async () => {
    const f = await fixture(), task = f.task('Dirty migration')
    const branch = 'codex/dirty-migration', baseRevision = git(f.project.repoPath, 'rev-parse', 'main')
    git(f.project.repoPath, 'switch', '-c', branch)
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'preserve')
    f.database.db.insert(taskWorktrees).values({ taskId: task.id, projectId: f.project.id, document: {
      mode: 'project', taskId: task.id, projectId: f.project.id, path: f.project.repoPath, branch, baseRevision, sourceHead: baseRevision, sourceBranch: 'main', state: 'ready', createdAt: new Date().toISOString(),
    } }).run()
    await expect(f.service.ensure(f.project, task)).rejects.toThrow('uncommitted or untracked')
    expect(readFileSync(join(f.project.repoPath, 'local.txt'), 'utf8')).toBe('preserve')
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe(branch)
  })
  it('still blocks unfinished Git operations when already on the task branch', async () => {
    const f = await fixture(),
      task = f.task('Unfinished merge')
    const worktree = await f.service.ensure(f.project, task)
    writeFileSync(
      git(worktree.path, 'rev-parse', '--git-path', 'MERGE_HEAD'),
      git(worktree.path, 'rev-parse', 'HEAD'),
    )
    await expect(f.service.ensure(f.project, task)).rejects.toThrow(
      'Finish the existing Git operation',
    )
  })
  it('avoids branch namespace collisions and reports an occupied codex prefix', async () => {
    const f = await fixture()
    git(f.project.repoPath, 'branch', 'codex/task/subtask')
    expect((await f.service.ensure(f.project, f.task('Task'))).branch).toBe(
      'codex/task-2',
    )
    git(f.project.repoPath, 'branch', '-D', 'codex/task/subtask')
    // Use a separate repository because the earlier managed branch owns codex/.
    const other = await f.workspace.createProject({
      path: join(f.root, 'other'),
    })
    git(other.repoPath, 'branch', 'codex')
    const task = f.workspace.createTask({ projectId: other.id, title: 'Build' })
    await expect(f.service.ensure(other, task)).rejects.toThrow(
      'branch named codex blocks',
    )
    expect(git(other.repoPath, 'branch', '--list', 'codex')).toContain('codex')
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
