import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { WorkspaceService } from '../src/main/application/workspace-service'
import {
  starterProfiles,
  starterSkills,
} from '../src/main/application/starter-catalog'
import { parseSkill, skillContent } from '../src/main/application/skill-files'
import {
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../src/main/db/database'

const roots: string[] = [],
  databases: WorkspaceDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.sqlite.open) database.close()
  })
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'constella-starters-'))
  roots.push(root)
  const appData = join(root, 'app'),
    file = join(appData, 'workspace.sqlite')
  const database = openWorkspaceDatabase(file)
  databases.push(database)
  const workspace = new WorkspaceService(database)
  const a = await workspace.createProject({ path: join(root, 'alpha') })
  const b = await workspace.createProject({ path: join(root, 'beta') })
  const catalog = new CatalogService(database, appData)
  return { root, appData, file, database, workspace, a, b, catalog }
}
async function installLegacy(f: Awaited<ReturnType<typeof fixture>>) {
  const legacy = JSON.parse(
    readFileSync(
      new URL('./fixtures/legacy-starters.json', import.meta.url),
      'utf8',
    ),
  ) as {
    skills: {
      id: string
      name: string
      description: string
      instructions: string
    }[]
    profiles: {
      id: string
      name: string
      roleInstructions: string
      styleGuide: string
      skillIds: string[]
    }[]
  }
  for (const skill of legacy.skills) {
    const item = await f.catalog.createSkill({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    })
    f.database.sqlite
      .prepare('UPDATE catalog_skills SET id = ? WHERE id = ?')
      .run(skill.id, item.id)
  }
  for (const profile of legacy.profiles) {
    const item = await f.catalog.createProfile({
      name: profile.name,
      roleInstructions: profile.roleInstructions,
      styleGuide: profile.styleGuide,
      skillIds: profile.skillIds,
      model: null,
      effort: null,
    })
    f.database.sqlite
      .prepare('UPDATE agent_profiles SET id = ? WHERE id = ?')
      .run(profile.id, item.id)
  }
  return legacy
}

describe('bundled starter catalog', () => {
  it('installs valid global skills and profiles once, resolves their skills, and leaves Default Codex skill-free', async () => {
    const f = await fixture()
    await Promise.all([f.catalog.initialize(), f.catalog.initialize()])
    const global = f.catalog.getSnapshot({ projectId: null })
    expect(global.skills).toHaveLength(4)
    expect(global.profiles.map((profile) => profile.name).sort()).toEqual([
      'backend-sensei',
      'frontend-master',
    ])
    for (const skill of global.skills) {
      expect(skill.projectId).toBeNull()
      const document = await f.catalog.getSkill({ id: skill.id })
      expect(parseSkill(document.content).name).toBe(skill.name)
      expect(readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')).toBe(
        document.content,
      )
      const source = starterSkills.find((source) => source.id === skill.id)!
      expect(skill.source).toMatchObject({
        repository: source.repository,
        revision: source.revision,
        license: source.license,
      })
      for (const [file, expected] of Object.entries(source.upstreamFiles))
        expect(
          createHash('sha256')
            .update(readFileSync(join(skill.folderPath, file)))
            .digest('hex'),
        ).toBe(expected)
      expect(document.files.some((file) => file.path === 'SOURCE.md')).toBe(
        true,
      )
      expect(
        document.files.some((file) => file.path.startsWith('LICENSE')),
      ).toBe(true)
    }
    for (const project of [f.a, f.b]) {
      expect(
        f.catalog
          .getSnapshot({ projectId: project.id })
          .profiles.map((profile) => profile.id)
          .sort(),
      ).toEqual(global.profiles.map((profile) => profile.id).sort())
      expect(existsSync(join(project.repoPath, '.agents'))).toBe(false)
    }
    const task = f.workspace.createTask({
      projectId: f.a.id,
      title: 'Default task',
    })
    const graphs = new GraphService(f.database, f.catalog)
    const node = graphs
      .get({ projectId: f.a.id, taskId: task.id })
      .document.nodes.find((node) => node.type === 'agent')!
    expect(node.data).toMatchObject({ profileId: null, skillIds: [] })
    const input = {
      prompt: 'Work',
      skillIds: [],
    }
    expect(
      (
        await f.catalog.resolveRun(input, f.a.repoPath, randomUUID(), f.a.id, {
          stageInWorkspace: false,
        })
      ).skillSnapshots,
    ).toEqual([])
    f.workspace.updateProject({
      projectId: f.a.id,
      expectedRevision: f.a.revision,
      name: f.a.name,
      description: '',
      instructions: '',
      devCommand: '',
      testCommand: '',
      defaultModel: 'project-model',
      defaultEffort: 'high',
    })
    for (const profile of global.profiles) {
      expect(profile.model).toBeNull()
      expect(profile.effort).toBeNull()
      const prepared = await f.catalog.resolveRun(
        { ...input, profileId: profile.id },
        f.a.repoPath,
        randomUUID(),
        f.a.id,
        { stageInWorkspace: false },
      )
      expect(prepared.skillSnapshots.map((skill) => skill.id).sort()).toEqual(
        [...profile.skillIds].sort(),
      )
      expect(prepared).toMatchObject({ model: 'project-model', effort: 'high' })
      for (const snapshot of prepared.skillSnapshots)
        expect(readFileSync(snapshot.path, 'utf8')).toBe(snapshot.content)
    }
    const revision = f.catalog.getSnapshot({ projectId: null }).revision
    await f.catalog.initialize()
    expect(f.catalog.getSnapshot({ projectId: null }).revision).toBe(revision)
  })
  it('preserves user edits, renames and removals across database restart', async () => {
    const f = await fixture()
    await f.catalog.initialize()
    const original = f.catalog.getSnapshot({ projectId: null })
    const frontend = original.profiles.find(
      (profile) => profile.name === 'frontend-master',
    )!
    const backend = original.profiles.find(
      (profile) => profile.name === 'backend-sensei',
    )!
    const skill = original.skills.find(
      (skill) => skill.id === frontend.skillIds[0],
    )!
    const customContent = skillContent(
      'my-frontend-guide',
      'Customized starter',
      'Use our product components and tokens.',
    )
    await f.catalog.saveSkillFile({
      id: skill.id,
      projectId: null,
      expectedRevision: skill.revision,
      file: 'SKILL.md',
      expectedHash: skill.contentHash,
      content: customContent,
    })
    await f.catalog.updateProfile({
      id: frontend.id,
      projectId: null,
      expectedRevision: frontend.revision,
      name: 'My frontend agent',
      roleInstructions: 'Follow our product conventions.',
      styleGuide: frontend.styleGuide,
      skillIds: frontend.skillIds,
      model: null,
      effort: null,
    })
    await f.catalog.setProfileActive({
      id: backend.id,
      projectId: null,
      expectedRevision: backend.revision,
      active: false,
    })
    const backendSkill = original.skills.find(
      (skill) => skill.id === backend.skillIds[0],
    )!
    await f.catalog.setSkillActive({
      id: backendSkill.id,
      projectId: null,
      expectedRevision: backendSkill.revision,
      active: false,
    })
    const saved = f.catalog.getSnapshot({ projectId: null })
    f.database.close()
    const reopened = openWorkspaceDatabase(f.file)
    databases.push(reopened)
    const catalog = new CatalogService(reopened, f.appData)
    await catalog.initialize()
    expect(catalog.getSnapshot({ projectId: null })).toEqual(saved)
    expect((await catalog.getSkill({ id: skill.id })).content).toBe(
      customContent,
    )
  })
  it('keeps existing user items and occupied folders intact when starter names collide', async () => {
    const f = await fixture()
    const userSkill = await f.catalog.createSkill({
      name: 'frontend-design',
      description: 'User skill',
      instructions: 'My custom frontend workflow.',
    })
    const userProfile = await f.catalog.createProfile({
      name: 'frontend-master',
      roleInstructions: 'My custom agent.',
      styleGuide: '',
      skillIds: [userSkill.id],
      model: null,
      effort: null,
    })
    const occupied = join(f.appData, 'skills', 'api-design-principles')
    mkdirSync(occupied)
    const originalContent = 'An unregistered user file'
    writeFileSync(join(occupied, 'keep.txt'), originalContent)
    await f.catalog.initialize()
    const snapshot = f.catalog.getSnapshot({ projectId: null })
    expect(snapshot.skills).toHaveLength(5)
    expect(snapshot.profiles).toHaveLength(3)
    expect(snapshot.skills.find((skill) => skill.id === userSkill.id)).toEqual(
      userSkill,
    )
    expect(
      snapshot.profiles.find((profile) => profile.id === userProfile.id),
    ).toEqual(userProfile)
    expect(new Set(snapshot.skills.map((skill) => skill.name)).size).toBe(
      snapshot.skills.length,
    )
    expect(new Set(snapshot.profiles.map((profile) => profile.name)).size).toBe(
      snapshot.profiles.length,
    )
    const bundledFrontend = snapshot.skills.find(
      (skill) => skill.id === starterSkills[0].id,
    )!
    expect(bundledFrontend.name).toBe('constella-frontend-design')
    expect(
      parseSkill((await f.catalog.getSkill({ id: bundledFrontend.id })).content)
        .name,
    ).toBe(bundledFrontend.name)
    const renamed = await f.catalog.getSkill({ id: bundledFrontend.id })
    expect(renamed.content.slice(renamed.content.indexOf('\n---', 3))).toBe(
      readFileSync(
        new URL(
          '../src/main/application/bundled-skills/frontend-design/SKILL.md',
          import.meta.url,
        ),
        'utf8',
      ).slice(
        readFileSync(
          new URL(
            '../src/main/application/bundled-skills/frontend-design/SKILL.md',
            import.meta.url,
          ),
          'utf8',
        ).indexOf('\n---', 3),
      ),
    )
    expect(
      snapshot.profiles.find((profile) => profile.id === starterProfiles[0].id)
        ?.skillIds,
    ).toEqual(starterProfiles[0].skillIds)
    expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe(
      originalContent,
    )
    expect(existsSync(join(occupied, 'SKILL.md'))).toBe(false)
    const before = f.catalog.getSnapshot({ projectId: null })
    await f.catalog.initialize()
    expect(f.catalog.getSnapshot({ projectId: null })).toEqual(before)
  })
  it('cleans up its new folder after a failed database insert and can retry initialization', async () => {
    const f = await fixture()
    f.database.sqlite.exec(
      "CREATE TRIGGER reject_starter BEFORE INSERT ON catalog_skills BEGIN SELECT RAISE(ABORT, 'SQLITE starter fixture failure'); END;",
    )
    await expect(f.catalog.initialize()).rejects.toThrow('fixture failure')
    expect(f.catalog.getSnapshot({ projectId: null }).skills).toEqual([])
    expect(existsSync(join(f.appData, 'skills', starterSkills[0].name))).toBe(
      false,
    )
    f.database.sqlite.exec('DROP TRIGGER reject_starter')
    await f.catalog.initialize()
    expect(f.catalog.getSnapshot({ projectId: null }).profiles).toHaveLength(2)
  })
  it('upgrades untouched app-authored profiles and retires only unused legacy skills, preserving explicit task assignments', async () => {
    const f = await fixture()
    const legacy = await installLegacy(f)
    const before = f.catalog.getSnapshot({ projectId: null })
    const task = f.workspace.createTask({
      projectId: f.a.id,
      title: 'Keep an assigned skill',
    })
    const graphs = new GraphService(f.database, f.catalog)
    const graph = graphs.get({ projectId: f.a.id, taskId: task.id })
    const node = graph.document.nodes.find((node) => node.type === 'agent')!
    if (node.type !== 'agent') throw new Error('Expected an agent')
    node.data.skillIds = [legacy.skills[2].id]
    graphs.save({
      projectId: f.a.id,
      taskId: task.id,
      expectedRevision: graph.revision,
      commandId: randomUUID(),
      document: graph.document,
    })
    await f.catalog.initialize()
    const upgraded = f.catalog.getSnapshot({ projectId: null })
    for (const profile of starterProfiles)
      expect(
        upgraded.profiles.find((item) => item.id === profile.id)?.skillIds,
      ).toEqual(profile.skillIds)
    for (const skill of before.skills) {
      expect(readFileSync(join(skill.folderPath, 'SKILL.md'), 'utf8')).toBe(
        skillContent(
          legacy.skills.find((item) => item.id === skill.id)!.name,
          legacy.skills.find((item) => item.id === skill.id)!.description,
          legacy.skills.find((item) => item.id === skill.id)!.instructions,
        ),
      )
      expect(
        !!upgraded.skills.find((item) => item.id === skill.id)?.removedAt,
      ).toBe(skill.id !== legacy.skills[2].id)
    }
    await f.catalog.initialize()
    expect(f.catalog.getSnapshot({ projectId: null })).toEqual(upgraded)
  })
  it('preserves customized legacy skill files and the profiles that use them', async () => {
    const f = await fixture()
    const legacy = await installLegacy(f)
    const skill = f.catalog
      .getSnapshot({ projectId: null })
      .skills.find((skill) => skill.id === legacy.skills[0].id)!
    const content = skillContent(
      skill.name,
      'Our custom frontend skill',
      'Keep the product team’s custom instructions.',
    )
    await f.catalog.saveSkillFile({
      id: skill.id,
      expectedRevision: skill.revision,
      file: 'SKILL.md',
      expectedHash: skill.contentHash,
      content,
    })
    await f.catalog.initialize()
    const snapshot = f.catalog.getSnapshot({ projectId: null })
    expect(
      snapshot.profiles.find((profile) => profile.id === legacy.profiles[0].id)
        ?.skillIds,
    ).toEqual(legacy.profiles[0].skillIds)
    expect(
      snapshot.skills.find((item) => item.id === skill.id)?.removedAt,
    ).toBeNull()
    expect((await f.catalog.getSkill({ id: skill.id })).content).toBe(content)
    expect(
      snapshot.profiles.find((profile) => profile.id === legacy.profiles[1].id)
        ?.skillIds,
    ).toEqual(starterProfiles[1].skillIds)
    for (const source of starterSkills)
      expect(
        snapshot.skills.some(
          (skill) => skill.id === source.id && !skill.removedAt,
        ),
      ).toBe(true)
  })
})
