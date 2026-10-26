import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
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
  const root = mkdtempSync(join(tmpdir(), "constella task's-"))
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
      await f.service.verify(worktree, f.project.repoPath)
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
    writeFileSync(join(original.path, 'local-work.txt'), 'preserve changes')
    const renamed = f.workspace.updateTask({
      taskId: task.id,
      projectId: f.project.id,
      expectedRevision: task.revision,
      title: 'New title',
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
    })
    expect(await f.service.ensure(f.project, renamed)).toEqual(original)
    expect(git(original.path, 'status', '--porcelain')).toContain(
      'local-work.txt',
    )
  })
  it('reuses saved legacy branch names and preserves their uncommitted files', async () => {
    const f = await fixture(),
      task = f.task('Legacy task')
    const worktree = await f.service.ensure(f.project, task)
    const legacy = { ...worktree, branch: `codex/constella-${task.id}` }
    git(worktree.path, 'branch', '-m', legacy.branch)
    writeFileSync(join(worktree.path, 'legacy-work.txt'), 'preserve changes')
    f.database.db
      .update(taskWorktrees)
      .set({ document: legacy })
      .where(eq(taskWorktrees.taskId, task.id))
      .run()
    expect(await f.service.ensure(f.project, task)).toEqual(legacy)
    expect(git(worktree.path, 'status', '--porcelain')).toContain(
      'legacy-work.txt',
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
