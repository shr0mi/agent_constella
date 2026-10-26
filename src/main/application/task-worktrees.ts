import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import type { WorkspaceDatabase } from '../db/database'
import { taskWorktrees } from '../db/schema'
import type { Project, Task } from '../../shared/workspace'
import type {
  CodeSnapshot,
  FileDiff,
  RunChanges,
  TaskWorktree,
} from '../../shared/execution'
import { ApplicationError } from './errors'
import { ensureInitialCommit, resolveRepository } from './repository'

const exec = promisify(execFile)
export async function taskGit(
  path: string,
  args: string[],
  options: { index?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const env = {
    ...process.env,
    LC_ALL: 'C',
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: options.index,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'AgentConstella',
    GIT_AUTHOR_EMAIL: 'constella@localhost',
    GIT_COMMITTER_NAME: 'AgentConstella',
    GIT_COMMITTER_EMAIL: 'constella@localhost',
  }
  const result = await exec(
    'git',
    [
      '-C',
      path,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    {
      env,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
    },
  )
  return result.stdout
}
const gitFailure = (message: string, error: unknown) =>
  new ApplicationError(
    'TASK_WORKTREE',
    `${message}\n${error instanceof Error ? error.message : String(error)}`,
    'Your files are preserved. Check the project branch, local changes, and Git access, then retry. The app will not discard local edits.',
  )
function readableTaskBranch(title: string, existing: string[]) {
  const occupied = existing.map((name) => name.normalize('NFKC').toLowerCase())
  if (occupied.includes('codex'))
    throw new Error(
      'A branch named codex blocks the codex/ task branch namespace. Rename that branch before starting a new task.',
    )
  const words = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const slug =
    Array.from(words).slice(0, 60).join('').replace(/-+$/, '') || 'task'
  const base = `codex/${slug}`
  let branch = base,
    suffix = 2
  while (
    occupied.some(
      (name) =>
        name === branch ||
        name.startsWith(`${branch}/`) ||
        branch.startsWith(`${name}/`),
    )
  )
    branch = `${base}-${suffix++}`
  return branch
}
export class TaskWorktreeService {
  private preparing = new Map<string, Promise<unknown>>()
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly appData: string,
  ) {}
  get(taskId: string): TaskWorktree | null {
    return (
      this.database.db
        .select()
        .from(taskWorktrees)
        .where(eq(taskWorktrees.taskId, taskId))
        .get()?.document ?? null
    )
  }
  private save(worktree: TaskWorktree) {
    this.database.db
      .insert(taskWorktrees)
      .values({
        taskId: worktree.taskId,
        projectId: worktree.projectId,
        document: worktree,
      })
      .onConflictDoUpdate({
        target: taskWorktrees.taskId,
        set: { document: worktree },
      })
      .run()
  }
  async capture(
    path: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<CodeSnapshot> {
    // The temporary index captures tracked and nonignored untracked files without
    // touching the user's index, HEAD, working files, or branch.
    const directory = join(this.appData, 'git-indexes')
    await mkdir(directory, { recursive: true })
    const temporary = await mkdtemp(join(directory, 'snapshot-'))
    const index = join(temporary, 'index')
    try {
      const head = await taskGit(path, ['rev-parse', '--verify', 'HEAD'], {
        signal,
      })
        .then((value) => value.trim())
        .catch((error) => {
          if (signal?.aborted) throw error
          return ''
        })
      await taskGit(
        path,
        head ? ['read-tree', head] : ['read-tree', '--empty'],
        { index, signal },
      )
      await taskGit(path, ['add', '--all', '--', '.'], { index, signal })
      const tree = (
        await taskGit(path, ['write-tree'], { index, signal })
      ).trim()
      const commit = (
        await taskGit(
          path,
          ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', label],
          { signal },
        )
      ).trim()
      await taskGit(
        path,
        ['update-ref', `refs/constella/snapshots/${commit}`, commit],
        { signal },
      )
      return { head, commit }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  async ensure(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<TaskWorktree> {
    const previous = this.preparing.get(project.id) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(() => this.prepare(project, task, signal))
    this.preparing.set(project.id, pending)
    try {
      return await pending
    } finally {
      if (this.preparing.get(project.id) === pending)
        this.preparing.delete(project.id)
    }
  }
  async assertClean(path: string) {
    if ((await taskGit(path, ['status', '--porcelain=v1', '-z'])).length)
      throw new Error(
        'The project has uncommitted or untracked changes. Commit or stash your edits before switching task branches. Your files and index have been preserved.',
      )
    for (const name of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'BISECT_LOG',
    ]) {
      const gitPath = (
        await taskGit(path, ['rev-parse', '--git-path', name])
      ).trim()
      if (await lstat(resolve(path, gitPath)).catch(() => null))
        throw new Error(
          'Finish the existing Git operation in the project before switching task branches.',
        )
    }
  }
  // Release branches held by older app-managed checkouts. Their files remain as
  // backups; the saved branch becomes available in the user's project directory.
  async adopt(project: Project, task: Task): Promise<TaskWorktree | null> {
    const worktree = this.get(task.id)
    if (!worktree || worktree.mode === 'project') return worktree
    const expected = join(
      await realpath(this.appData),
      'task-worktrees',
      project.id,
      task.id,
    )
    if (
      worktree.projectId !== project.id ||
      worktree.taskId !== task.id ||
      resolve(worktree.path) !== resolve(expected)
    )
      throw new Error(
        'Stored legacy checkout ownership does not match this task.',
      )
    await this.verify(worktree, project.repoPath, false)
    const branch = await taskGit(worktree.path, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
      .then((value) => value.trim())
      .catch(() => null)
    if (branch && branch !== worktree.branch)
      throw new Error(
        'The legacy task checkout is on another branch. Its files have been preserved.',
      )
    if (branch) {
      const snapshot = await this.capture(
        worktree.path,
        `Save ${worktree.branch} before moving to the project directory`,
      )
      await this.checkpoint(worktree, snapshot)
      await taskGit(worktree.path, ['switch', '--detach', snapshot.commit])
    } else {
      await this.assertClean(worktree.path)
      const head = (await taskGit(worktree.path, ['rev-parse', 'HEAD'])).trim()
      const tip = (
        await taskGit(worktree.path, [
          'rev-parse',
          `refs/heads/${worktree.branch}`,
        ])
      ).trim()
      if (head !== tip)
        throw new Error(
          'The detached legacy backup differs from the task branch. Its files are preserved; reconcile that branch before continuing.',
        )
    }
    const adopted: TaskWorktree = {
      ...worktree,
      mode: 'project',
      legacyPath: worktree.path,
      path: await realpath(project.repoPath),
      state: 'ready',
    }
    this.save(adopted)
    return adopted
  }
  private async prepare(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<TaskWorktree> {
    try {
      const source = await resolveRepository(project.repoPath)
      if (source !== (await realpath(project.repoPath)))
        throw new Error('The project repository root changed.')
      signal?.throwIfAborted()
      let worktree = await this.adopt(project, task)
      await this.assertClean(source)
      await ensureInitialCommit(source)
      if (!worktree) {
        let sourceBranch = (
          await taskGit(
            source,
            ['symbolic-ref', '--quiet', '--short', 'HEAD'],
            { signal },
          )
        ).trim()
        // A second todo starts from the integration branch, not another todo's
        // unintegrated progress left selected in the shared project directory.
        const records = this.database.db
          .select()
          .from(taskWorktrees)
          .all()
          .map((row) => row.document)
        const visited = new Set<string>()
        while (true) {
          const owner = records.find(
            (record) =>
              record.projectId === project.id && record.branch === sourceBranch,
          )
          if (!owner) break
          if (!owner.sourceBranch || visited.has(sourceBranch))
            throw new Error(
              'Cannot determine the project integration branch. Check out your base branch before starting a new task.',
            )
          visited.add(sourceBranch)
          sourceBranch = owner.sourceBranch
        }
        const baseRevision = (
          await taskGit(
            source,
            ['rev-parse', '--verify', `refs/heads/${sourceBranch}`],
            { signal },
          )
        ).trim()
        const existing = (
          await taskGit(
            source,
            ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'],
            { signal },
          )
        )
          .trim()
          .split('\n')
          .filter(Boolean)
        const reserved = records
          .filter((record) => record.projectId === project.id)
          .map((record) => record.branch)
        worktree = {
          mode: 'project',
          taskId: task.id,
          projectId: project.id,
          path: source,
          branch: readableTaskBranch(task.title, [...existing, ...reserved]),
          baseRevision,
          sourceHead: baseRevision,
          sourceBranch,
          state: 'creating',
          createdAt: new Date().toISOString(),
        }
        this.save(worktree)
      }
      if (
        worktree.taskId !== task.id ||
        worktree.projectId !== project.id ||
        worktree.path !== source ||
        !worktree.branch.startsWith('codex/')
      )
        throw new Error(
          'Stored task branch ownership does not match this project.',
        )
      const head = await taskGit(
        source,
        ['rev-parse', '--verify', `refs/heads/${worktree.branch}`],
        { signal },
      )
        .then((value) => value.trim())
        .catch(() => null)
      if (!head) {
        if (worktree.state === 'ready')
          throw new Error(
            'The saved task branch is missing. Restore it before continuing; it will not be silently recreated.',
          )
        await taskGit(
          source,
          ['branch', worktree.branch, worktree.baseRevision],
          { signal },
        )
      } else if (
        worktree.state === 'creating' &&
        head !== worktree.baseRevision
      ) {
        throw new Error(
          'The reserved task branch now contains different work. Its files and history have been preserved.',
        )
      }
      await taskGit(source, ['switch', worktree.branch], { signal })
      await this.verify(worktree, source)
      worktree.state = 'ready'
      this.save(worktree)
      return structuredClone(worktree)
    } catch (error) {
      if (signal?.aborted) throw error
      throw gitFailure(
        'Cannot prepare the task branch in the project directory.',
        error,
      )
    }
  }
  async verify(worktree: TaskWorktree, source?: string, checkedOut = true) {
    const metadata = await lstat(worktree.path)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(worktree.path)) !== resolve(worktree.path)
    )
      throw new Error('The task worktree path is not an owned local directory.')
    const actualBranch = await taskGit(worktree.path, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
      .then((value) => value.trim())
      .catch(() => null)
    const root = await resolveRepository(worktree.path)
    if (
      (checkedOut && actualBranch !== worktree.branch) ||
      root !== (await realpath(worktree.path))
    )
      throw new Error(
        'The task branch or project root changed during the operation. Select the task branch and retry.',
      )
    if (source) {
      if (worktree.mode === 'project' && (await realpath(source)) !== root)
        throw new Error(
          'The task branch is registered to a different project directory.',
        )
      const common = async (path: string) =>
        realpath(
          (
            await taskGit(path, [
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ])
          ).trim(),
        )
      if ((await common(source)) !== (await common(worktree.path)))
        throw new Error(
          'The task worktree belongs to a different Git repository.',
        )
    }
  }
  async checkpoint(worktree: TaskWorktree, snapshot: CodeSnapshot) {
    await this.verify(worktree)
    await taskGit(worktree.path, [
      'update-ref',
      `refs/heads/${worktree.branch}`,
      snapshot.commit,
      snapshot.head,
    ])
    await this.verify(worktree)
    // Only align the index: working files are never reset or overwritten.
    await taskGit(worktree.path, ['read-tree', snapshot.commit])
  }
  async changes(
    worktree: TaskWorktree,
    before: CodeSnapshot,
    saveProgress = true,
  ): Promise<RunChanges> {
    await this.verify(worktree)
    const after = await this.capture(worktree.path, `Update ${worktree.branch}`)
    if (saveProgress && worktree.mode === 'project')
      await this.checkpoint(worktree, after)
    const fields = (
      await taskGit(worktree.path, [
        'diff',
        '--name-status',
        '--no-renames',
        '-z',
        before.commit,
        after.commit,
        '--',
      ])
    ).split('\0')
    const files: RunChanges['files'] = []
    for (let index = 0; index < fields.length - 1; index += 2) {
      const status = fields[index],
        path = fields[index + 1]
      if (status && path)
        files.push({
          path,
          status:
            status === 'A'
              ? 'added'
              : status === 'D'
                ? 'deleted'
                : status === 'T'
                  ? 'type-changed'
                  : 'modified',
        })
    }
    return {
      before,
      after,
      files: files.slice(0, 2000),
      omittedFiles: Math.max(0, files.length - 2000),
    }
  }
  async diff(
    worktree: TaskWorktree,
    changes: RunChanges,
    path: string,
  ): Promise<FileDiff> {
    if (!changes.files.some((file) => file.path === path))
      throw new ApplicationError(
        'DIFF_FILE',
        'This file is not part of the selected attempt.',
        'Select a recorded changed file.',
      )
    await this.verify(worktree, undefined, false)
    const read = async (commit: string) => {
      const spec = `${commit}:${path}`
      const kind = await taskGit(worktree.path, ['cat-file', '-t', spec])
        .then((value) => value.trim())
        .catch(() => null)
      if (!kind) return { content: '', binary: false }
      if (kind !== 'blob')
        return {
          content: '',
          binary: false,
          unavailable:
            'This entry is a submodule or another non-file Git object.',
        }
      const size = Number(
        (await taskGit(worktree.path, ['cat-file', '-s', spec])).trim(),
      )
      if (size > 512 * 1024)
        return {
          content: '',
          binary: false,
          unavailable:
            'This file exceeds the 512 KB diff preview limit. Its full contents remain in the Git snapshot.',
        }
      const content = await taskGit(worktree.path, [
        'show',
        '--no-ext-diff',
        '--no-textconv',
        spec,
      ])
      return {
        content,
        binary: content.includes('\0') || content.includes('\uFFFD'),
      }
    }
    const [original, modified] = await Promise.all([
      read(changes.before.commit),
      read(changes.after.commit),
    ])
    return {
      path,
      original: original.content,
      modified: modified.content,
      binary: original.binary || modified.binary,
      unavailable: original.unavailable ?? modified.unavailable,
    }
  }
}
