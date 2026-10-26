import { z } from 'zod'
import {
  effortSchema,
  type Effort,
  type Result,
  type RunInput,
} from './contracts'

export const catalogContextSchema = z
  .object({ projectId: z.uuid().nullable().default(null) })
  .strict()
export type CatalogContext = z.input<typeof catalogContextSchema>
export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers, and single hyphens.',
  )
export const createSkillSchema = catalogContextSchema.extend({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
  instructions: z.string().trim().min(1).max(100_000),
})
export type CreateSkillInput = z.input<typeof createSkillSchema>
export const catalogIdentitySchema = catalogContextSchema.extend({
  id: z.uuid(),
})
export type CatalogIdentity = z.input<typeof catalogIdentitySchema>
export const filePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part !== '' &&
            part !== '.' &&
            part !== '..' &&
            !part.startsWith('.'),
        ),
    'Choose a relative resource path without hidden or parent directories.',
  )
export const readSkillFileSchema = catalogIdentitySchema.extend({
  file: filePathSchema,
})
export const saveSkillFileSchema = readSkillFileSchema.extend({
  expectedRevision: z.number().int().positive(),
  expectedHash: z.string().nullable(),
  content: z.string().max(250_000),
})
export type SaveSkillFileInput = z.input<typeof saveSkillFileSchema>
export const setCatalogActiveSchema = catalogIdentitySchema.extend({
  expectedRevision: z.number().int().positive(),
  active: z.boolean(),
})
export type SetCatalogActiveInput = z.input<typeof setCatalogActiveSchema>
export const profileFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    roleInstructions: z.string().max(40_000),
    styleGuide: z.string().max(40_000),
    skillIds: z
      .array(z.uuid())
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Select each skill once.',
      ),
    model: z.string().trim().min(1).max(160).nullable(),
    effort: effortSchema.nullable(),
  })
  .strict()
export const createProfileSchema = catalogContextSchema.extend(
  profileFieldsSchema.shape,
)
export const updateProfileSchema = catalogIdentitySchema.extend({
  ...profileFieldsSchema.shape,
  expectedRevision: z.number().int().positive(),
})
export type CreateProfileInput = z.input<typeof createProfileSchema>
export type UpdateProfileInput = z.input<typeof updateProfileSchema>

export interface CatalogSkill {
  source?: {
    repository: string
    revision: string
    url: string
    license: string
  }
  id: string
  projectId: string | null
  name: string
  description: string
  folderPath: string
  revision: number
  contentHash: string
  removedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface AgentProfile {
  id: string
  projectId: string | null
  name: string
  roleInstructions: string
  styleGuide: string
  skillIds: string[]
  model: string | null
  effort: Effort | null
  revision: number
  removedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface CatalogSnapshot {
  projectId: string | null
  revision: number
  skills: CatalogSkill[]
  profiles: AgentProfile[]
}
export interface SkillFile {
  path: string
  size: number
  editable: boolean
}
export interface SkillDocument {
  skill: CatalogSkill
  files: SkillFile[]
  content: string
  hash: string
}
export interface SkillSnapshot {
  id: string
  path: string
  content: string
  name?: string
  projectId?: string | null
  originalPath?: string
  archivePath?: string
  files?: { path: string; sha256: string; size: number }[]
}
export interface ProjectRunSnapshot {
  id: string
  name: string
  description: string
  instructions: string
  devCommand: string
  testCommand: string
  defaultModel?: string | null
  defaultEffort?: Effort | null
}
export interface PreparedCatalogRun {
  skillSnapshots: SkillSnapshot[]
  profileSnapshot?: AgentProfile
  projectSnapshot?: ProjectRunSnapshot
  model?: string
  effort?: Effort
}
export type CatalogRunResolver = (
  input: RunInput,
  workspace: string,
  runId: string,
  projectId?: string,
) => Promise<PreparedCatalogRun>

export interface CatalogBridge {
  getSnapshot(context: CatalogContext): Promise<Result<CatalogSnapshot>>
  createSkill(input: CreateSkillInput): Promise<Result<CatalogSkill>>
  importSkill(context: CatalogContext): Promise<Result<CatalogSkill | null>>
  getSkill(input: CatalogIdentity): Promise<Result<SkillDocument>>
  readSkillFile(
    input: CatalogIdentity & { file: string },
  ): Promise<Result<{ content: string; hash: string }>>
  saveSkillFile(input: SaveSkillFileInput): Promise<Result<CatalogSkill>>
  setSkillActive(input: SetCatalogActiveInput): Promise<Result<CatalogSkill>>
  createProfile(input: CreateProfileInput): Promise<Result<AgentProfile>>
  updateProfile(input: UpdateProfileInput): Promise<Result<AgentProfile>>
  setProfileActive(input: SetCatalogActiveInput): Promise<Result<AgentProfile>>
  onChange(callback: () => void): () => void
}
