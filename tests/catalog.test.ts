import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../src/main/application/catalog-service'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { hashBytes, skillContent } from '../src/main/application/skill-files'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'
import { migrations } from '../src/main/db/migrations'
import {
  ConnectivityService,
  type CodexClient,
} from '../src/main/codex/service'
import { SessionStore } from '../src/main/codex/storage'
import type { ThreadEvent } from '@openai/codex-sdk'
import type { AgentProfile, CatalogSkill } from '../src/shared/catalog'

const roots: string[] = []
const databases: WorkspaceDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-catalog-test-'))
  roots.push(root)
  const appData = join(root, 'app-data')
  const file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database)
  const a = await workspace.createProject({ path: join(root, 'project-a') })
  const b = await workspace.createProject({ path: join(root, 'project-b') })
  const catalog = new CatalogService(database, appData)
  return { root, appData, file, database, workspace, a, b, catalog }
}
const skillInput = (projectId: string | null, name = 'frontend') => ({
  projectId,
  name,
  description: 'Build accessible UI',
  instructions:
    'Read references/proof.txt before answering. Follow the project style.',
})
const profileInput = (projectId: string | null, skillIds: string[] = []) => ({
  projectId,
  name: 'Frontend Master',
  roleInstructions: 'Implement precise accessible interfaces.',
  styleGuide: 'Use concise prose. Prefer semantic HTML.',
  skillIds,
  model: null,
  effort: null,
})
const identity = (item: CatalogSkill | AgentProfile) => ({
  projectId: item.projectId,
  id: item.id,
  expectedRevision: item.revision,
})

describe('scope-aware skill and agent catalogs', () => {
  it('uses saved project defaults for new runs while preserving profile and explicit overrides', async () => {
    const f = await fixture()
    const fields = {
      name: f.a.name,
      description: '',
      instructions: '',
      devCommand: '',
      testCommand: '',
    }
    const project = f.workspace.updateProject({
      ...fields,
      projectId: f.a.id,
      expectedRevision: f.a.revision,
      defaultModel: 'project-model',
      defaultEffort: 'high',
    })
    const input = {
      prompt: 'Run',
      sandbox: 'workspace-write' as const,
      skillIds: [],
    }
    const run = (override = {}) =>
      f.catalog.resolveRun(
        { ...input, ...override },
        f.root,
        randomUUID(),
        f.a.id,
      )
    expect(await run()).toMatchObject({
      model: 'project-model',
      effort: 'high',
      projectSnapshot: { defaultModel: 'project-model', defaultEffort: 'high' },
    })
    const profile = await f.catalog.createProfile({
      ...profileInput(f.a.id),
      model: 'profile-model',
      effort: 'low',
    })
    expect(await run({ profileId: profile.id })).toMatchObject({
      model: 'profile-model',
      effort: 'low',
    })
    expect(
      await run({ profileId: profile.id, model: 'override-model' }),
    ).toMatchObject({ model: 'override-model', effort: undefined })
    expect(await run({ model: null, effort: null })).toMatchObject({
      model: undefined,
      effort: undefined,
    })
    expect(await run({ effort: null })).toMatchObject({
      model: 'project-model',
      effort: undefined,
    })
    f.workspace.updateProject({
      ...fields,
      projectId: f.a.id,
      expectedRevision: project.revision,
      defaultModel: 'next-model',
      defaultEffort: 'medium',
    })
    expect(await run()).toMatchObject({ model: 'next-model', effort: 'medium' })
    expect(
      await f.catalog.resolveRun(input, f.root, randomUUID(), f.b.id),
    ).toMatchObject({ model: undefined, effort: undefined })
  })
  it('can edit an imported UTF-8 BOM document without reporting a false external-change conflict', async () => {
    const { catalog, root } = await fixture()
    const source = join(root, 'bom-skill')
    mkdirSync(source)
    writeFileSync(
      join(source, 'SKILL.md'),
      `\uFEFF${skillContent('bom-skill', 'BOM document', 'Original instructions')}`,
    )
    const skill = await catalog.importSkill({ path: source })
    const document = await catalog.getSkill({ id: skill.id })
    const updated = await catalog.saveSkillFile({
      ...identity(skill),
      file: 'SKILL.md',
      expectedHash: document.hash,
      content: document.content.replace(
        'Original instructions',
        'Updated instructions',
      ),
    })
    expect(updated.revision).toBe(2)
    expect(readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')).toContain(
      'Updated instructions',
    )
  })
  it('exposes a global profile in both projects and keeps same-named local skills and profiles scoped by stable IDs', async () => {
    const { catalog, a, b, appData } = await fixture()
    const global = await catalog.createSkill(skillInput(null))
    const localA = await catalog.createSkill(skillInput(a.id))
    const localB = await catalog.createSkill(skillInput(b.id))
    const shared = await catalog.createProfile(profileInput(null, [global.id]))
    const agentA = await catalog.createProfile(
      profileInput(a.id, [global.id, localA.id]),
    )
    const agentB = await catalog.createProfile(profileInput(b.id, [localB.id]))
    expect(new Set([global.id, localA.id, localB.id]).size).toBe(3)
    expect(global.folderPath).toBe(
      join(realpathSync(appData), 'skills', 'frontend'),
    )
    expect(localA.folderPath).toBe(
      join(a.repoPath, '.agents', 'skills', 'frontend'),
    )
    expect(
      catalog
        .getSnapshot({ projectId: null })
        .profiles.map((profile) => profile.id),
    ).toEqual([shared.id])
    expect(
      catalog
        .getSnapshot({ projectId: a.id })
        .profiles.map((profile) => profile.id),
    ).toEqual(expect.arrayContaining([shared.id, agentA.id]))
    expect(
      catalog
        .getSnapshot({ projectId: b.id })
        .profiles.map((profile) => profile.id),
    ).toEqual(expect.arrayContaining([shared.id, agentB.id]))
    expect(
      catalog.getSnapshot({ projectId: a.id }).skills.map((skill) => skill.id),
    ).not.toContain(localB.id)
    expect(
      catalog
        .getSnapshot({ projectId: b.id })
        .profiles.map((profile) => profile.id),
    ).not.toContain(agentA.id)
  })

  it('rejects cross-project reads, edits, profile references, and run selections outside the selected scope', async () => {
    const { catalog, a, b, root } = await fixture()
    const skill = await catalog.createSkill(skillInput(a.id))
    await expect(
      catalog.getSkill({ projectId: b.id, id: skill.id }),
    ).rejects.toMatchObject({ code: 'SKILL_SCOPE' })
    await expect(
      catalog.saveSkillFile({
        projectId: b.id,
        id: skill.id,
        expectedRevision: 1,
        file: 'SKILL.md',
        expectedHash: skill.contentHash,
        content: skillContent('frontend', 'Keep it', 'Instructions'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_SCOPE' })
    await expect(
      catalog.createProfile(profileInput(null, [skill.id])),
    ).rejects.toMatchObject({ code: 'SKILL_SCOPE' })
    await expect(
      catalog.createProfile(profileInput(b.id, [skill.id])),
    ).rejects.toMatchObject({ code: 'SKILL_SCOPE' })
    await expect(
      catalog.resolveRun(
        { prompt: 'Work', skillIds: [skill.id], sandbox: 'workspace-write' },
        root,
        randomUUID(),
        b.id,
      ),
    ).rejects.toMatchObject({ code: 'SKILL_SCOPE' })
    const profile = await catalog.createProfile(profileInput(a.id, [skill.id]))
    await expect(
      catalog.resolveRun(
        {
          prompt: 'Work',
          profileId: profile.id,
          skillIds: [],
          sandbox: 'workspace-write',
        },
        root,
        randomUUID(),
        b.id,
      ),
    ).rejects.toMatchObject({ code: 'PROFILE_SCOPE' })
  })

  it('imports resource folders, adopts a native project skill without copying over it, and preserves binary assets', async () => {
    const { catalog, root, a } = await fixture()
    const source = join(root, 'import-source')
    mkdirSync(join(source, 'references'), { recursive: true })
    mkdirSync(join(source, 'assets'))
    writeFileSync(
      join(source, 'SKILL.md'),
      skillContent(
        'resource-pack',
        'A resource skill',
        'Read references/proof.txt and assets/icon.bin.',
      ),
    )
    writeFileSync(join(source, 'references', 'proof.txt'), 'CATALOG_PROOF')
    writeFileSync(join(source, 'assets', 'icon.bin'), Buffer.from([0, 255, 7]))
    const imported = await catalog.importSkill({
      projectId: a.id,
      path: source,
    })
    expect(
      readFileSync(join(imported.folderPath, 'assets', 'icon.bin')),
    ).toEqual(Buffer.from([0, 255, 7]))
    const document = await catalog.getSkill({
      projectId: a.id,
      id: imported.id,
    })
    expect(document.files).toContainEqual({
      path: 'assets/icon.bin',
      editable: false,
      size: 3,
    })
    const adopted = await catalog.importSkill({
      projectId: a.id,
      path: imported.folderPath,
    })
    expect(adopted.id).toBe(imported.id)
    expect(catalog.getSnapshot({ projectId: a.id }).skills).toHaveLength(1)
    expect(readFileSync(join(source, 'references', 'proof.txt'), 'utf8')).toBe(
      'CATALOG_PROOF',
    )
  })

  it('edits SKILL.md and new resources with revision and external-file change protection', async () => {
    const { catalog } = await fixture()
    const skill = await catalog.createSkill(skillInput(null))
    const document = await catalog.getSkill({ id: skill.id })
    const updated = await catalog.saveSkillFile({
      ...identity(skill),
      file: 'SKILL.md',
      expectedHash: document.hash,
      content: skillContent(
        'renamed-skill',
        'Updated description',
        'Updated instructions',
      ),
    })
    expect(updated).toMatchObject({
      id: skill.id,
      name: 'renamed-skill',
      description: 'Updated description',
      folderPath: skill.folderPath,
    })
    await expect(
      catalog.saveSkillFile({
        ...identity(skill),
        file: 'SKILL.md',
        expectedHash: document.hash,
        content: document.content,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    const withResource = await catalog.saveSkillFile({
      ...identity(updated),
      file: 'references/new.md',
      expectedHash: null,
      content: 'New resource',
    })
    expect(
      await catalog.readSkillFile({ id: skill.id, file: 'references/new.md' }),
    ).toEqual({ content: 'New resource', hash: hashBytes('New resource') })
    writeFileSync(
      join(skill.folderPath, 'SKILL.md'),
      skillContent(
        'renamed-skill',
        'External description',
        'External instructions',
      ),
    )
    await expect(
      catalog.saveSkillFile({
        ...identity(withResource),
        file: 'SKILL.md',
        expectedHash: updated.contentHash,
        content: document.content,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_CHANGED' })
    expect(readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')).toContain(
      'External description',
    )
  })

  it('keeps malformed externally edited SKILL.md repairable while blocking invalid imports and symlink escapes', async () => {
    const { catalog, root } = await fixture()
    const skill = await catalog.createSkill(skillInput(null))
    writeFileSync(join(skill.folderPath, 'SKILL.md'), 'Broken metadata')
    const broken = await catalog.getSkill({ id: skill.id })
    expect(broken.content).toBe('Broken metadata')
    await catalog.saveSkillFile({
      ...identity(skill),
      file: 'SKILL.md',
      expectedHash: broken.hash,
      content: skillContent('frontend', 'Fixed metadata', 'Fixed instructions'),
    })
    const source = join(root, 'bad-import')
    mkdirSync(source)
    writeFileSync(join(source, 'SKILL.md'), 'not a skill')
    await expect(catalog.importSkill({ path: source })).rejects.toMatchObject({
      code: 'SKILL_FORMAT',
    })
    writeFileSync(
      join(source, 'SKILL.md'),
      skillContent('bad-import', 'Test links', 'Use resources'),
    )
    symlinkSync(join(skill.folderPath, 'SKILL.md'), join(source, 'linked.md'))
    await expect(catalog.importSkill({ path: source })).rejects.toMatchObject({
      code: 'SKILL_LINK',
    })
    expect(() =>
      catalog.saveSkillFile({
        ...identity(skill),
        file: '../escape.md',
        expectedHash: null,
        content: 'escape',
      }),
    ).toThrow()
  })

  it('removes and restores items without deleting files and blocks removing a skill used by an active profile', async () => {
    const { catalog } = await fixture()
    const skill = await catalog.createSkill(skillInput(null))
    const profile = await catalog.createProfile(profileInput(null, [skill.id]))
    await expect(
      catalog.setSkillActive({ ...identity(skill), active: false }),
    ).rejects.toMatchObject({ code: 'SKILL_IN_USE' })
    const inactiveProfile = await catalog.setProfileActive({
      ...identity(profile),
      active: false,
    })
    const inactiveSkill = await catalog.setSkillActive({
      ...identity(skill),
      active: false,
    })
    expect(existsSync(join(skill.folderPath, 'SKILL.md'))).toBe(true)
    expect(inactiveSkill.removedAt).toEqual(expect.any(String))
    await expect(
      catalog.setProfileActive({ ...identity(inactiveProfile), active: true }),
    ).rejects.toMatchObject({ code: 'SKILL_REMOVED' })
    await catalog.setSkillActive({ ...identity(inactiveSkill), active: true })
    expect(
      (
        await catalog.setProfileActive({
          ...identity(inactiveProfile),
          active: true,
        })
      ).removedAt,
    ).toBe(null)
  })

  it('keeps text edits within the byte limit and restores the original file when a database write fails', async () => {
    const { catalog, database } = await fixture()
    await expect(
      catalog.createSkill({
        ...skillInput(null),
        instructions: '界'.repeat(90_000),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_SIZE' })
    const skill = await catalog.createSkill(skillInput(null))
    const original = readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')
    database.sqlite.pragma('query_only = ON')
    try {
      await expect(
        catalog.saveSkillFile({
          ...identity(skill),
          file: 'SKILL.md',
          expectedHash: skill.contentHash,
          content: skillContent('frontend', 'Changed', 'Changed instructions'),
        }),
      ).rejects.toThrow()
      expect(readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')).toBe(
        original,
      )
    } finally {
      database.sqlite.pragma('query_only = OFF')
    }
    expect((await catalog.getSkill({ id: skill.id })).skill.revision).toBe(1)
  })

  it('persists style guides and profile edits across SQLite reopen and snapshots exact skill resources independently of later edits', async () => {
    const { catalog, database, file, appData, root, a } = await fixture()
    let skill = await catalog.createSkill(skillInput(a.id))
    skill = await catalog.saveSkillFile({
      ...identity(skill),
      file: 'references/proof.txt',
      expectedHash: null,
      content: 'ORIGINAL_RESOURCE',
    })
    let profile = await catalog.createProfile(profileInput(null))
    profile = await catalog.updateProfile({
      ...identity(profile),
      ...profileInput(null),
      name: 'Shared Architect',
      styleGuide: 'Use approved design tokens.',
    })
    const localProfile = await catalog.createProfile(
      profileInput(a.id, [skill.id]),
    )
    const workspace = join(root, 'scratch')
    mkdirSync(workspace)
    const prepared = await catalog.resolveRun(
      {
        prompt: 'Run',
        profileId: localProfile.id,
        skillIds: [skill.id],
        sandbox: 'workspace-write',
      },
      workspace,
      randomUUID(),
      a.id,
    )
    expect(prepared.skillSnapshots).toHaveLength(1)
    const saved = prepared.skillSnapshots[0]
    expect(
      readFileSync(join(saved.archivePath!, 'references/proof.txt'), 'utf8'),
    ).toBe('ORIGINAL_RESOURCE')
    writeFileSync(
      join(skill.folderPath, 'references/proof.txt'),
      'LATER_RESOURCE',
    )
    expect(
      readFileSync(join(saved.path, '..', 'references/proof.txt'), 'utf8'),
    ).toBe('ORIGINAL_RESOURCE')
    database.close()
    const reopened = openWorkspaceDatabase(file)
    databases.push(reopened)
    const restored = new CatalogService(reopened, appData)
    expect(
      restored.getSnapshot({}).profiles.find((item) => item.id === profile.id)
        ?.styleGuide,
    ).toBe('Use approved design tokens.')
    expect(
      restored
        .getSnapshot({ projectId: a.id })
        .skills.find((item) => item.id === skill.id)?.id,
    ).toBe(skill.id)
  })

  it('passes resolved role, style, skill content, project brief, and staged resource paths to the SDK adapter and saves them across restart', async () => {
    const { catalog, root, a } = await fixture()
    let skill = await catalog.createSkill(skillInput(a.id))
    skill = await catalog.saveSkillFile({
      ...identity(skill),
      file: 'references/proof.txt',
      expectedHash: null,
      content: 'SDK_RESOURCE_PROOF',
    })
    const profile = await catalog.createProfile(profileInput(a.id, [skill.id]))
    let prompt = ''
    const client: CodexClient = {
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input
          return {
            events: (async function* (): AsyncGenerator<ThreadEvent> {
              yield { type: 'thread.started', thread_id: 'catalog-thread' }
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
      }),
      resumeThread: () => {
        throw new Error('Not expected')
      },
    }
    const store = new SessionStore(join(root, 'lab-state'))
    const service = new ConnectivityService(store, client, (...args) =>
      catalog.resolveRun(...args),
    )
    await service.initialize()
    roots.push(service.snapshot().session.workspace)
    await service.newSession(a.id)
    roots.push(service.snapshot().session.workspace)
    await service.start({
      prompt: 'Implement a component',
      profileId: profile.id,
      skillIds: [],
      sandbox: 'read-only',
    })
    await service.waitForIdle()
    const run = service.snapshot().session.runs[0]
    expect(run.status).toBe('completed')
    expect(prompt).toContain(profile.roleInstructions)
    expect(prompt).toContain(profile.styleGuide)
    expect(prompt).toContain('Project brief: project-a')
    expect(prompt).toContain(run.skillSnapshots[0].path)
    expect(
      readFileSync(
        join(run.skillSnapshots[0].path, '..', 'references/proof.txt'),
        'utf8',
      ),
    ).toBe('SDK_RESOURCE_PROOF')
    expect((await store.read())!.runs[0].profileSnapshot?.id).toBe(profile.id)
    expect((await store.read())!.projectId).toBe(a.id)
  })

  it('resolves profile defaults and explicit overrides and rejects unsupported model/effort combinations on save', async () => {
    const { database, appData, root } = await fixture()
    const catalog = new CatalogService(database, appData, () => [
      {
        id: 'account-model',
        name: 'Account model',
        isDefault: true,
        efforts: ['low', 'high'],
        defaultEffort: 'low',
      },
    ])
    const profile = await catalog.createProfile({
      ...profileInput(null),
      model: 'account-model',
      effort: 'high',
    })
    const base = {
      prompt: 'Run',
      profileId: profile.id,
      skillIds: [],
      sandbox: 'read-only' as const,
    }
    expect(await catalog.resolveRun(base, root, randomUUID())).toMatchObject({
      model: 'account-model',
      effort: 'high',
    })
    expect(
      await catalog.resolveRun(
        { ...base, model: null, effort: null },
        root,
        randomUUID(),
      ),
    ).toMatchObject({ model: undefined, effort: undefined })
    await expect(
      catalog.createProfile({
        ...profileInput(null),
        model: 'account-model',
        effort: 'ultra',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_OPTIONS' })
    await expect(
      catalog.createProfile({ ...profileInput(null), effort: 'high' }),
    ).rejects.toMatchObject({ code: 'MODEL_OPTIONS' })
  })

  it('upgrades an existing milestone-2 database without editing its migration or losing projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'constella-migration-test-'))
    roots.push(root)
    const file = join(root, 'workspace.sqlite')
    const original = new Database(file)
    original.exec(migrations[0].sql)
    original.exec(
      'CREATE TABLE app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    original
      .prepare('INSERT INTO app_schema_migrations VALUES (?, ?, ?, ?)')
      .run(
        1,
        migrations[0].name,
        createHash('sha256').update(migrations[0].sql).digest('hex'),
        new Date().toISOString(),
      )
    const id = randomUUID()
    original
      .prepare(
        'INSERT INTO projects (id, repo_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, root, 'Existing project', 'before', 'before')
    original.close()
    const database = openWorkspaceDatabase(file)
    databases.push(database)
    expect(
      database.sqlite.prepare('SELECT name FROM projects WHERE id = ?').get(id),
    ).toEqual({ name: 'Existing project' })
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS n FROM app_schema_migrations')
        .get(),
    ).toEqual({ n: migrations.length })
  })
})
