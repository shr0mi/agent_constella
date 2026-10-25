import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { filePathSchema, skillNameSchema } from '../../shared/catalog'
import { ApplicationError } from './errors'

export const MAX_PACK_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_BYTES = 250_000
export const hashBytes = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
export interface SkillPack {
  files: Map<string, { bytes: Buffer; mode: number }>
  name: string
  description: string
  content: string
}

export function parseSkill(content: string): {
  name: string
  description: string
} {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    content,
  )
  if (!match)
    throw new ApplicationError(
      'SKILL_FORMAT',
      'SKILL.md needs YAML frontmatter with name and description.',
      'Start the file with --- followed by name, description, another ---, and the skill instructions.',
    )
  try {
    const document = parseDocument(match[1], { uniqueKeys: true, strict: true })
    if (document.errors.length) throw document.errors[0]
    const metadata = document.toJS({ maxAliasCount: 0 }) as Record<
      string,
      unknown
    >
    const name = skillNameSchema.parse(metadata?.name)
    if (
      typeof metadata?.description !== 'string' ||
      !metadata.description.trim() ||
      metadata.description.length > 1024 ||
      !match[2].trim()
    )
      throw new Error('Description and instructions are required')
    return { name, description: metadata.description.trim() }
  } catch (error) {
    throw new ApplicationError(
      'SKILL_FORMAT',
      `SKILL.md metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'Use a lowercase hyphenated name (up to 64 characters), a description (up to 1,024 characters), and nonempty instructions.',
    )
  }
}

export function skillContent(
  name: string,
  description: string,
  instructions: string,
): string {
  return `---\n${stringify({ name, description }).trimEnd()}\n---\n\n${instructions.trim()}\n`
}

export function decodeText(bytes: Buffer): string | null {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export async function ensureDirectory(
  root: string,
  parts: string[],
): Promise<string> {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ApplicationError(
        'SKILL_PATH',
        `Skill storage must be a regular directory: ${current}`,
        'Use skill folders without symbolic links for catalog storage.',
      )
  }
  return current
}

export async function readSkillPack(
  root: string,
  allowInvalid = false,
): Promise<SkillPack> {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ApplicationError(
      'SKILL_PATH',
      'Choose a regular skill folder.',
      'Select the directory containing SKILL.md. Symbolic links are not imported.',
    )
  const files: SkillPack['files'] = new Map()
  let size = 0
  let entriesSeen = 0
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (++entriesSeen > 400)
        throw new ApplicationError(
          'SKILL_SIZE',
          'The skill contains too many resource entries.',
          'Keep the skill within 200 files and 400 total directory entries.',
        )
      const file = prefix + entry.name
      filePathSchema.parse(file)
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink())
        throw new ApplicationError(
          'SKILL_LINK',
          `The skill contains a symbolic link: ${file}`,
          'Replace linked resources with regular files before importing or selecting the skill.',
        )
      if (stat.isDirectory()) {
        await visit(path, `${file}/`)
        continue
      }
      if (!stat.isFile())
        throw new ApplicationError(
          'SKILL_FILE',
          `Unsupported resource: ${file}`,
          'Skills can contain regular files and directories.',
        )
      size += stat.size
      if (size > MAX_PACK_BYTES || files.size >= 200)
        throw new ApplicationError(
          'SKILL_SIZE',
          'A skill can contain at most 200 visible files totaling 20 MB.',
          'Keep only the resources needed by the skill.',
        )
      const bytes = await readFile(path)
      if (bytes.length !== stat.size)
        throw new ApplicationError(
          'SKILL_FILE_CHANGED',
          `The resource changed while it was read: ${file}`,
          'Finish the external edit, then try again.',
        )
      files.set(file, { bytes, mode: stat.mode & 0o111 ? 0o700 : 0o600 })
    }
  }
  await visit(root)
  const content = files.get('SKILL.md')?.bytes
  const text = content && decodeText(content)
  if (!text)
    throw new ApplicationError(
      'SKILL_FORMAT',
      'The folder needs a UTF-8 SKILL.md file of at most 250 KB.',
      'Choose the skill folder itself, including its SKILL.md and optional resources.',
    )
  let metadata = { name: '', description: '' }
  try {
    metadata = parseSkill(text)
  } catch (error) {
    if (!allowInvalid) throw error
  }
  return { files, content: text, ...metadata }
}

export async function writeSkillPack(
  root: string,
  pack: SkillPack,
): Promise<void> {
  for (const [file, data] of pack.files) {
    const segments = file.split('/')
    await ensureDirectory(root, segments.slice(0, -1))
    await writeFile(join(root, file), data.bytes, {
      mode: data.mode,
      flag: 'wx',
    })
  }
}

export async function atomicSkillWrite(
  path: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.constella-${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode, flag: 'wx' })
  await rename(temporary, path)
}
