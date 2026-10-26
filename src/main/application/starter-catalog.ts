import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from './bundled-skills/manifest.json' with { type: 'json' }
import { ApplicationError } from './errors'
import { hashBytes, readSkillPack, type SkillPack } from './skill-files'

// Copies are pinned to commits; every upstream byte is recorded in the manifest.
// The main build copies these files next to its bundle for offline installation.
export const starterSkills = manifest
const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  'bundled-skills',
)

export async function readBundledSkill(
  source: (typeof starterSkills)[number],
): Promise<SkillPack> {
  const pack = await readSkillPack(join(directory, source.folder))
  if (
    pack.name !== source.name ||
    pack.files.size !== Object.keys(source.files).length
  )
    throw new ApplicationError(
      'BUNDLED_SKILL_INTEGRITY',
      `Bundled skill ${source.name} does not match its source manifest.`,
      'Rebuild or reinstall the app to restore the bundled skill files.',
    )
  for (const [file, expected] of Object.entries(source.files)) {
    const bytes = pack.files.get(file)?.bytes
    if (!bytes || hashBytes(bytes) !== expected)
      throw new ApplicationError(
        'BUNDLED_SKILL_INTEGRITY',
        `Bundled skill resource changed: ${source.name}/${file}.`,
        'Update the pinned source manifest when intentionally updating an upstream skill.',
      )
  }
  return pack
}

export function nameBundledSkill(pack: SkillPack, name: string): SkillPack {
  if (name === pack.name) return pack
  // Only the frontmatter name changes for a collision. Keep the upstream body,
  // license, metadata, and resources intact and disclose the local adaptation.
  const separator = pack.content.indexOf('\n---', 3)
  const header = pack.content
    .slice(0, separator)
    .replace(/^name:.*$/m, `name: ${name}`)
  const content = header + pack.content.slice(separator)
  const files = new Map(pack.files)
  files.set('SKILL.md', {
    ...files.get('SKILL.md')!,
    bytes: Buffer.from(content),
  })
  const source = files.get('SOURCE.md')!
  files.set('SOURCE.md', {
    ...source,
    bytes: Buffer.from(
      `${source.bytes.toString('utf8')}\nInstalled catalog name changed from ${pack.name} to ${name} to preserve an existing catalog item. No instruction body or upstream resource was changed.\n`,
    ),
  })
  return { ...pack, name, content, files }
}

export const legacyStarters = [
  {
    id: '91340185-90c5-44a2-a6d8-e596478ec134',
    name: 'frontend-design',
    hash: 'c2f26dd058d21612cabbe3bd716e91966997811da5f3ef5c56ebafe823d9e5c6',
  },
  {
    id: 'a43ba94a-77d5-4981-81ac-ed14c52da456',
    name: 'frontend-engineering',
    hash: 'a0f030dd43163acb303bcff3a334adc830bc10649db65837998ad5abd1ffd642',
  },
  {
    id: '43fc63bf-5589-41cc-8131-29d87403be0a',
    name: 'backend-api',
    hash: 'ba2d254af1316fdb27fbd389645cb3034769ce1d1dd19b46aa3e595abb81a60e',
  },
  {
    id: 'd0a5818c-b9d2-4d29-b9e7-d03f877d0675',
    name: 'backend-data',
    hash: '530c42b3432575d2b7002c145253beb6395aeed0ea4c82446b0ec6384b40fda0',
  },
] as const

export const legacyProfileSkills: Record<string, readonly string[]> = {
  '723a427a-06b9-48d3-ae5c-5d8830a71764': [
    legacyStarters[0].id,
    legacyStarters[1].id,
  ],
  '4b00358a-68fb-4c2c-ad48-aaae891e77d5': [
    legacyStarters[2].id,
    legacyStarters[3].id,
  ],
}

export const starterProfiles = [
  {
    id: '723a427a-06b9-48d3-ae5c-5d8830a71764',
    name: 'frontend-master',
    roleInstructions:
      'Implement thoughtful, complete frontend experiences using the project’s existing framework and design language. Combine visual hierarchy and interaction design with reliable UI behavior. Stay within the assigned task and its acceptance criteria.',
    styleGuide:
      'Use cohesive layouts, purposeful typography, accessible interactions, and realistic product states. Keep source readable and components aligned with the repository’s conventions. Explain the resulting user experience and what you verified.',
    skillIds: [starterSkills[0].id, starterSkills[1].id],
  },
  {
    id: '4b00358a-68fb-4c2c-ad48-aaae891e77d5',
    name: 'backend-sensei',
    roleInstructions:
      'Implement reliable backend behavior using the project’s existing language, framework, and persistence layer. Translate the task into clear service contracts and data invariants, then make the smallest complete change that satisfies them.',
    styleGuide:
      'Prefer explicit contracts, readable control flow, scoped permissions, and predictable failure behavior. Keep persistence changes consistent with existing migrations and transaction patterns. Explain observable behavior, compatibility considerations, and relevant verification.',
    skillIds: [starterSkills[2].id, starterSkills[3].id],
  },
] as const
