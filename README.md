# AgentConstella

A local desktop workspace for human + Codex workflows. The app includes repository projects, persistent Kanban boards, global/project skill and agent catalogs, and a real Codex connectivity lab. Task graphs, scheduling, and manager chats remain in later milestones.

## Run

Requires Node.js 22.12+ (or a newer supported LTS), npm, and internet access for Codex inference.

```sh
npm ci
npx codex login
npm run dev
```

Installation rebuilds the SQLite native module for the pinned Electron version. If a native module needs rebuilding after an Electron or dependency change:

```sh
npm run rebuild:native
```

The pinned SDK reuses the local Codex CLI login. Signing in to another application does not necessarily authenticate this runtime. API credentials can be supplied to the CLI environment; never put credentials in renderer code or a `VITE_*` variable.

Electron downloads its native binary on first launch if it is not cached. To prepare it explicitly:

```sh
node node_modules/electron/install.js
```

To use the production build locally:

```sh
npm run build
npm start
```

## Projects and Kanban

1. Open **Projects**, then **Create project** to choose the name and location for a new folder. The app creates the folder, initializes Git on `main`, and opens its board. Use **Open folder** for an existing directory; the app reuses its repository or initializes Git if needed. Existing files are retained. Subfolders of a repository resolve to its root, and reopening the same path selects the existing project.
2. Open **Project settings** to save the name, project brief, instructions, and development/test commands. Commands are stored as text for later execution workflows.
3. Create tasks with a title, description, and acceptance criteria. Click a card to edit it.
4. Move tasks between **To Do**, **Doing**, and **Done** with their status selector or drag and drop. Drag onto another card to place it before that card; the arrow controls also reorder tasks.
5. Archive tasks from a card or its editor. **Undo** restores the most recently archived task; **Archive** lists every archived task in the current project and lets you restore it to its former column.
6. Create or open another project for an independent board. Saved projects, settings, tasks, positions, statuses, and archives are restored from SQLite after an app restart.

Board statuses are manually managed in this milestone. Moving a card does not start Codex work or mark an execution graph accepted. Automatic progression is part of the later scheduler milestone.

The manual desktop checkpoint is left for the user. See [the persistence implementation notes](docs/projects-and-kanban.md) for the schema, service boundary, and automated verification.

## Skills and agent profiles

1. Open **Skills** and select **Global** or **Project**. Project scope includes a project selector; each board also links to its project catalogs.
2. **Create skill** makes a folder containing a valid `SKILL.md`. Global folders live in app data under `skills/`; project folders live in that repository's `.agents/skills/`.
3. **Import folder** copies a folder containing `SKILL.md` and its visible resources into the selected scope. Importing an existing native project skill from its destination registers it without copying over its files. Symbolic-link resources are rejected. Importing never runs scripts.
4. **Edit** opens `SKILL.md` and a file selector for text resources. Use **New text resource** for a relative path such as `references/style.md` or `scripts/check.py`. Binary/large assets remain available for runs. **Remove** hides an item from active selection while keeping its files; **Show removed** lets you restore it.
5. Open **Agents** in the desired scope and create a profile with role instructions, a style guide, selected skills, and model/effort defaults. Global profiles can select global skills. Project profiles can select global skills and their own project's local skills.
6. In **Connectivity lab → Agent context**, choose a project and then a profile. Global profiles are available in every project; local items appear only in their project. Profile skills are included automatically, and additional scoped skills can be selected below.

Changing the lab's project starts a fresh scratch conversation. The lab keeps execution in its disposable workspace; it does not execute against the project repository yet. Selected skill resources are copied into that workspace, while exact instructions, profile/style settings, resource hashes, and archived resource copies are retained with the run. Model/effort controls override profile defaults for the next turn.

See [the catalog implementation notes](docs/skills-and-agents.md) for scope rules, import limits, snapshots, and verification. The manual milestone-3 checkpoint is left for the user.

## Connectivity lab

- Refresh Connection to inspect login status, the pinned SDK/CLI versions, and runtime model/effort options.
- Send **Read a file** with **Connectivity proof** selected. A successful reply includes `CONSTELLA_SKILL_OK` and `ORBIT`, and shell activity appears in the conversation and SDK events tab.
- Send **Try cancellation**, then press **Stop** while the shell command is running.
- Send a follow-up to continue the saved thread. Quit/reopen the app to exercise continuation from disk.
- Select **Read only**, ask Codex to attempt a workspace file write, and inspect the failed tool activity. This SDK cannot present an interactive approve/deny dialog.
- **New scratch session** archives the previous metadata and creates another disposable workspace. Previous files are retained for inspection.

The desktop checkpoint is intentionally left for the user. The lab displays actual runtime failures, with no simulated successful responses.

The SDK can omit nested/custom tool events, including denied writes. A model may report a failure without a corresponding tool item in the feed. The lab and integration notes expose this limitation; use app-server before promising a complete activity/approval UI.

## Checks

```sh
npm test
npm run build
npm run probe:codex
npm run probe:codex -- --live
# Optional targeted check after a permission/transport change:
npm run probe:codex -- --live --permissions-only
```

The default probe only inspects login and runtime model options. `--live` uses your existing login and inference allowance for several short turns in a fresh temporary workspace: tools/skill output, continuation from a new client, cancellation during a shell command, continuation after cancellation, and a denied write under read-only permissions. A JSON report and temporary paths are printed; failures exit nonzero. Local Codex state must be writable and the provider must be reachable.

## Structure

```text
src/main/             Electron window, validated IPC, Codex service
src/main/codex/       Runtime discovery, lifecycle, skill resolution, atomic storage
src/main/application/ Shared project/task/catalog services, repository and skill files
src/main/db/          Drizzle schema, versioned SQL migrations, SQLite connection
src/preload/          Narrow typed context bridge
src/shared/           IPC contracts and Zod inputs
src/renderer/         React Router, Zustand, Tailwind, connectivity UI
scripts/              Disposable real-SDK integration probe
tests/                Lifecycle, failure, restart, and boundary tests
docs/                 Integration findings and limitations
```

Only the main process accesses Codex, SQLite, the filesystem, and credentials. The renderer runs with context isolation and sandboxing. Projects, tasks, catalog metadata, and profiles live in `workspace.sqlite` in Electron's user data directory (`~/Library/Application Support/AgentConstella/` on macOS). Global skills live under `skills/` and run resource archives under `run-skills/`. Connectivity lab metadata remains under `connectivity/`; the Codex thread itself remains in the active Codex home's session store. Worker files live in the operating system temporary directory, separately from app metadata. The application MCP server is planned for milestone 7.

`npm test` runs Vitest with Electron's Node runtime, so database tests load the same native SQLite module as the desktop app without switching binaries for the system Node version. This does not open the desktop UI.

Read [the integration record](docs/codex-integration.md) before implementing the full conversation UI or permission gates.
