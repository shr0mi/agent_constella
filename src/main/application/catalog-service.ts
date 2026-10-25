import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import {
  catalogContextSchema,
  catalogIdentitySchema,
  createProfileSchema,
  createSkillSchema,
  readSkillFileSchema,
  saveSkillFileSchema,
  setCatalogActiveSchema,
  updateProfileSchema,
  type AgentProfile,
  type CatalogSkill,
  type CatalogSnapshot,
  type PreparedCatalogRun,
  type SkillDocument,
} from '../../shared/catalog'
import type { ModelOption, RunInput } from '../../shared/contracts'
import type { WorkspaceDatabase } from '../db/database'
import {
  agentProfiles,
  catalogSkills,
  projects,
  workspaceMeta,
} from '../db/schema'
import { ApplicationError } from './errors'
import {
  atomicSkillWrite,
  decodeText,
  ensureDirectory,
  hashBytes,
  MAX_PACK_BYTES,
  MAX_TEXT_BYTES,
  parseSkill,
  readSkillPack,
  skillContent,
  writeSkillPack,
  type SkillPack,
} from './skill-files'

export class CatalogService {
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly appData: string,
    private readonly models: () => ModelOption[] = () => [],
  ) {}
  private get db() {
    return this.database.db
  }
  private serial<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.queue
      .catch(() => {})
      .then(action)
      .catch((error) => {
        if (
          ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw new ApplicationError(
            'SKILL_FILES',
            error instanceof Error ? error.message : String(error),
            'Check that the skill folder and resources still exist and are accessible, then reload the catalog item.',
          )
        throw error
      })
    this.queue = result
    return result
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private commit<T>(action: () => T): T {
    const result = this.database.sqlite
      .transaction(() => {
        const value = action()
        this.db
          .update(workspaceMeta)
          .set({ revision: sql`${workspaceMeta.revision} + 1` })
          .where(eq(workspaceMeta.id, 1))
          .run()
        return value
      })
      .immediate()
    this.listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('Catalog notification failed after commit:', error)
      }
    })
    return result
  }
  private project(projectId: string | null) {
    if (!projectId) return undefined
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    if (!project)
      throw new ApplicationError(
        'PROJECT_NOT_FOUND',
        'Choose an available project for this catalog.',
        'Return to Projects or choose Global scope.',
      )
    return project
  }
  getSnapshot(raw: unknown): CatalogSnapshot {
    const { projectId } = catalogContextSchema.parse(raw)
    this.project(projectId)
    const skillsScope = projectId
      ? or(
          isNull(catalogSkills.projectId),
          eq(catalogSkills.projectId, projectId),
        )
      : isNull(catalogSkills.projectId)
    const profilesScope = projectId
      ? or(
          isNull(agentProfiles.projectId),
          eq(agentProfiles.projectId, projectId),
        )
      : isNull(agentProfiles.projectId)
    return {
      projectId,
      revision: this.db.select().from(workspaceMeta).get()!.revision,
      skills: this.db
        .select()
        .from(catalogSkills)
        .where(skillsScope)
        .orderBy(asc(catalogSkills.name))
        .all(),
      profiles: this.db
        .select()
        .from(agentProfiles)
        .where(profilesScope)
        .orderBy(asc(agentProfiles.name))
        .all(),
    }
  }
  private skill(
    id: string,
    context: string | null,
    owned = false,
  ): CatalogSkill {
    this.project(context)
    const skill = this.db
      .select()
      .from(catalogSkills)
      .where(eq(catalogSkills.id, id))
      .get()
    if (
      !skill ||
      (owned
        ? skill.projectId !== context
        : skill.projectId !== null && skill.projectId !== context)
    )
      throw new ApplicationError(
        'SKILL_SCOPE',
        'This skill is not available in the selected scope.',
        'Select a global skill or a skill belonging to the current project.',
      )
    return skill
  }
  private profile(
    id: string,
    context: string | null,
    owned = false,
  ): AgentProfile {
    this.project(context)
    const profile = this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, id))
      .get()
    if (
      !profile ||
      (owned
        ? profile.projectId !== context
        : profile.projectId !== null && profile.projectId !== context)
    )
      throw new ApplicationError(
        'PROFILE_SCOPE',
        'This agent profile is not available in the selected scope.',
        'Select a global profile or a profile belonging to the current project.',
      )
    return profile
  }
  private revision(actual: number, expected: number) {
    if (actual !== expected)
      throw new ApplicationError(
        'STALE_WRITE',
        'This catalog item changed after it was opened.',
        'Reopen the editor and review the latest version before saving.',
      )
  }
  private nameAvailable(
    projectId: string | null,
    name: string,
    except?: string,
  ) {
    const scope = projectId
      ? eq(catalogSkills.projectId, projectId)
      : isNull(catalogSkills.projectId)
    const existing = this.db
      .select()
      .from(catalogSkills)
      .where(and(scope, eq(catalogSkills.name, name)))
      .get()
    if (existing && existing.id !== except)
      throw new ApplicationError(
        'SKILL_NAME_EXISTS',
        `A skill named ${name} already exists in this scope.`,
        'Choose a different name or restore/edit the existing skill. Global and project scopes can use the same name.',
      )
  }
  private async root(projectId: string | null): Promise<string> {
    const project = this.project(projectId)
    const root = await realpath(project ? project.repoPath : this.appData)
    return ensureDirectory(root, project ? ['.agents', 'skills'] : ['skills'])
  }
  private async folder(skill: CatalogSkill): Promise<string> {
    const base = await this.root(skill.projectId)
    const path = relative(base, skill.folderPath)
    if (
      !path ||
      path.startsWith('..') ||
      isAbsolute(path) ||
      path.includes('/') ||
      path.includes('\\')
    )
      throw new ApplicationError(
        'SKILL_PATH',
        'The saved skill folder is outside its catalog scope.',
        'Reimport the skill into the current catalog.',
      )
    const info = await lstat(skill.folderPath)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ApplicationError(
        'SKILL_PATH',
        'The skill folder is missing or has become a symbolic link.',
        'Restore the folder or import a regular skill folder.',
      )
    return skill.folderPath
  }
  private insertSkill(
    projectId: string | null,
    folderPath: string,
    pack: SkillPack,
  ): CatalogSkill {
    return this.commit(() => {
      const now = new Date().toISOString()
      return this.db
        .insert(catalogSkills)
        .values({
          id: randomUUID(),
          projectId,
          name: pack.name,
          description: pack.description,
          folderPath,
          contentHash: hashBytes(pack.files.get('SKILL.md')!.bytes),
          revision: 1,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
    })
  }
  private async install(
    projectId: string | null,
    pack: SkillPack,
  ): Promise<CatalogSkill> {
    this.nameAvailable(projectId, pack.name)
    const folder = join(await this.root(projectId), pack.name)
    try {
      await mkdir(folder, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ApplicationError(
          'SKILL_FOLDER_EXISTS',
          `The skill folder ${folder} already exists.`,
          'Import that folder to register it, or use another skill name.',
        )
      throw error
    }
    try {
      await writeSkillPack(folder, pack)
      return this.insertSkill(projectId, folder, pack)
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }
  createSkill(raw: unknown): Promise<CatalogSkill> {
    const input = createSkillSchema.parse(raw)
    return this.serial(async () => {
      const content = skillContent(
        input.name,
        input.description,
        input.instructions,
      )
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
        throw new ApplicationError(
          'SKILL_SIZE',
          'SKILL.md must fit within 250 KB of UTF-8 text.',
          'Shorten the instructions or put supporting material in separate resources.',
        )
      const pack: SkillPack = {
        ...parseSkill(content),
        content,
        files: new Map([
          ['SKILL.md', { bytes: Buffer.from(content), mode: 0o600 }],
        ]),
      }
      return this.install(input.projectId, pack)
    })
  }
  importSkill(raw: unknown): Promise<CatalogSkill> {
    const input = catalogContextSchema
      .extend({ path: z.string().min(1).max(4096) })
      .parse(raw)
    return this.serial(async () => {
      if (!isAbsolute(input.path))
        throw new ApplicationError(
          'SKILL_PATH',
          'Choose an absolute skill folder.',
          'Use Import folder and select the directory containing SKILL.md.',
        )
      const pack = await readSkillPack(input.path)
      const source = await realpath(input.path)
      const target = join(await this.root(input.projectId), pack.name)
      if (source === target) {
        const existing = this.db
          .select()
          .from(catalogSkills)
          .where(eq(catalogSkills.folderPath, target))
          .get()
        if (existing) {
          this.nameAvailable(input.projectId, pack.name, existing.id)
          return this.commit(
            () =>
              this.db
                .update(catalogSkills)
                .set({
                  name: pack.name,
                  description: pack.description,
                  contentHash: hashBytes(pack.files.get('SKILL.md')!.bytes),
                  removedAt: null,
                  revision: existing.revision + 1,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(catalogSkills.id, existing.id))
                .returning()
                .get()!,
          )
        }
        this.nameAvailable(input.projectId, pack.name)
        return this.insertSkill(input.projectId, target, pack)
      }
      return this.install(input.projectId, pack)
    })
  }
  getSkill(raw: unknown): Promise<SkillDocument> {
    const { id, projectId } = catalogIdentitySchema.parse(raw)
    return this.serial(async () => {
      const skill = this.skill(id, projectId)
      const pack = await readSkillPack(await this.folder(skill), true)
      return {
        skill,
        content: pack.content,
        hash: hashBytes(pack.files.get('SKILL.md')!.bytes),
        files: [...pack.files].map(([path, data]) => ({
          path,
          size: data.bytes.length,
          editable: decodeText(data.bytes) !== null,
        })),
      }
    })
  }
  readSkillFile(raw: unknown): Promise<{ content: string; hash: string }> {
    const { id, projectId, file } = readSkillFileSchema.parse(raw)
    return this.serial(async () => {
      const pack = await readSkillPack(
        await this.folder(this.skill(id, projectId)),
        true,
      )
      const bytes = pack.files.get(file)?.bytes
      const content = bytes && decodeText(bytes)
      if (content === null || content === undefined)
        throw new ApplicationError(
          'SKILL_RESOURCE',
          'This resource is missing, binary, or larger than the text editor limit.',
          'Edit UTF-8 text resources of at most 250 KB. Other assets are preserved when importing and resolving a skill.',
        )
      return { content, hash: hashBytes(bytes!) }
    })
  }
  saveSkillFile(raw: unknown): Promise<CatalogSkill> {
    const input = saveSkillFileSchema.parse(raw)
    return this.serial(async () => {
      const skill = this.skill(input.id, input.projectId, true)
      this.revision(skill.revision, input.expectedRevision)
      const folder = await this.folder(skill)
      const pack = await readSkillPack(folder, true)
      const previous = pack.files.get(input.file)
      if ((previous ? hashBytes(previous.bytes) : null) !== input.expectedHash)
        throw new ApplicationError(
          'SKILL_FILE_CHANGED',
          'This resource was changed outside the editor.',
          'Reload the resource before saving so the external changes are preserved.',
        )
      const metadata = parseSkill(
        input.file === 'SKILL.md' ? input.content : pack.content,
      )
      this.nameAvailable(skill.projectId, metadata.name, skill.id)
      const bytes = Buffer.from(input.content)
      if (bytes.length > MAX_TEXT_BYTES)
        throw new ApplicationError(
          'SKILL_SIZE',
          'The text resource exceeds 250 KB of UTF-8 text.',
          'Shorten the resource or import it as a larger read-only asset.',
        )
      const total =
        [...pack.files.values()].reduce(
          (size, file) => size + file.bytes.length,
          0,
        ) -
        (previous?.bytes.length ?? 0) +
        bytes.length
      if (total > MAX_PACK_BYTES || (!previous && pack.files.size >= 200))
        throw new ApplicationError(
          'SKILL_SIZE',
          'The saved resource would exceed the skill size limit.',
          'Keep a skill within 200 files and 20 MB.',
        )
      const segments = input.file.split('/')
      await ensureDirectory(folder, segments.slice(0, -1))
      const path = join(folder, input.file)
      await atomicSkillWrite(path, bytes, previous?.mode)
      try {
        return this.commit(
          () =>
            this.db
              .update(catalogSkills)
              .set({
                ...metadata,
                contentHash: hashBytes(
                  input.file === 'SKILL.md'
                    ? input.content
                    : pack.files.get('SKILL.md')!.bytes,
                ),
                revision: skill.revision + 1,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(catalogSkills.id, skill.id))
              .returning()
              .get()!,
        )
      } catch (error) {
        if (previous)
          await atomicSkillWrite(path, previous.bytes, previous.mode)
        else await unlink(path)
        throw error
      }
    })
  }
  setSkillActive(raw: unknown): Promise<CatalogSkill> {
    const input = setCatalogActiveSchema.parse(raw)
    return this.serial(async () => {
      const skill = this.skill(input.id, input.projectId, true)
      this.revision(skill.revision, input.expectedRevision)
      if (!input.active) {
        const profile = this.db
          .select()
          .from(agentProfiles)
          .where(isNull(agentProfiles.removedAt))
          .all()
          .find((profile) => profile.skillIds.includes(skill.id))
        if (profile)
          throw new ApplicationError(
            'SKILL_IN_USE',
            `This skill is selected by ${profile.name}.`,
            'Edit or remove that profile before removing the skill from the active catalog.',
          )
      } else await readSkillPack(await this.folder(skill))
      return this.commit(
        () =>
          this.db
            .update(catalogSkills)
            .set({
              removedAt: input.active ? null : new Date().toISOString(),
              revision: skill.revision + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(catalogSkills.id, skill.id))
            .returning()
            .get()!,
      )
    })
  }
  private checkProfileSkills(projectId: string | null, ids: string[]) {
    this.project(projectId)
    for (const id of ids) {
      if (this.skill(id, projectId).removedAt)
        throw new ApplicationError(
          'SKILL_REMOVED',
          'A selected skill has been removed from the active catalog.',
          'Restore it or remove it from the profile selection.',
        )
    }
  }
  private checkModel(model: string | null, effort: string | null) {
    if (!model && effort)
      throw new ApplicationError(
        'MODEL_OPTIONS',
        'Choose a model before setting reasoning effort.',
        'Use the model default effort when the configured runtime default is selected.',
      )
    const models = this.models()
    if (!model || !models.length) return
    const option = models.find((option) => option.id === model)
    if (
      !option ||
      (effort &&
        !option.efforts.includes(effort as ModelOption['efforts'][number]))
    )
      throw new ApplicationError(
        'MODEL_OPTIONS',
        'This model/effort pair is not in the current runtime catalog.',
        'Refresh diagnostics and select a supported combination or the configured default.',
      )
  }
  verifySelectionFiles(projectId: string, ids: string[]): Promise<void> {
    return this.serial(async () => {
      this.checkProfileSkills(projectId, ids)
      for (const id of new Set(ids))
        await readSkillPack(await this.folder(this.skill(id, projectId)))
    })
  }
  createProfile(raw: unknown): Promise<AgentProfile> {
    const input = createProfileSchema.parse(raw)
    return this.serial(() => {
      this.checkProfileSkills(input.projectId, input.skillIds)
      this.checkModel(input.model, input.effort)
      return this.commit(() => {
        const now = new Date().toISOString()
        return this.db
          .insert(agentProfiles)
          .values({
            ...input,
            id: randomUUID(),
            revision: 1,
            removedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get()
      })
    })
  }
  updateProfile(raw: unknown): Promise<AgentProfile> {
    const { id, projectId, expectedRevision, ...fields } =
      updateProfileSchema.parse(raw)
    return this.serial(() => {
      const profile = this.profile(id, projectId, true)
      this.revision(profile.revision, expectedRevision)
      this.checkProfileSkills(projectId, fields.skillIds)
      this.checkModel(fields.model, fields.effort)
      return this.commit(
        () =>
          this.db
            .update(agentProfiles)
            .set({
              ...fields,
              revision: profile.revision + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(agentProfiles.id, id))
            .returning()
            .get()!,
      )
    })
  }
  setProfileActive(raw: unknown): Promise<AgentProfile> {
    const input = setCatalogActiveSchema.parse(raw)
    return this.serial(() => {
      const profile = this.profile(input.id, input.projectId, true)
      this.revision(profile.revision, input.expectedRevision)
      if (input.active)
        this.checkProfileSkills(profile.projectId, profile.skillIds)
      return this.commit(
        () =>
          this.db
            .update(agentProfiles)
            .set({
              removedAt: input.active ? null : new Date().toISOString(),
              revision: profile.revision + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(agentProfiles.id, profile.id))
            .returning()
            .get()!,
      )
    })
  }

  resolveRun(
    input: RunInput,
    workspace: string,
    runId: string,
    projectId?: string,
    options: { stageInWorkspace?: boolean } = {},
  ): Promise<PreparedCatalogRun> {
    return this.serial(async () => {
      z.uuid().parse(runId)
      const context = projectId ?? null
      const project = this.project(context)
      const profile = input.profileId
        ? this.profile(input.profileId, context)
        : undefined
      if (profile?.removedAt)
        throw new ApplicationError(
          'PROFILE_REMOVED',
          'This agent profile is no longer active.',
          'Choose an active profile or restore this one in Agents.',
        )
      const ids = [
        ...new Set([
          ...(profile?.skillIds ?? []),
          ...input.skillIds.filter((id) => id !== 'connectivity-proof'),
        ]),
      ]
      if (ids.length > 20)
        throw new ApplicationError(
          'SKILL_SIZE',
          'Select at most 20 catalog skills per run.',
          'Reduce the profile and additional skill selection.',
        )
      const result: PreparedCatalogRun = {
        skillSnapshots: [],
        profileSnapshot: profile,
        projectSnapshot: project && {
          id: project.id,
          name: project.name,
          description: project.description,
          instructions: project.instructions,
          devCommand: project.devCommand,
          testCommand: project.testCommand,
        },
        model:
          (input.model !== undefined ? input.model : profile?.model) ??
          undefined,
        effort:
          (input.effort !== undefined
            ? input.effort
            : input.model === undefined || input.model === profile?.model
              ? profile?.effort
              : undefined) ?? undefined,
      }
      let bytes = 0
      for (const id of ids) {
        const skill = this.skill(id, context)
        if (skill.removedAt)
          throw new ApplicationError(
            'SKILL_REMOVED',
            'A selected skill is no longer active.',
            'Choose an active skill or restore it in Skills.',
          )
        const pack = await readSkillPack(await this.folder(skill))
        bytes += [...pack.files.values()].reduce(
          (size, file) => size + file.bytes.length,
          0,
        )
        if (bytes > 40 * 1024 * 1024)
          throw new ApplicationError(
            'SKILL_SIZE',
            'Selected resources exceed 40 MB for one run.',
            'Reduce the selected skill resources.',
          )
        const archive = await ensureDirectory(this.appData, [
          'run-skills',
          runId,
          id,
        ])
        const staged =
          options.stageInWorkspace === false
            ? archive
            : await ensureDirectory(workspace, [
                '.constella',
                'skills',
                runId,
                id,
              ])
        await writeSkillPack(archive, pack)
        if (staged !== archive) await writeSkillPack(staged, pack)
        result.skillSnapshots.push({
          id,
          name: pack.name,
          projectId: skill.projectId,
          originalPath: join(skill.folderPath, 'SKILL.md'),
          archivePath: archive,
          path: join(staged, 'SKILL.md'),
          content: pack.content,
          files: [...pack.files].map(([path, file]) => ({
            path,
            size: file.bytes.length,
            sha256: hashBytes(file.bytes),
          })),
        })
      }
      return result
    })
  }
}
