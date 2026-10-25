import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
): string {
  if (snapshots.length === 0) return prompt
  return `Use these explicitly selected skills for this turn. Their resource paths are below.\n\n${snapshots.map((skill) => `Skill file: ${skill.path}\n${skill.content}`).join('\n\n')}\n\nUser request:\n${prompt}`
}
