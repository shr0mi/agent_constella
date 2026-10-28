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
  workspaceKind: 'lab' | 'task' = 'lab',
): string {
  const sections: string[] = []
  if (workspaceKind === 'task')
    sections.push(
      `Source quality defaults: Follow applicable AGENTS.md guidance, explicit project/user requirements, and the repository's existing coding style and formatter configuration. Keep handwritten source readable: use normal indentation, spacing, and line breaks; do not compress whole functions, multiple statements, or CSS rules into long single lines. Compact or minified output is appropriate only for build artifacts or an explicit task requirement. Before finishing, inspect your edited source files and run the project's existing formatter on those files when available. If no formatter is configured, write idiomatic, consistently formatted source without adding a new formatting tool or dependency solely for this purpose. Leave unrelated and generated/vendor files alone. Report any formatting check you could not run; passing functional tests alone does not establish formatting quality.`,
      `Task prerequisites: Separate tasks start from the project base branch. Declared todo dependencies must be integrated before starting. Required input files are verified by the application before implementation. If the request explicitly requires an existing plan or other source file that is missing, report that missing prerequisite and ask for the prerequisite task to be integrated before continuing implementation. Do not invent substitute requirements or switch branches to retrieve another task's files.`,
    )
  if (context?.projectSnapshot) {
    const project = context.projectSnapshot
    sections.push(
      `Project brief: ${project.name}\n${project.description}\n\nProject instructions:\n${project.instructions}\n\nDevelopment command (context only): ${project.devCommand}\nTest command: ${project.testCommand}\n${workspaceKind === 'lab' ? "The current working directory is a disposable lab workspace, not this project's repository." : 'The current working directory is this agent’s isolated Git worktree, checked out on its own branch. Other agents may run simultaneously in different worktrees. This location supersedes paths from earlier conversation turns. Make code changes only here. Do not switch branches, commit, reset, stash, edit Git metadata, or edit old backup checkouts or app data. Leave your edits for the application: it runs the configured test command, records snapshots, and saves task progress as a Git commit after your turn.'}`,
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
