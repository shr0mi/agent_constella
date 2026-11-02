import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../src/main/application/workspace-service'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import type { Task } from '../src/shared/workspace'
import { migrations } from '../src/main/db/migrations'

const directories: string[] = []
const databases: WorkspaceDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  directories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-workspace-test-'))
  directories.push(root)
  const file = join(root, 'metadata', 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const service = new WorkspaceService(database)
  const repository = (name: string) => {
    const path = join(root, name)
    mkdirSync(path)
    execFileSync('git', ['init', '--quiet', path])
    return path
  }
  return { root, file, database, service, repository }
}
const identity = (task: Task) => ({
  projectId: task.projectId,
  taskId: task.id,
  expectedRevision: task.revision,
})

describe('persistent project application service', () => {
  it('opens the saved original project location with its IDE command without changing workspace state', async () => {
    const f = fixture()
    const project = await f.service.openRepository({ path: f.repository('ide-project') })
    const launch = vi.fn().mockResolvedValue(undefined)
    await expect(f.service.openInIde({ projectId: project.id }, launch))
      .rejects.toMatchObject({ code: 'IDE_COMMAND' })
    expect(launch).not.toHaveBeenCalled()
    f.service.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name: project.name,
      description: '',
      instructions: '',
      devCommand: '',
      testCommand: '',
      ideCommand: 'zed --new',
    })
    const before = f.service.getSnapshot()
    await f.service.openInIde({ projectId: project.id }, launch)
    expect(launch).toHaveBeenCalledExactlyOnceWith('zed --new', project.repoPath)
    expect(f.service.getSnapshot()).toEqual(before)
    await expect(f.service.openInIde({ projectId: project.id, path: '/tmp/other' }, launch))
      .rejects.toThrow()
    await expect(f.service.openInIde({ projectId: randomUUID() }, launch))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    expect(launch).toHaveBeenCalledOnce()
  })
  it('validates project default model/effort and preserves defaults when older callers omit them', async () => {
    const f = fixture()
    const service = new WorkspaceService(f.database, () => [
      {
        id: 'fixture-model',
        name: 'Fixture',
        isDefault: true,
        efforts: ['low', 'high'],
      },
    ])
    const project = await service.openRepository({
      path: f.repository('defaults'),
    })
    const fields = {
      name: project.name,
      description: '',
      instructions: '',
      devCommand: '',
      testCommand: '',
    }
    const input = {
      ...fields,
      projectId: project.id,
      expectedRevision: project.revision,
    }
    expect(project).toMatchObject({ defaultProvider: 'codex', defaultModel: null, defaultEffort: null })
    expect(() =>
      service.updateProject({
        ...input,
        defaultModel: null,
        defaultEffort: 'high',
      }),
    ).toThrow('Choose a default model')
    expect(() =>
      service.updateProject({
        ...input,
        defaultModel: 'fixture-model',
        defaultEffort: 'ultra',
      }),
    ).toThrow('not supported')
    expect(() =>
      service.updateProject({
        ...input,
        defaultModel: 'unknown-model',
        defaultEffort: null,
      }),
    ).toThrow('not supported')
    const saved = service.updateProject({
      ...input,
      defaultProvider: 'claude',
      defaultModel: 'fixture-model',
      defaultEffort: 'high',
    })
    const renamed = service.updateProject({
      ...input,
      expectedRevision: saved.revision,
      name: 'Renamed',
    })
    expect(renamed).toMatchObject({
      defaultProvider: 'claude',
      defaultModel: 'fixture-model',
      defaultEffort: 'high',
      repoPath: project.repoPath,
    })
    expect(() => service.updateProject(input)).toThrow(
      'changed after it was opened',
    )
  })
  it('keeps two project boards independent and retains settings, tasks, ordering, and archive state after reopening SQLite', async () => {
    const { service, repository, database, file } = fixture()
    const a = await service.openRepository({ path: repository('project-a') })
    const b = await service.openRepository({ path: repository('project-b') })
    const settings = {
      projectId: a.id,
      expectedRevision: a.revision,
      name: 'Project A',
      ideCommand: 'zed',
      maxParallelAgents: 3,
      description: 'A detailed brief',
      instructions: 'Follow repository conventions',
      devCommand: 'npm run dev',
      testCommand: 'npm test',
      defaultModel: 'fixture-model',
      defaultEffort: 'high' as const,
    }
    service.updateProject(settings)
    const first = service.createTask({
      projectId: a.id,
      title: 'First task',
      description: 'Implementation',
      acceptanceCriteria: 'Tests pass',
    })
    const second = service.createTask({ projectId: a.id, title: 'Second task', dependencyIds: [first.id], requiredFiles: ['project_plan.md'] })
    const other = service.createTask({
      projectId: b.id,
      title: 'Independent task',
      status: 'todo',
    })
    const moved = service.moveTask({ ...identity(first), status: 'doing' })
    service.archiveTask({ ...identity(moved) })
    const edited = service.updateTask({
      ...identity(
        service
          .getBoard({ projectId: a.id })
          .tasks.find((task) => task.id === second.id)!,
      ),
      title: 'Edited task',
      description: 'Saved details',
      acceptanceCriteria: 'Saved acceptance criteria',
    })
    const revision = service.getSnapshot().revision
    database.close()
    const reopened = openWorkspaceDatabase(file)
    databases.push(reopened)
    const restored = new WorkspaceService(reopened)
    const boardA = restored.getBoard({ projectId: a.id })
    const boardB = restored.getBoard({ projectId: b.id })
    expect(boardA.project).toMatchObject({
      name: settings.name,
      description: settings.description,
      instructions: settings.instructions,
      devCommand: settings.devCommand,
      testCommand: settings.testCommand,
      defaultModel: settings.defaultModel,
      defaultEffort: settings.defaultEffort,
    })
    expect(boardA.tasks).toHaveLength(2)
    expect(boardA.tasks.find((task) => task.id === edited.id)).toMatchObject({
      title: 'Edited task',
      acceptanceCriteria: 'Saved acceptance criteria',
    })
    expect(boardA.tasks.find((task) => task.id === first.id)).toMatchObject({
      status: 'doing',
      archivedAt: expect.any(String),
    })
    expect(boardB.tasks.map((task) => task.id)).toEqual([other.id])
    expect(restored.getSnapshot().revision).toBe(revision)
    expect(
      reopened.sqlite
        .prepare('SELECT COUNT(*) AS n FROM app_schema_migrations')
        .get(),
    ).toEqual({ n: migrations.length })
    expect(readFileSync(file).subarray(0, 15).toString()).toBe(
      'SQLite format 3',
    )
  })

  it('resolves subfolders, symlinks, and Git worktrees without creating duplicate projects', async () => {
    const { service, repository, root } = fixture()
    const path = repository('repo')
    const nested = join(path, 'nested')
    mkdirSync(nested)
    const first = await service.openRepository({ path: nested })
    expect((await service.openRepository({ path })).id).toBe(first.id)
    const alias = join(root, 'alias')
    symlinkSync(path, alias, 'dir')
    expect((await service.openRepository({ path: alias })).id).toBe(first.id)
    execFileSync('git', [
      '-C',
      path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ])
    const worktree = join(root, 'worktree')
    execFileSync('git', [
      '-C',
      path,
      'worktree',
      'add',
      '--detach',
      '--quiet',
      worktree,
    ])
    const second = await service.openRepository({ path: worktree })
    expect(second.id).not.toBe(first.id)
    expect(service.getSnapshot().projects).toHaveLength(2)
  })

  it('rejects non-repositories and bare repositories without adding projects', async () => {
    const { service, root } = fixture()
    await expect(service.openRepository({ path: root })).rejects.toMatchObject({
      code: 'NOT_A_REPOSITORY',
    })
    const bare = join(root, 'bare.git')
    execFileSync('git', ['init', '--bare', '--quiet', bare])
    await expect(service.openRepository({ path: bare })).rejects.toMatchObject({
      code: 'BARE_REPOSITORY',
    })
    expect(service.getSnapshot().projects).toEqual([])
  })

  it('creates a new folder and main-branch Git repository, then restores its project after database reopen', async () => {
    const { service, root, database, file } = fixture()
    const path = join(root, 'new-project')
    const project = await service.createProject({ path })
    expect(project.name).toBe('new-project')
    expect(
      execFileSync('git', ['-C', path, 'symbolic-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('refs/heads/main')
    expect(
      execFileSync('git', ['-C', path, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
    ).toBe('')
    expect(
      execFileSync('git', ['-C', path, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1')
    expect(
      execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('Initialize AgentConstella project')
    expect(
      execFileSync('git', ['-C', path, 'ls-tree', '-r', 'HEAD'], {
        encoding: 'utf8',
      }),
    ).toBe('')
    expect((await service.openFolder({ path })).id).toBe(project.id)
    database.close()
    const reopened = openWorkspaceDatabase(file)
    databases.push(reopened)
    expect(
      new WorkspaceService(reopened).getBoard({ projectId: project.id })
        .project,
    ).toEqual(project)
  })

  it('creates a common initial commit without committing existing staged/untracked files or running user hooks', async () => {
    const { service, repository } = fixture(),
      path = repository('unborn')
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
    const branch = git('symbolic-ref', 'HEAD')
    writeFileSync(join(path, 'staged.txt'), 'staged version')
    git('add', 'staged.txt')
    writeFileSync(join(path, 'staged.txt'), 'working version')
    writeFileSync(join(path, 'untracked.txt'), 'keep untracked')
    writeFileSync(
      join(path, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(path, '.git', 'hooks', 'reference-transaction'),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    )
    git('config', 'commit.gpgSign', 'true')
    git('config', 'gpg.program', '/missing-signing-program')
    const index = readFileSync(join(path, '.git', 'index'))
    const project = await service.openFolder({ path })
    expect(readFileSync(join(path, '.git', 'index'))).toEqual(index)
    expect(readFileSync(join(path, 'staged.txt'), 'utf8')).toBe(
      'working version',
    )
    expect(readFileSync(join(path, 'untracked.txt'), 'utf8')).toBe(
      'keep untracked',
    )
    expect(git('symbolic-ref', 'HEAD')).toBe(branch)
    expect(git('ls-tree', '-r', 'HEAD')).toBe('')
    expect(git('show', ':staged.txt')).toBe('staged version')
    expect(git('log', '-1', '--format=%an <%ae>')).toBe(
      'AgentConstella <constella@localhost>',
    )
    const head = git('rev-parse', 'HEAD')
    expect((await service.openRepository({ path })).id).toBe(project.id)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('shares one initial commit when an unborn repository is opened concurrently', async () => {
    const { service, repository } = fixture(),
      path = repository('parallel-open')
    const [a, b] = await Promise.all([
      service.openFolder({ path }),
      service.openRepository({ path }),
    ])
    expect(a.id).toBe(b.id)
    expect(
      execFileSync('git', ['-C', path, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1')
  })

  it('preserves a failed initialization and can retry after a branch lock is removed', async () => {
    const { service, repository } = fixture(),
      path = repository('locked')
    const branch = execFileSync('git', ['-C', path, 'symbolic-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const lock = join(path, '.git', `${branch}.lock`)
    writeFileSync(lock, 'external lock')
    writeFileSync(join(path, 'keep.txt'), 'Keep these files')
    await expect(service.openFolder({ path })).rejects.toMatchObject({
      code: 'GIT_INITIAL_COMMIT_FAILED',
    })
    expect(service.getSnapshot().projects).toEqual([])
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe(
      'Keep these files',
    )
    rmSync(lock)
    const project = await service.openFolder({ path })
    expect(project.repoPath).toBe(realpathSync(path))
    expect(
      execFileSync('git', ['-C', path, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1')
  })

  it('initializes an existing non-Git folder while preserving its files and reuses existing repositories', async () => {
    const { service, root, repository } = fixture()
    const path = join(root, 'existing-files')
    mkdirSync(path)
    writeFileSync(join(path, 'notes.txt'), 'Keep these project notes')
    const project = await service.openFolder({ path })
    expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe(
      'Keep these project notes',
    )
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect((await service.openRepository({ path })).id).toBe(project.id)
    const original = repository('original')
    const originalHead = readFileSync(join(original, '.git', 'HEAD'), 'utf8')
    const existing = await service.openRepository({ path: original })
    expect((await service.openFolder({ path: original })).id).toBe(existing.id)
    expect(readFileSync(join(original, '.git', 'HEAD'), 'utf8')).toBe(
      originalHead,
    )
  })

  it('never overwrites an existing project destination and does not register failed folder creations', async () => {
    const { service, root } = fixture()
    const existing = join(root, 'already-here')
    mkdirSync(existing)
    writeFileSync(join(existing, 'keep.txt'), 'Keep me')
    await expect(
      service.createProject({ path: existing }),
    ).rejects.toMatchObject({ code: 'PROJECT_FOLDER_EXISTS' })
    expect(readFileSync(join(existing, 'keep.txt'), 'utf8')).toBe('Keep me')
    expect(existsSync(join(existing, '.git'))).toBe(false)
    const file = join(root, 'existing-file')
    writeFileSync(file, 'Original file')
    await expect(service.createProject({ path: file })).rejects.toMatchObject({
      code: 'PROJECT_FOLDER_EXISTS',
    })
    expect(readFileSync(file, 'utf8')).toBe('Original file')
    await expect(
      service.createProject({ path: join(root, 'missing-parent', 'project') }),
    ).rejects.toMatchObject({ code: 'PROJECT_FOLDER_CREATE' })
    expect(service.getSnapshot().projects).toHaveLength(0)
  })

  it('refuses broken Git metadata and bare repositories when opening project folders', async () => {
    const { service, root } = fixture()
    const broken = join(root, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, '.git'), 'Original broken metadata')
    await expect(service.openFolder({ path: broken })).rejects.toMatchObject({
      code: 'REPOSITORY_ACCESS',
    })
    expect(readFileSync(join(broken, '.git'), 'utf8')).toBe(
      'Original broken metadata',
    )
    const bare = join(root, 'bare.git')
    execFileSync('git', ['init', '--bare', '--quiet', bare])
    await expect(service.openFolder({ path: bare })).rejects.toMatchObject({
      code: 'BARE_REPOSITORY',
    })
    expect(existsSync(join(bare, '.git'))).toBe(false)
    expect(service.getSnapshot().projects).toHaveLength(0)
  })

  it('reports missing Git before creating a new project folder', async () => {
    const { service, root } = fixture()
    const path = join(root, 'no-git-project')
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(service.createProject({ path })).rejects.toMatchObject({
        code: 'GIT_UNAVAILABLE',
      })
      expect(existsSync(path)).toBe(false)
      expect(service.getSnapshot().projects).toHaveLength(0)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('retains the created folder and Git repository if database registration fails', async () => {
    const { service, root, database, file } = fixture()
    const path = join(root, 'recoverable-project')
    database.close()
    await expect(service.createProject({ path })).rejects.toMatchObject({
      code: 'PROJECT_REGISTRATION',
    })
    expect(existsSync(join(path, '.git'))).toBe(true)
    const reopened = openWorkspaceDatabase(file)
    databases.push(reopened)
    const recovered = await new WorkspaceService(reopened).openFolder({ path })
    expect(recovered.name).toBe('recoverable-project')
  })

  it('scopes reads, edits, moves, archives, and restores to the task project', async () => {
    const { service, repository } = fixture()
    const a = await service.openRepository({ path: repository('a') })
    const b = await service.openRepository({ path: repository('b') })
    const task = service.createTask({ projectId: a.id, title: 'Owned by A' })
    const wrong = { ...identity(task), projectId: b.id }
    expect(() =>
      service.updateTask({
        ...wrong,
        title: 'Overwrite',
        description: '',
        acceptanceCriteria: '',
      }),
    ).toThrow('selected project')
    expect(() => service.moveTask({ ...wrong, status: 'done' })).toThrow(
      'selected project',
    )
    expect(() => service.archiveTask(wrong)).toThrow('selected project')
    expect(() => service.restoreTask(wrong)).toThrow('selected project')
    expect(service.getBoard({ projectId: b.id }).tasks).toEqual([])
    expect(service.getBoard({ projectId: a.id }).tasks[0].title).toBe(
      'Owned by A',
    )
  })

  it('maintains dense ordering across reorder, column moves, archive, and restore', async () => {
    const { service, repository } = fixture()
    const project = await service.openRepository({ path: repository('repo') })
    const tasks = ['one', 'two', 'three'].map((title) =>
      service.createTask({ projectId: project.id, title }),
    )
    const current = (id: string) =>
      service
        .getBoard({ projectId: project.id })
        .tasks.find((task) => task.id === id)!
    const column = (status = 'todo') =>
      service
        .getBoard({ projectId: project.id })
        .tasks.filter((task) => !task.archivedAt && task.status === status)
        .sort((a, b) => a.position - b.position)
    service.moveTask({
      ...identity(tasks[2]),
      status: 'todo',
      beforeTaskId: tasks[0].id,
    })
    expect(column().map((task) => task.title)).toEqual(['three', 'one', 'two'])
    service.moveTask({ ...identity(current(tasks[0].id)), status: 'doing' })
    expect(column().map((task) => task.position)).toEqual([0, 1])
    expect(column('doing').map((task) => task.title)).toEqual(['one'])
    const archived = service.archiveTask(identity(current(tasks[2].id)))
    expect(column().map((task) => task.position)).toEqual([0])
    service.restoreTask(identity(archived))
    expect(column().map((task) => task.title)).toEqual(['two', 'three'])
    expect(column().map((task) => task.position)).toEqual([0, 1])
  })

  it('rolls back invalid destination moves and rejects stale updates without changing state', async () => {
    const { service, repository } = fixture()
    const a = await service.openRepository({ path: repository('a') })
    const b = await service.openRepository({ path: repository('b') })
    const task = service.createTask({ projectId: a.id, title: 'Original' })
    const other = service.createTask({ projectId: b.id, title: 'Destination' })
    const before = service.getSnapshot()
    expect(() =>
      service.moveTask({
        ...identity(task),
        status: 'todo',
        beforeTaskId: other.id,
      }),
    ).toThrow('destination task')
    expect(service.getSnapshot()).toEqual(before)
    service.updateTask({
      ...identity(task),
      title: 'Updated',
      description: '',
      acceptanceCriteria: '',
    })
    expect(() =>
      service.updateTask({
        ...identity(task),
        title: 'Stale overwrite',
        description: '',
        acceptanceCriteria: '',
      }),
    ).toThrow('changed after')
    expect(service.getBoard({ projectId: a.id }).tasks[0].title).toBe('Updated')
    expect(() =>
      service.createTask({ projectId: randomUUID(), title: 'Orphan' }),
    ).toThrow('project no longer exists')
  })

  it('keeps archived task contents and rejects edits until restore', async () => {
    const { service, repository } = fixture()
    const project = await service.openRepository({ path: repository('repo') })
    const task = service.createTask({
      projectId: project.id,
      title: 'Keep me',
      acceptanceCriteria: 'Still here',
    })
    const archived = service.archiveTask(identity(task))
    expect(() =>
      service.updateTask({
        ...identity(archived),
        title: 'Lost',
        description: '',
        acceptanceCriteria: '',
      }),
    ).toThrow('archived')
    expect(() =>
      service.moveTask({ ...identity(archived), status: 'doing' }),
    ).toThrow('archived')
    const restored = service.restoreTask(identity(archived))
    expect(restored).toMatchObject({
      title: 'Keep me',
      acceptanceCriteria: 'Still here',
      archivedAt: null,
      status: 'todo',
    })
  })

  it('notifies subscribers after commits and validates direct service callers', async () => {
    const { service, repository } = fixture()
    const listener = vi.fn()
    const unsubscribe = service.subscribe(listener)
    const project = await service.openRepository({ path: repository('repo') })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].projects[0].id).toBe(project.id)
    expect(() =>
      service.createTask({
        projectId: project.id,
        title: ' ',
        command: 'anything',
      }),
    ).toThrow()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    service.createTask({ projectId: project.id, title: 'Valid' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('preserves existing data when a migration checksum or future schema version is incompatible', async () => {
    const { service, repository, database, file } = fixture()
    const project = await service.openRepository({ path: repository('repo') })
    database.sqlite
      .prepare(
        'UPDATE app_schema_migrations SET checksum = ? WHERE version = 1',
      )
      .run('changed')
    expect(() => openWorkspaceDatabase(file)).toThrow('migration 1 has changed')
    expect(service.getBoard({ projectId: project.id }).project.id).toBe(
      project.id,
    )
    database.sqlite
      .prepare(
        'INSERT INTO app_schema_migrations (version, name, checksum, applied_at) VALUES (99, ?, ?, ?)',
      )
      .run('future', 'hash', new Date().toISOString())
    expect(() => openWorkspaceDatabase(file)).toThrow('newer version')
    expect(service.getSnapshot().projects).toHaveLength(1)
  })

  it('rejects stale project settings and saves command text without executing it', async () => {
    const { service, repository, root } = fixture()
    const project = await service.openRepository({ path: repository('repo') })
    const fields = {
      projectId: project.id,
      expectedRevision: project.revision,
      name: 'Updated project',
      description: 'Saved brief',
      instructions: 'Saved instructions',
      devCommand: `touch ${join(root, 'must-not-run')}`,
      testCommand: 'exit 123',
    }
    const saved = service.updateProject(fields)
    expect(saved).toMatchObject({
      devCommand: fields.devCommand,
      testCommand: fields.testCommand,
      revision: 2,
    })
    expect(() =>
      service.updateProject({ ...fields, name: 'Stale project' }),
    ).toThrow('changed after')
    expect(() => readFileSync(join(root, 'must-not-run'))).toThrow()
    expect(service.getBoard({ projectId: project.id }).project.name).toBe(
      'Updated project',
    )
  })

  it('keeps a committed command successful even if a notification listener fails', async () => {
    const { service, repository } = fixture()
    const project = await service.openRepository({ path: repository('repo') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribe = service.subscribe(() => {
      throw new Error('closed renderer')
    })
    try {
      const task = service.createTask({
        projectId: project.id,
        title: 'Committed once',
      })
      expect(
        service.getBoard({ projectId: project.id }).tasks.map((row) => row.id),
      ).toEqual([task.id])
      expect(log).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
      log.mockRestore()
    }
  })
})
