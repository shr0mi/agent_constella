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
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
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
    expect(original.path).toBe(f.project.repoPath)
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
  it('saves legacy task changes, releases the branch, and retains the old folder as a detached backup', async () => {
    const f = await fixture(),
      task = f.task('Legacy task')
    const branch = `codex/constella-${task.id}`,
      path = join(f.root, 'app', 'task-worktrees', f.project.id, task.id)
    const baseRevision = git(f.project.repoPath, 'rev-parse', 'main')
    git(f.project.repoPath, 'worktree', 'add', '-b', branch, path, 'main')
    writeFileSync(join(path, 'legacy-work.txt'), 'staged changes')
    git(path, 'add', '.')
    writeFileSync(join(path, 'legacy-work.txt'), 'latest unstaged changes')
    f.database.db
      .insert(taskWorktrees)
      .values({
        taskId: task.id,
        projectId: f.project.id,
        document: {
          taskId: task.id,
          projectId: f.project.id,
          path,
          branch,
          baseRevision,
          sourceHead: baseRevision,
          sourceBranch: 'main',
          state: 'ready',
          createdAt: new Date().toISOString(),
        },
      })
      .run()
    const adopted = await f.service.adopt(f.project, task)
    expect(adopted).toMatchObject({
      mode: 'project',
      path: f.project.repoPath,
      branch,
      legacyPath: path,
    })
    expect(readFileSync(join(path, 'legacy-work.txt'), 'utf8')).toBe(
      'latest unstaged changes',
    )
    expect(git(path, 'branch', '--show-current')).toBe('')
    git(f.project.repoPath, 'switch', branch)
    expect(
      readFileSync(join(f.project.repoPath, 'legacy-work.txt'), 'utf8'),
    ).toBe('latest unstaged changes')
    expect(git(f.project.repoPath, 'status', '--porcelain')).toBe('')
    expect(await f.service.ensure(f.project, task)).toEqual(adopted)
  })
  it('blocks dirty branch switches and keeps files, staged edits and branch selection intact', async () => {
    const f = await fixture(),
      a = f.task('First'),
      b = f.task('Second')
    const first = await f.service.ensure(f.project, a)
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'staged')
    git(f.project.repoPath, 'add', '.')
    writeFileSync(join(f.project.repoPath, 'local.txt'), 'unstaged')
    const index = git(f.project.repoPath, 'diff', '--cached')
    await expect(f.service.ensure(f.project, b)).rejects.toThrow(
      'uncommitted or untracked',
    )
    expect(git(f.project.repoPath, 'branch', '--show-current')).toBe(
      first.branch,
    )
    expect(git(f.project.repoPath, 'diff', '--cached')).toBe(index)
    expect(readFileSync(join(f.project.repoPath, 'local.txt'), 'utf8')).toBe(
      'unstaged',
    )
    expect(f.service.get(b.id)).toBeNull()
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
