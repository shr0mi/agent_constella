# Bundled community skills

AgentConstella includes the actual skill files and supporting resources listed below. These are third-party skills, distinct from the app's own agent-profile instructions. Copies are pinned to commits; the app does not download or execute them during startup.

| Skill | Upstream source | Pinned commit | License |
| --- | --- | --- | --- |
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design) | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0, from the skill's LICENSE.txt |
| vercel-react-best-practices | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices) | `063bee94c3f4df8453406c830b0a7df0f2860278` | MIT, declared in upstream SKILL.md |
| api-design-principles | [wshobson/agents](https://github.com/wshobson/agents/tree/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/backend-development/skills/api-design-principles) | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` | MIT, Copyright (c) 2024 Seth Hobson |
| architecture-patterns | [wshobson/agents](https://github.com/wshobson/agents/tree/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/backend-development/skills/architecture-patterns) | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` | MIT, Copyright (c) 2024 Seth Hobson |

The complete license texts and source records are included with each pack under `src/main/application/bundled-skills/` and copied into installed skill folders. Anthropic's license file is retained verbatim. The wshobson repository's root LICENSE is copied verbatim into both backend packs. Vercel declares MIT in its skill frontmatter but supplies no separate license file at this commit; AgentConstella includes the MIT terms with the upstream author attribution and retains the original declaration and metadata.

Upstream SKILL.md bodies, examples, and reference resources are unchanged. AgentConstella adds SOURCE.md records and the license copies described above. For an installed catalog-name collision, only the installed frontmatter name is adapted and the change is recorded in SOURCE.md. The vendored source stays unchanged.

`manifest.json` records the upstream paths, commits, and original per-file SHA-256 values as well as hashes for local notice additions. Updates must intentionally change the pinned revision, refresh all referenced resources and licenses, and regenerate this manifest. Missing or modified bundled files fail integrity checks instead of silently installing a different skill.

Installed copies are editable user resources. Updates preserve user edits and removals. Earlier app-authored starter skills are archived only when unchanged and no longer referenced; their files and historical run snapshots remain available.
