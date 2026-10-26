# AgentConstella

A local desktop workspace for human + Codex workflows. The app includes repository projects, persistent Kanban boards, global/project catalogs, task graphs, real Codex conversations in task worktrees, serial dependency scheduling, human reviews, explicit branch integration, project/task manager chats through local MCP tools, and a connectivity lab.

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
2. Open **Project settings** to view the repository directory and save the name, project brief, instructions, development/test commands, and default model/reasoning effort. Manager chats and agent runs inherit the saved defaults, including after restart; explicit chat/node settings and profile model settings take precedence. Changing models resets the effort selector to that model's default. The saved test command runs locally in the task worktree after successful node turns. The development command remains context only.
3. Create tasks with a title, description, and acceptance criteria. Click a card to edit it.
4. Move unstarted tasks between **To Do**, **Doing**, and **Done** with their status selector or drag and drop. Once a workflow starts, its execution controls its column. Drag onto another card to place it before that card; the arrow controls also reorder tasks within their column.
5. Archive tasks from a card or its editor. **Undo** restores the most recently archived task; **Archive** lists every archived task in the current project and lets you restore it to its former column.
6. Create or open another project for an independent board. Saved projects, settings, tasks, positions, statuses, and archives are restored from SQLite after an app restart.

Starting a workflow moves its task to **Doing**. Failures and waiting reviews keep it there; reaching End after all required work is accepted moves it to **Done**. Board badges show accepted progress and current blockers. Moving an unstarted card does not start Codex.

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

## Task graphs

1. Click **Graph** on a task card, or **Open graph** in its editor. The first visit creates a Start → Agent task → Human review → End draft, using the task's description and acceptance criteria.
2. Add nodes from the toolbar and drag them into place. Drag a connection from a node's right handle to another node's left handle, or use **Add connection** in the details panel. Select a connection to change its endpoints or delete it. Deleting a node also removes its connections.
3. Select an agent node to edit its title, initial prompt, acceptance criteria, optional scoped profile/skills, model/effort overrides, and manual/automatic acceptance. **Default Codex** is selected initially and needs no custom profile. Human Review nodes have review instructions and always require a human decision.
4. **Save graph** persists node settings and dependency changes in SQLite. Zoom, pan, and node placement are remembered automatically per task as canvas preferences; they do not create an unsaved draft, pause scheduling, or block runs/navigation. Incomplete workflow drafts can be saved. Validation lists what remains; selecting an issue opens the relevant node or connection. Save or explicitly discard configuration edits before navigating away.
5. Once saved and valid, **Check readiness** checks the saved revision, current profile/skill/model assignments, and skill files. A graph needs one Start, one End, no cycles, and a path from Start to End through every node. Cycles and invalid assignments are rejected by the application service as well as the editor.

Readiness checking does not start Codex, change the task's board status, or approve work. Select an agent and click **Run node** in its details to execute only that node when every predecessor is complete and accepted. **Start workflow / Run workflow** schedules ready nodes automatically.

Quit Electron and restart `npm run dev` after upgrading to load the new graph preload methods. Existing databases migrate automatically. See [the task graph implementation notes](docs/task-graphs.md) for persistence, revision handling, and integration boundaries. The manual milestone-4 checkpoint is left for the user.

## Codex node workspaces

1. Open a saved, valid task graph, select an agent node, and click **Run node** in its details or **Conversation & runs → Run node**. This runs the selected node only; other ready nodes wait for individual runs or **Run workflow**. Every prerequisite must be complete and accepted. The app creates one task worktree/branch from the project's current files, including nonignored untracked files. The primary checkout, index, and branch are preserved. Newly initialized projects work without a manual first commit.
2. Watch the node's **Conversation** and **Activity**. Each node owns its own saved Codex thread; its attempts, prompts, profile/skill snapshots, runtime settings, and starting code revisions are persisted separately.
3. **Files & diffs** compares each attempt's recorded before/after contents in a local Monaco diff editor. Choose an attempt to inspect earlier results after later edits. **Tests** shows the saved project test command, exit status, and bounded output. Unconfigured checks are shown as not run.
4. Request a revision in the composer to continue the same conversation. **Retry last attempt** repeats a failed, stopped, or interrupted request with current saved settings and the previous test results. **New conversation** explicitly starts a fresh thread with the node's initial prompt; code and attempt history are retained.
5. **Stop** cancels the SDK turn or configured checks and records partial changes. One node can write code per project at a time. Active task graphs are read-only until their attempt settles. App restart marks unfinished attempts interrupted; it never reruns them automatically.

The worktree path is shown with **Copy path**. All nodes in one task share that checkout; their threads remain independent. Ignored dependencies/build output are not copied into a fresh worktree. Prepare dependencies in that worktree as needed. The configured test command runs as a local app process; Codex tools use workspace-write access, disabled tool networking/web search, and noninteractive permissions. Permission failures are shown without automatic escalation.

Node snapshots preserve uncommitted task work for inspection. Explicit integration commits the accepted result. See [the node execution implementation notes](docs/node-execution.md) for runtime limits. The manual milestone-5 checkpoint is left for the user.

## Scheduling, reviews, and integration

1. Save a valid graph, then click **Start workflow**. Start completes immediately; ready agent nodes execute serially within the project. A join waits for **every** predecessor to complete and be accepted. Other projects can run independently.
2. **Auto accept** nodes complete after successful execution, checks, and code collection. **Accept manually** nodes wait at **Awaiting acceptance**; open the conversation, inspect the result, and click **Accept latest result**. A failed, stopped, interrupted, or stale result cannot release downstream work.
3. Select a ready Human Review node or click **Open review**. Inspect upstream summaries, checks, conversations, and diffs. **Approve review** releases the gate. **Request changes & revise** continues a selected upstream agent's thread, invalidates affected downstream acceptance, and reruns those nodes before returning to review. Manual results need acceptance again after revision. Models cannot approve review gates.
4. **Pause & edit** stops active work. Save changed prompts, dependencies, or assignments and explicitly **Resume workflow**. Changed nodes and their descendants become stale. Failed or interrupted attempts require an explicit node retry. On app restart, saved work stays available and scheduling waits for you to resume.
5. Canvas states use text, icons, and color: pending is muted, running is purple, accepted/completed is green, failed is red, and human decisions are amber. The progress bar and board badges show accepted counts and blockers. End moves the task to **Done** only after all required nodes are accepted.
6. After completion, click **Integrate branch → Preview integration**. Git compares the accepted task snapshot with the branch currently checked out in the primary project folder. Conflicts list their paths; a dirty project or changed task worktree blocks integration. The preview leaves working files untouched. **Integrate into <branch>** explicitly commits/integrates the accepted snapshot; the app retains the task branch and worktree and does not push.

Git 2.38+ is required for integration previews. Preview again if the target branch or commit changes. Checks run in the task worktree; the combined merge result is not automatically tested. See [the scheduling and integration notes](docs/workflow-scheduling.md) for persistence, recovery, authority rules, and boundaries.

Quit Electron completely and restart `npm run dev` after upgrading so the workflow preload methods and migration 5 load. The manual milestone-6 checkpoint is left for the user.

## Manager chats and Undo

1. On a project board, open **Project manager** to plan or edit tasks. Each task graph has its own **Task manager**. These conversations and their Codex thread IDs persist independently of worker-node chats.
2. Ask for a task and workflow, or ask to change an existing task, add/remove nodes and connections, edit prompts and acceptance criteria, or assign existing agent profiles, skills, models, effort, and acceptance settings. The board's Project manager can also update the project brief, instructions, development/run command, test command, name, and model/effort defaults. For example: “Set the test command to npm run test:unit and add to the instructions that all new UI must support keyboard navigation.” Each turn includes the current project brief, repository guidance, task/node selection, revisions, catalogs, and recent execution summaries. The manager fetches full live graph state before editing.
3. Explicitly requested reversible edits save through the same validated application services as the UI. Saved board/graph changes update immediately. Save or discard a local graph draft before using its manager; drafts are retained if another session changes the graph. Active node runs must settle before graph edits can save.
4. Open **Changes & Undo** to inspect actual before/after values and undo an edit. History also includes project-settings and task/graph edits made through the UI. Undo rejects newer conflicting revisions. Archiving stops active task execution; restoring or undoing metadata does not resume execution, restore acceptance, or roll back code.
5. Start workflows, accept results, approve human reviews, and integrate branches through their desktop controls. Manager tools cannot perform these actions.

The app hosts an authenticated MCP listener on an ephemeral loopback port. Each app-launched manager turn gets a temporary credential restricted to its project (and its task for graph managers); worker turns receive read-only task context tools. Credentials are revoked when a turn finishes or stops. No manual MCP configuration is needed. Existing Codex authentication and inherited runtime configuration still apply. See [the manager implementation notes](docs/manager-chats.md) for the transport, tool contracts, and limitations. The real Codex checkpoint remains for the user to verify.

Quit Electron fully and restart after upgrading to load the manager preload bridge and migration 6.

Project model/effort defaults use migration 7 and are stored per project. Existing projects retain the configured runtime default until you choose and save a default model in Project settings.

Project-settings changes use migration 8 for history and Undo. They are available to the board project manager; task managers and workers can read the project settings. Saving development/test commands does not execute them.

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
npm run test:graph-ui
npm run test:workflow-ui
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
src/main/application/ Shared workspace/catalog/graph/execution/manager and Git services
src/main/mcp/         Scoped local MCP transport and per-turn credentials
src/main/db/          Drizzle schema, versioned SQL migrations, SQLite connection
src/preload/          Narrow typed context bridge
src/shared/           IPC contracts and Zod inputs
src/renderer/         React Router, Zustand, Tailwind, connectivity UI
scripts/              Disposable real-SDK integration probe
tests/                Lifecycle, failure, restart, and boundary tests
docs/                 Integration findings and limitations
```

Only the main process accesses Codex, SQLite, the filesystem, and credentials. The renderer runs with context isolation and sandboxing. Projects, tasks, graphs, catalog metadata, profiles, node threads, attempts, workflows, human decisions, manager conversations, command receipts, and metadata change history live in `workspace.sqlite` in Electron's user data directory (`~/Library/Application Support/AgentConstella/` on macOS). Global skills live under `skills/`, run resource archives under `run-skills/`, and task checkouts under `task-worktrees/`. Connectivity lab metadata remains under `connectivity/` and its scratch files use the OS temporary directory. Codex thread rollouts remain in the active Codex home's session store.

`npm test` runs Vitest with Electron's Node runtime, so database tests load the same native SQLite module as the desktop app without switching binaries for the system Node version. This does not open the desktop UI.

Read [the integration record](docs/codex-integration.md) before implementing the full conversation UI or permission gates.
