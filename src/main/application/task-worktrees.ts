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
    'Your files are preserved. Check Git and folder access, then retry. The app will not reset or delete a task worktree.',
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
    try {
      const source = await resolveRepository(project.repoPath)
      if (source !== (await realpath(project.repoPath)))
        throw new Error('The project repository root changed.')
      let worktree = this.get(task.id)
      const path = join(
        await realpath(this.appData),
        'task-worktrees',
        project.id,
        task.id,
      )
      if (
        worktree &&
        (worktree.taskId !== task.id ||
          worktree.projectId !== project.id ||
          resolve(worktree.path) !== resolve(path) ||
          !worktree.branch.startsWith('codex/'))
      )
        throw new Error(
          'Stored task worktree ownership does not match this task.',
        )
      if (!worktree) {
        if (await lstat(path).catch(() => null))
          throw new Error(
            'The task worktree path is already occupied and is not registered to this task.',
          )
        // Also cover projects registered by earlier app versions, before they
        // create any new task baselines from an unborn project branch.
        await ensureInitialCommit(source)
        const snapshot = await this.capture(
          source,
          `AgentConstella task baseline ${task.id}`,
          signal,
        )
        const sourceBranch = await taskGit(
          source,
          ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          { signal },
        )
          .then((value) => value.trim())
          .catch(() => null)
        const existing = (
          await taskGit(source, [
            'for-each-ref',
            '--format=%(refname:strip=2)',
            'refs/heads',
          ])
        )
          .trim()
          .split('\n')
          .filter(Boolean)
        // Choose and reserve together without awaiting, so concurrent task
        // preparations cannot claim the same readable name before Git creates it.
        const reserved = this.database.db
          .select()
          .from(taskWorktrees)
          .all()
          .filter(
            (row) =>
              row.projectId === project.id || row.document.state === 'creating',
          )
          .map((row) => row.document.branch)
        const branch = readableTaskBranch(task.title, [
          ...existing,
          ...reserved,
        ])
        worktree = {
          taskId: task.id,
          projectId: project.id,
          path,
          branch,
          baseRevision: snapshot.commit,
          sourceHead: snapshot.head || null,
          sourceBranch,
          state: 'creating',
          createdAt: new Date().toISOString(),
        }
        this.save(worktree)
      }
      const branch = worktree.branch
      const exists = await lstat(path).catch(() => null)
      if (!exists) {
        if (worktree.state === 'ready')
          throw new Error(
            'The saved task worktree is missing. Restore it at its recorded path to continue the conversation.',
          )
        await mkdir(join(this.appData, 'task-worktrees', project.id), {
          recursive: true,
        })
        const hasBranch = await taskGit(
          source,
          ['show-ref', '--verify', `refs/heads/${branch}`],
          { signal },
        )
          .then(() => true)
          .catch(() => false)
        if (
          hasBranch &&
          (
            await taskGit(source, ['rev-parse', `refs/heads/${branch}`])
          ).trim() !== worktree.baseRevision
        )
          throw new Error(
            'The reserved task branch now contains different work. Its files and history have been preserved.',
          )
        await taskGit(
          source,
          [
            'worktree',
            'add',
            ...(hasBranch ? [] : ['-b', branch]),
            path,
            hasBranch ? branch : worktree.baseRevision,
          ],
          { signal },
        )
      }
      await this.verify(worktree, source)
      worktree.state = 'ready'
      this.save(worktree)
      return structuredClone(worktree)
    } catch (error) {
      if (signal?.aborted) throw error
      throw gitFailure('Cannot prepare the task worktree.', error)
    }
  }
  async verify(worktree: TaskWorktree, source?: string) {
    const metadata = await lstat(worktree.path)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(worktree.path)) !== resolve(worktree.path)
    )
      throw new Error('The task worktree path is not an owned local directory.')
    const actualBranch = (
      await taskGit(worktree.path, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ])
    ).trim()
    const root = await resolveRepository(worktree.path)
    if (
      actualBranch !== worktree.branch ||
      root !== (await realpath(worktree.path))
    )
      throw new Error(
        'The task worktree branch or root changed. Restore its recorded branch to continue.',
      )
    if (source) {
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
  async changes(
    worktree: TaskWorktree,
    before: CodeSnapshot,
  ): Promise<RunChanges> {
    await this.verify(worktree)
    const after = await this.capture(
      worktree.path,
      'AgentConstella attempt result',
    )
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
    await this.verify(worktree)
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
