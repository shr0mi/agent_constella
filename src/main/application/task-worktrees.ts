import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import type { WorkspaceDatabase } from '../db/database'
import { nodeWorktrees, taskWorktrees } from '../db/schema'
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
  async exclusive<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.preparing.get(taskId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.preparing.set(taskId, pending)
    try {
      return await pending
    } finally {
      if (this.preparing.get(taskId) === pending) this.preparing.delete(taskId)
    }
  }
  async ensure(
    project: Project,
    task: Task,
    signal?: AbortSignal,
    _options: { preserveLocalChanges?: boolean } = {},
  ): Promise<TaskWorktree> {
    return this.exclusive(task.id, () => this.prepare(project, task, signal))
  }
  getNode(nodeId: string): TaskWorktree | null {
    return this.database.db
      .select()
      .from(nodeWorktrees)
      .where(eq(nodeWorktrees.nodeId, nodeId))
      .get()?.document ?? null
  }
  private saveNode(worktree: TaskWorktree) {
    this.database.db
      .insert(nodeWorktrees)
      .values({
        nodeId: worktree.nodeId!,
        taskId: worktree.taskId,
        projectId: worktree.projectId,
        document: worktree,
      })
      .onConflictDoUpdate({
        target: nodeWorktrees.nodeId,
        set: { document: worktree },
      })
      .run()
  }
  async ensureNode(
    project: Project,
    task: Task,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<TaskWorktree> {
    return this.exclusive(task.id, async () => {
      const result = await this.prepare(project, task, signal, true)
      let node = this.getNode(nodeId)
      if (node && (node.taskId !== task.id || node.projectId !== project.id))
        throw new Error('The agent workspace belongs to another task.')
      if (!node) {
        const path = join(
          await realpath(this.appData), 'node-worktrees', project.id, task.id, nodeId,
        )
        const branches = await taskGit(project.repoPath, [
          'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads',
        ])
        const branch = readableTaskBranch(
          `${task.title}-agent-${nodeId}`, branches.trim().split('\n'),
        )
        node = {
          ...result,
          nodeId,
          path,
          branch,
          state: 'creating',
          baseRevision: (await taskGit(result.path, ['rev-parse', 'HEAD'])).trim(),
          createdAt: new Date().toISOString(),
        }
        this.saveNode(node)
      }
      await this.createCheckout(project.repoPath, node, signal)
      await this.verify(node, project.repoPath)
      await this.assertNoOperation(node.path)
      // Preserve edits made in an agent's IDE before bringing in accepted upstream code.
      if ((await taskGit(node.path, ['status', '--short'])).length)
        await this.checkpoint(
          node, await this.capture(node.path, `Save local edits on ${node.branch}`),
        )
      await this.mergeInto(
        node,
        (await taskGit(result.path, ['rev-parse', 'HEAD'])).trim(),
        'Update agent prerequisites',
      )
      node.state = 'ready'
      this.saveNode(node)
      return structuredClone(node)
    })
  }
  async assertClean(path: string) {
    await this.assertNoOperation(path)
    const status = await taskGit(path, ['status', '--short'])
    if (status.length) {
      const branch = (await taskGit(path, ['branch', '--show-current'])).trim()
      const entries = status.trimEnd().split('\n')
      throw new Error(
        `The project has uncommitted or untracked changes on ${branch || 'a detached checkout'}.\n${entries.slice(0, 12).join('\n')}${entries.length > 12 ? '\n…' : ''}\nCommit or stash your edits before switching task branches. If these are unfinished task files, restore that task if archived, then use Review task → Switch to task branch and retry. Returning with local changes requires both branches to have identical committed files. Archiving does not clear local changes. Your files and index have been preserved.`,
      )
    }
  }
  private async assertNoOperation(path: string) {
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
  async adopt(project: Project, task: Task): Promise<TaskWorktree | null> {
    let worktree = this.get(task.id)
    if (!worktree) return null
    if (worktree.projectId !== project.id || worktree.taskId !== task.id)
      throw new Error('Stored task workspace ownership does not match this project.')
    if (worktree.mode === 'project') {
      if ((await realpath(worktree.path)) !== (await realpath(project.repoPath)))
        throw new Error('The saved project directory changed. Existing files are preserved.')
      if ((await taskGit(project.repoPath, ['branch', '--show-current'])).trim() === worktree.branch) {
        await this.assertClean(project.repoPath)
        if (!worktree.sourceBranch) throw new Error('Restore the saved base branch before migrating this task.')
        await taskGit(project.repoPath, ['switch', worktree.sourceBranch])
      }
      worktree = {
        ...worktree,
        mode: 'isolated',
        legacyPath: worktree.path,
        path: join(await realpath(this.appData), 'task-worktrees-v2', project.id, task.id),
        state: 'creating',
      }
      this.save(worktree)
    }
    const root = await realpath(this.appData)
    const expected = ['task-worktrees-v2', 'task-worktrees'].map(
      (folder) => join(root, folder, project.id, task.id),
    )
    if (!expected.includes(resolve(worktree.path)))
      throw new Error('The saved task workspace is outside its registered location.')
    await this.createCheckout(project.repoPath, worktree)
    await this.verify(worktree, project.repoPath, false)
    const selected = (await taskGit(worktree.path, ['branch', '--show-current'])).trim()
    if (!selected) {
      await this.assertClean(worktree.path)
      const heads = (await taskGit(worktree.path, [
        'rev-parse', 'HEAD', `refs/heads/${worktree.branch}`,
      ])).trim().split('\n')
      if (heads[0] !== heads[1])
        throw new Error('The detached backup differs from its saved branch. Reconcile it before continuing.')
      await taskGit(worktree.path, ['switch', worktree.branch])
    }
    await this.verify(worktree, project.repoPath)
    worktree.mode = 'isolated'
    worktree.state = 'ready'
    this.save(worktree)
    return worktree
  }
  private async createCheckout(
    source: string, worktree: TaskWorktree, signal?: AbortSignal,
  ) {
    const exists = await lstat(worktree.path).catch(() => null)
    const head = await taskGit(source, [
      'rev-parse', '--verify', `refs/heads/${worktree.branch}`,
    ]).then((value) => value.trim()).catch(() => null)
    if (worktree.state === 'ready' && (!exists || !head))
      throw new Error('The saved task branch or workspace is missing. Restore it before continuing; it will not be silently recreated.')
    if (!exists) {
      await mkdir(dirname(worktree.path), { recursive: true })
      await taskGit(source, [
        'worktree', 'add', ...(head ? [] : ['-b', worktree.branch]),
        worktree.path, head ? worktree.branch : worktree.baseRevision,
      ], { signal })
    }
  }
  private prepare(
    project: Project, task: Task, signal?: AbortSignal, syncDependencies = false,
  ): Promise<TaskWorktree> {
    return this.exclusive(`project:${project.id}`, () =>
      this.prepareUnlocked(project, task, signal, syncDependencies),
    )
  }
  private async prepareUnlocked(
    project: Project, task: Task, signal?: AbortSignal, syncDependencies = false,
  ): Promise<TaskWorktree> {
    try {
      const source = await resolveRepository(project.repoPath)
      if (source !== await realpath(project.repoPath))
        throw new Error('The project repository root changed.')
      signal?.throwIfAborted()
      await ensureInitialCommit(source)
      let worktree = await this.adopt(project, task)
      if (!worktree) {
        let sourceBranch = (await taskGit(source, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
        const records = this.database.db
          .select().from(taskWorktrees).all().map((row) => row.document)
        const visited = new Set<string>()
        while (true) {
          const owner = records.find(
            (record) => record.projectId === project.id && record.branch === sourceBranch,
          )
          if (!owner) break
          if (!owner.sourceBranch || visited.has(sourceBranch))
            throw new Error('Cannot determine the project base branch.')
          visited.add(sourceBranch)
          sourceBranch = owner.sourceBranch
        }
        const baseRevision = (await taskGit(source, [
          'rev-parse', '--verify', `refs/heads/${sourceBranch}`,
        ])).trim()
        const existing = (await taskGit(source, [
          'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads',
        ])).trim().split('\n')
        worktree = {
          mode: 'isolated',
          taskId: task.id,
          projectId: project.id,
          path: join(await realpath(this.appData), 'task-worktrees-v2', project.id, task.id),
          branch: readableTaskBranch(task.title, [...existing, ...records.map((record) => record.branch)]),
          baseRevision,
          sourceHead: baseRevision,
          sourceBranch,
          state: 'creating',
          createdAt: new Date().toISOString(),
        }
        this.save(worktree)
        await this.createCheckout(source, worktree, signal)
        worktree.state = 'ready'
        this.save(worktree)
      }
      await this.verify(worktree, source)
      await this.assertNoOperation(worktree.path)
      if (syncDependencies && (await taskGit(worktree.path, ['status', '--short'])).length)
        await this.checkpoint(
          worktree,
          await this.capture(worktree.path, 'Save task workspace edits before execution'),
        )
      // A previously opened task must receive dependencies integrated since its creation.
      if (syncDependencies && (task.dependencyIds ?? []).length && worktree.sourceBranch) {
        const base = (await taskGit(source, [
          'rev-parse', `refs/heads/${worktree.sourceBranch}`,
        ])).trim()
        for (const id of task.dependencyIds) {
          const receipt = this.database.sqlite.prepare(
            "SELECT json_extract(document, '$.integration.commit') AS commit_id FROM workflows WHERE task_id = ?",
          ).get(id) as { commit_id: string | null } | undefined
          const available = receipt?.commit_id && await this.isAncestor(source, receipt.commit_id, base)
          if (!available)
            throw new ApplicationError(
              'TASK_DEPENDENCIES',
              'A prerequisite is not integrated into this task’s base branch.',
              'Integrate the prerequisite into the same base branch before continuing.',
            )
        }
        await this.mergeInto(worktree, base, 'Update integrated todo prerequisites')
      }
      return structuredClone(worktree)
    } catch (error) {
      if (signal?.aborted || error instanceof ApplicationError) throw error
      throw gitFailure('Cannot prepare the isolated task workspace.', error)
    }
  }
  private isAncestor(path: string, ancestor: string, descendant: string) {
    return taskGit(path, ['merge-base', '--is-ancestor', ancestor, descendant])
      .then(() => true)
      .catch(() => false)
  }
  async mergeInto(
    worktree: TaskWorktree, incoming: string, label: string,
  ): Promise<CodeSnapshot> {
    await this.verify(worktree)
    await this.assertClean(worktree.path)
    const head = (await taskGit(worktree.path, ['rev-parse', 'HEAD'])).trim()
    if (await this.isAncestor(worktree.path, incoming, head))
      return { head, commit: head }
    let commit = incoming
    if (!await this.isAncestor(worktree.path, head, incoming)) {
      let output: string
      try {
        output = await taskGit(worktree.path, [
          'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, incoming,
        ])
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error
        const paths = String((error as { stdout?: string }).stdout ?? '')
          .split('\0').slice(1).filter(Boolean)
        throw new ApplicationError(
          'AGENT_MERGE_CONFLICT',
          `Agent results conflict: ${paths.join(', ')}`,
          `Code is saved on its agent branch. Resolve the conflict in the agent workspace against ${worktree.branch}, then retry; no merge was started in the result workspace.`,
        )
      }
      const tree = output.split('\0')[0].trim()
      commit = (await taskGit(worktree.path, [
        'commit-tree', tree, '-p', head, '-p', incoming, '-m', label,
      ])).trim()
    }
    await this.assertClean(worktree.path)
    if ((await taskGit(worktree.path, ['rev-parse', 'HEAD'])).trim() !== head)
      throw new Error('The result branch moved during preparation. Retry the operation.')
    await taskGit(worktree.path, ['merge', '--ff-only', '--no-edit', commit])
    return { head, commit }
  }
  async verify(worktree: TaskWorktree, source?: string, checkedOut = true) {
    if (worktree.mode === 'isolated') {
      const root = await realpath(this.appData)
      const owned = worktree.nodeId
        ? [join(root, 'node-worktrees', worktree.projectId, worktree.taskId, worktree.nodeId)]
        : ['task-worktrees', 'task-worktrees-v2'].map((folder) => join(root, folder, worktree.projectId, worktree.taskId))
      if (!owned.includes(resolve(worktree.path)) || !worktree.branch.startsWith('codex/'))
        throw new Error('The saved workspace path or branch does not belong to this agent.')
    }
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
      throw new ApplicationError(
        'TASK_BRANCH_CHANGED',
        'The agent branch or workspace changed during the operation. Restore the saved branch in its workspace and retry.',
        `Expected ${worktree.branch}; the current branch is ${actualBranch || 'a detached checkout'}. After active work stops, use Open in IDE to restore the expected branch in this workspace, then retry the node. Avoid switching branches during an agent run or its checks.`,
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
    if (saveProgress)
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
