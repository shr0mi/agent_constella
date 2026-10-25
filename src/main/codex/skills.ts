import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreparedCatalogRun } from '../../shared/catalog'

export const proofSkill = `---
name: connectivity-proof
description: Verify AgentConstella's selected skill and workspace tool access.
---

When this skill is selected, read workspace-proof.txt in the working directory with a shell tool.
Begin the final response with CONSTELLA_SKILL_OK and include the fixture's proof word.
Do not access files outside the working directory for this connectivity exercise.
`

export async function stageSkills(workspace: string, ids: string[]) {
  if (!ids.includes('connectivity-proof')) return []
  const directory = join(workspace, '.agents', 'skills', 'connectivity-proof')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, proofSkill, 'utf8')
  return [{ id: 'connectivity-proof', path, content: proofSkill }]
}

export function resolvePrompt(
  prompt: string,
  snapshots: { path: string; content: string }[],
  context?: Pick<PreparedCatalogRun, 'profileSnapshot' | 'projectSnapshot'>,
): string {
  const sections: string[] = []
  if (context?.projectSnapshot) {
    const project = context.projectSnapshot
    sections.push(
      `Project brief: ${project.name}\n${project.description}\n\nProject instructions:\n${project.instructions}\n\nDevelopment command (context only): ${project.devCommand}\nTest command (context only): ${project.testCommand}\nThe current working directory is a disposable lab workspace, not this project's repository.`,
    )
  }
  if (context?.profileSnapshot) {
    const profile = context.profileSnapshot
    sections.push(
      `Agent profile: ${profile.name}\n\nRole instructions:\n${profile.roleInstructions}\n\nStyle guide:\n${profile.styleGuide}`,
    )
  }
  if (snapshots.length)
    sections.push(
      `Use these explicitly selected skills for this turn. Read resources relative to each staged skill file; the paths are available in the current workspace.\n\n${snapshots.map((skill) => `Skill file: ${skill.path}\n${skill.content}`).join('\n\n')}`,
    )
  return sections.length
    ? `${sections.join('\n\n')}\n\nUser request:\n${prompt}`
    : prompt
}
