# Milestone 3: Skill and agent catalogs

Implemented on 25 October 2026. The desktop checkpoint remains for user verification; the project plan's checkbox is not changed automatically.

## Available workflows

The app seeds four editable global skills and two global profiles on startup:

| Agent | Included skills |
| --- | --- |
| Default Codex | None; remains the initial choice for new task nodes |
| frontend-master | frontend-design (Anthropic), vercel-react-best-practices (Vercel) |
| backend-sensei | api-design-principles, architecture-patterns (wshobson/agents) |

The app bundles actual upstream skill packs from anthropics/skills, vercel-labs/agent-skills, and wshobson/agents. Copies retain upstream instructions, reference files, examples, and license declarations. Vercel's React-specific rules apply when working in React/Next.js; they do not require changing an existing stack. Profiles inherit project/runtime model and effort defaults. Source repositories, pinned commits, and licenses appear on skill cards and in each installed SOURCE.md. See [third-party notices](../THIRD_PARTY_NOTICES.md).

The pinned packs and per-file SHA-256 hashes live in `src/main/application/bundled-skills/manifest.json`. The main build copies all packs next to its output bundle; startup validates them and installs editable global copies without network access. Downloaded examples are not executed during installation. A catalog-name collision changes only the installed frontmatter name and records that adaptation in SOURCE.md; instruction bodies and resources stay intact.

Stable IDs preserve later edits, renames, removals, and missing user-deleted files. Unregistered folders and existing user names are never overwritten. Default Codex remains the existing null profile with no assigned skills. No starter is selected automatically, and no schema migration or model download is required.

For databases containing the earlier app-authored starter set, initialization switches only untouched starter profiles whose old skills are also unchanged. It archives unused pristine old skills while retaining their files and historical run snapshots. Custom edits, removals, active profile references, and explicit graph skill assignments are preserved. Changed or missing files are treated as user-owned rather than overwritten. This conversion is idempotent, and all source files remain editable afterward.

**Skills** and **Agents** have Global and Project tabs. Project scope includes a repository-project selector, and each project board links to its scoped catalogs. The lab has its own project/profile selectors. Scope is stored explicitly as a nullable project ID rather than inferred from names.

| Item                  | Global                              | Project                                            |
| --------------------- | ----------------------------------- | -------------------------------------------------- |
| Skill folder          | `<app-data>/skills/<name>/`         | `<repository>/.agents/skills/<name>/`              |
| Profile visibility    | Selectable in every project         | Selectable in its project only                     |
| Profile skill choices | Global skills                       | Global skills and that project's skills            |
| Persistence           | SQLite metadata and folders on disk | SQLite metadata and repository-local skill folders |

Stable UUIDs identify both kinds of catalog item. Global and local skills may share a name; selectors display their scope and retain their separate IDs. A skill's folder remains stable if its frontmatter name is edited.

Skill creation writes valid YAML frontmatter and instructions to `SKILL.md`. Import validates a chosen folder and copies its visible files, including scripts, references, agent metadata, and binary assets. Existing native skill folders inside the destination catalog can be registered in place. Scripts are not executed during import or editing.

The skill editor supports `SKILL.md`, existing UTF-8 text resources, and new relative resource paths. It validates frontmatter, revision, and the original file hash before saving. External changes are not overwritten silently. A malformed externally edited SKILL.md can still be opened and repaired. Writes use a temporary file and rename; if the database update fails, the original file is restored.

Agent profile editing includes a display name, role instructions, style guide, selected skill IDs, and default model/effort. Model choices come from the existing runtime diagnostics. Unsupported options are rejected when the runtime catalog is available; execution validates the resolved model/effort again before invoking the SDK.

Remove/restore changes active catalog membership and retains files and stable IDs. An active profile's selected skill cannot be removed until that profile is edited or removed. Removed profiles remain editable, and restoring one checks its selected skills again. Source folders left on disk can still be discovered by native Codex; removal is not an exclusive runtime skill-disable policy.

## Shared service and migration

`CatalogService` owns scope checks and mutations independently of Electron. The renderer calls named `window.constella.catalog` bridge methods. Main owns import dialogs, filesystem access, SQLite, and run resolution; the sandboxed preload still imports only dependency-free channel constants at runtime.

Migration 2 appends `catalog_skills` and `agent_profiles` to the existing database. Migration 1 is unchanged. Profile skill IDs are serialized as JSON; all mutations validate their scope and active status in the service. Mutations advance the shared workspace revision and notify catalog subscribers after commit. Async catalog filesystem operations are serialized so app edits do not interleave with snapshot preparation.

## Resolving a Codex run

1. A lab session is bound to an optional project ID. Changing that ID archives the prior session metadata and creates a new scratch directory/thread context. Project context and saved history survive restart.
2. The run resolver validates the selected profile and all profile/additional skills against that context. Global profiles can be used in either project; another project's local IDs are rejected even when supplied directly to the service.
3. It snapshots the current profile, style guide, project brief/instructions, and selected skill contents. Repeated skill IDs from the profile and additional selection resolve once.
4. Complete resource files are archived at `<app-data>/run-skills/<run-id>/<skill-id>/` and copied to `<scratch>/.constella/skills/<run-id>/<skill-id>/`. The run stores exact SKILL.md text, source/staged/archive paths, and per-file SHA-256 hashes and sizes. Later source edits do not change those copies.
5. The prompt includes the resolved role, style guide, project context, skill instructions, and staged paths. Relative scripts/assets resolve beside the staged SKILL.md. The SDK still executes in the scratch directory, not the project repository. Stored development/test commands are context, not automatic actions.
6. Model and effort inherit the profile defaults when the caller omits them. Explicit values override them; explicit `null` selects the configured/model default. The lab displays and sends the selected effective controls. The saved run includes effective options and the original profile snapshot.

The pinned TypeScript SDK still has no native typed skill input. This implementation provides explicit instructions and resource paths; it does not promise an exclusive skill allowlist. Inherited Codex skills/configuration and previous same-thread instructions can still affect execution. Project changes always use a new session to avoid carrying prior project-specific conversation context into another project.

## Practical limits

- Skill names use lowercase letters, numbers, and hyphens, with a 64-character maximum. Required frontmatter includes `name` and a nonempty description of at most 1,024 characters.
- A skill can contain at most 200 visible files, 400 total visible entries, and 20 MB of resources. Hidden files/directories are skipped during import and snapshotting. Symbolic links and special filesystem entries are rejected.
- SKILL.md and editable resources must be UTF-8 text of at most 250 KB. Binary or larger assets remain available as imported run resources. UTF-8 BOM documents are editable without false file-change conflicts.
- One run selects at most 20 catalog skills and 40 MB of resources. The existing connectivity-proof demo remains a separate optional fixture.
- The catalog stores registered folders; it does not automatically scan every preexisting repository skill. Use Import folder to register an existing skill. External filesystem edits are read/validated at edit and run time; the catalog's displayed metadata is refreshed when saved or reimported.
- Graph/node profile and skill selectors are available in milestone 4. [Milestone 5](node-execution.md) resolves the same catalogs for real node runs on task branches, using archived resource paths directly to keep generated skill copies out of code diffs.

## Verification

- **42 automated tests pass**, including migration from an existing version-1 database without losing its project, persisted profiles/style guides, equal-name scope separation, cross-project rejection, resource imports, binary preservation, removal/restore, external-edit protection, byte limits, BOM handling, and file rollback after a database failure.
- The run integration test uses the real catalog resolver and connectivity service with an injected SDK client. It verifies the exact prompt, style/role/project text, staged resource files, archived copies, and persisted snapshots. It does not perform provider inference.
- The built preload is executed with only Electron available to `require`, including catalog method and subscription checks.
- Typechecking and production bundles pass.
- An isolated hidden Electron check with fixture data verified the global/project tabs, skill editor, profile skill choices, global profile visibility in both project contexts, local-only profile visibility, and application of profile model defaults, with no renderer/preload errors. It used a temporary profile and made no model calls.

For the manual checkpoint, create a global skill and global profile, create a local skill/profile in one project, then switch the lab between two project contexts. Select the profile, send a prompt that uses its resource, and inspect the run snapshot.

References: [official skill format and local discovery](https://learn.chatgpt.com/docs/build-skills), [Codex TypeScript SDK](https://learn.chatgpt.com/docs/codex-sdk).
