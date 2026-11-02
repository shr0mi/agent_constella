# AgentConstella

A local desktop workspace for human + native coding-agent workflows. The app includes repository projects, persistent Kanban boards, global/project catalogs, task graphs, native Codex/Claude terminals on task branches, parallel dependency scheduling, human reviews, explicit branch integration, project/task manager chats through local MCP tools, and a connectivity lab.

## Run

Requires Node.js 22.12+ (or a newer supported LTS), npm, and an installed, authenticated Codex CLI or Claude Code. Choose the project default in **Project settings → Default agent provider**. Native CLI commands and permission prompts stay in the terminal. See [native terminal architecture and behavior](docs/native-terminals.md).

```sh
npm ci
codex login # or: claude auth login
npm run dev
```

Installation rebuilds the SQLite and PTY native modules for the pinned Electron version. If a native module needs rebuilding after an Electron or dependency change:

```sh
npm run rebuild:native
```

AgentConstella uses your installed CLI and its existing authentication/configuration. It does not use the Codex SDK or change global provider settings. Sign in using the native CLI; permission and workspace-trust questions appear in the embedded terminal.

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

1. Open **Projects**, then **Create project** to choose the name and location for a new folder. The app creates the folder, initializes Git on `main` with an empty initial commit, and opens its board. Every todo branch then shares a common Git ancestor. Use **Open folder** for an existing directory; the app reuses its repository or initializes Git if needed, adding an empty initial commit only when the current branch has no commits. Existing files and staged changes are retained. Subfolders of a repository resolve to its root, and reopening the same path selects the existing project.
2. Open **Project settings** to view the repository directory and save the name, project brief, instructions, development/test commands, default agent provider (Codex/Claude), and default model/reasoning effort. Manager chats and agent runs inherit the saved defaults, including after restart; explicit chat/node settings and profile model settings take precedence. Changing models resets the effort selector to that model's default. The saved test command runs locally in agent worktrees and on combined task results when needed. The development command remains context only.
3. Create tasks with a title, description, and acceptance criteria. Click a card to edit it.
4. Move unstarted tasks between **To Do** and **Doing** with their status selector or drag and drop. Tasks move to Done through integration; once a workflow starts, execution controls its column. Drag onto another card to place it before that card; the arrow controls also reorder tasks within their column.
5. Archive tasks from a card or its editor. **Undo** restores the most recently archived task; **Archive** lists every archived task in the current project and lets you restore it to its former column.
6. Create or open another project for an independent board. Saved projects, settings, tasks, positions, statuses, and archives are restored from SQLite after an app restart.
7. To delete a project from AgentConstella, open **Project settings → Delete project**. A confirmation dialog names the project and explains that its saved settings, tasks, graphs, conversations, run records, history, and local catalog entries will be removed permanently. **Cancel** leaves everything unchanged. Repository files, skill folders, Git branches, and task worktree folders remain on disk. Stop active work or wait for integration/catalog changes before deleting. Reopening the folder creates a fresh project entry.

Starting a workflow moves its task to **Doing**. Failures and waiting reviews keep it there; reaching End after all required work is accepted leaves it in **Doing** until integration moves it to **Done**. Board badges show accepted progress and current blockers. Moving an unstarted card does not start an agent.

The manual desktop checkpoint is left for the user. See [the persistence implementation notes](docs/projects-and-kanban.md) for the schema, service boundary, and automated verification.

## Skills and agent profiles

The app includes editable global starters, available after startup in every project:

| Agent | Skills |
| --- | --- |
| Default Codex | None; stays the default for new tasks |
| frontend-master | Anthropic frontend-design; Vercel React best practices |
| backend-sensei | wshobson API design principles and architecture patterns |

Select a profile on an agent node to use its skills. The app vendors the actual upstream SKILL.md files, references, and licenses at pinned commits; source details appear on skill cards and in each skill’s SOURCE.md. React-specific guidance applies to React/Next.js projects. Profiles inherit project model/effort defaults. You can customize or remove them; restarts preserve those choices. See [the upstream sources and notices](THIRD_PARTY_NOTICES.md).

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
3. Select an agent node to edit its title, initial prompt, acceptance criteria, optional scoped profile/skills, model/effort overrides, and manual/automatic acceptance. **Default agent** is selected initially and needs no custom profile. Human Review nodes have review instructions and always require a human decision.
4. **Save graph** persists node settings and dependency changes in SQLite. Zoom, pan, and node placement are remembered automatically per task as canvas preferences; they do not create an unsaved draft, pause scheduling, or block runs/navigation. Incomplete workflow drafts can be saved. Validation lists what remains; selecting an issue opens the relevant node or connection. Save or explicitly discard configuration edits before navigating away.
5. Once saved and valid, **Check readiness** checks the saved revision, current profile/skill/model assignments, and skill files. A graph needs one Start, one End, no cycles, and a path from Start to End through every node. Cycles and invalid assignments are rejected by the application service as well as the editor.

Readiness checking does not start an agent, change the task's board status, or approve work. Select an agent and click **Run node** in its details to execute only that node when every predecessor is complete and accepted. **Start workflow / Run workflow** schedules ready nodes automatically.

Quit Electron and restart `npm run dev` after upgrading to load the new graph preload methods. Existing databases migrate automatically. See [the task graph implementation notes](docs/task-graphs.md) for persistence, revision handling, and integration boundaries. The manual milestone-4 checkpoint is left for the user.

## Agent workspaces, dependencies, and integration

1. Configure **Project settings**: save the test/development commands, an **IDE command** such as `code --new-window` or `zed`, and the maximum simultaneous agents (default 4; range 1–8). The IDE command accepts an executable and arguments; the app appends the workspace path without running a shell.
2. In the task editor, select **Depends on todos** and declare **Required input files**, one relative path per line. Project manager chat can save the same settings through `todo_create` and `todo_update`; for example, “Make implementation depend on the planning todo and require project_plan.md.” Self-dependencies, cycles, duplicate dependencies, paths outside the workspace, and dependencies on other projects are rejected.
3. **Start workflow** queues the task. It waits until every prerequisite todo has been integrated into its base branch. Integration of the prerequisite wakes waiting workflows automatically. Explicit node runs reject unmet todo dependencies. A previously opened task workspace is updated with the integrated prerequisite commits before its CLI starts.
4. Every agent node gets its own persistent Git branch and worktree folder. Independent ready nodes and independent todos run simultaneously up to the project limit. Graph edges still require accepted predecessor results. Each task also has a combined result workspace on its readable `codex/<task-title>` branch. The original project checkout stays on its current branch while agents work.
5. Before inference, the app verifies required files in the agent workspace. A missing `project_plan.md` fails preparation with its exact path and a recovery hint; the agent does not start. Small text inputs are included in the saved run context. Large/binary inputs are verified and referenced for the agent to inspect.
6. Successful agent results are combined serially into the task workspace. Conflicts preserve the agent branches and block acceptance. The app runs configured checks on each agent result and reruns them on a combined result when its files differ from the individually tested version. Failed/stopped attempts retain code in their agent worktrees.
7. **Open in IDE** in the project board header opens the original project folder. The `</>` icon in each task card’s bottom bar and the full **Open in IDE** button on its graph/review page open the combined task workspace; the node conversation has its own button for that agent’s workspace. A task can be opened before its first run. Use **Review task** to find paths, copy a run command, and open the task folder. Worktrees contain committed files; install dependencies and configure ignored environment files inside each workspace as needed.
8. Agent nodes support automatic or manual acceptance; Human Review always requires your decision. Reaching End means **Awaiting integration** and keeps the task in **Doing**. **Integrate branch → Preview integration → Integrate into <base>** merges accepted task code into the original repository and moves the task to **Done**. Conflicts and failed previews keep it Doing. Integration never pushes or deletes branches.

Each node retains its own conversation, attempts, settings, checks, and immutable file diffs. Follow-ups and retries reuse its worktree and conversation; **New conversation** resets only conversation state. Pause/stop and archive cancel all relevant active runs without rolling back files. Closing a pane detaches. Quitting the app leaves native terminals running; reopening reconnects active assignments without resending the prompt. Workflow scheduling pauses until explicit resume. Stop ends the CLI process and preserves files.

Older project-directory task branches migrate lazily into isolated worktrees on the next review/open/run. If that branch is selected in the original checkout, migration requires clean files before switching the original checkout back to its saved base. Dirty files and missing branches fail visibly. Existing legacy isolated worktrees are reused; backups and history are retained. The database migration moves previously completed but unintegrated workflows back to Doing without rerunning them.

Checks cover agent combinations in the task workspace. The final integration with newer base-branch changes is still previewed by Git without automatically rerunning the test command. See [parallel workflow details](docs/parallel-workflows.md) for the execution model and recovery behavior.

## Manager chats and Undo

1. On a project board, open **Project manager** to plan or edit tasks. Each task graph has its own **Task manager**. Opening a manager starts a real terminal using the project default CLI, connected to its scoped MCP tools. Saved manager chats and worker sessions remain separate.
   Use **New chat** in either manager's header to start a fresh conversation. The previous conversation stays in **Saved chats**, where you can select it again later. Project settings, tasks, graphs, and Changes & Undo are preserved. Finish the manager assignment or stop its terminal before switching chats. Each app-submitted assignment includes current context; direct terminal follow-ups refresh live state through MCP.
2. Ask for a task and workflow, or ask to change an existing task, add/remove nodes and connections, edit prompts and acceptance criteria, or assign existing agent profiles, skills, models, effort, and acceptance settings. The board's Project manager can also update the project brief, instructions, development/run command, test command, name, and model/effort defaults. For example: “Set the test command to npm run test:unit and add to the instructions that all new UI must support keyboard navigation.” Each app-submitted assignment includes the current project brief, repository guidance, task/node selection, revisions, catalogs, and recent execution summaries. The manager fetches full live graph state before editing.
3. Explicitly requested reversible edits save through the same validated application services as the UI. Saved board/graph changes update immediately. Save or discard a local graph draft before using its manager; drafts are retained if another session changes the graph. Active node runs must settle before graph edits can save.
4. Open **Changes & Undo** to inspect actual before/after values and undo an edit. History also includes project-settings and task/graph edits made through the UI. Undo rejects newer conflicting revisions. Archiving stops active task execution; restoring or undoing metadata does not resume execution, restore acceptance, or roll back code.
5. Start workflows, accept results, approve human reviews, and integrate branches through their desktop controls. Manager tools cannot perform these actions.

The app hosts an authenticated MCP listener on an ephemeral loopback port. Each app-launched manager turn gets a temporary credential restricted to its project (and its task for graph managers); worker assignments receive read-only task context tools and an explicit result-handoff tool. Credentials are revoked when a turn finishes or stops. No manual MCP configuration is needed. Existing native CLI authentication and configuration still apply. See [the manager implementation notes](docs/manager-chats.md) for the transport, tool contracts, and limitations. The real Codex checkpoint remains for the user to verify.

Quit Electron fully and restart after upgrading to load the manager preload bridge and migration 6.

Project model/effort defaults use migration 7 and are stored per project. Existing projects retain the configured runtime default until you choose and save a default model in Project settings.

Project-settings changes use migration 8 for history and Undo. They are available to the board project manager; task managers and workers can read the project settings. Saving development/test commands does not execute them.

Migration 9 retains existing manager conversations and adds multiple saved chats per project/task. Restart Electron after upgrading to load the new conversation controls and preload bridge.

## Native terminals and connectivity lab

The **Terminals** navigation view lists live sessions and can show two side by side (stacked at the narrow desktop width). Agent nodes show the actual CLI terminal. The saved prompt launches once. Reopening a pane reconnects to the same session. Use native commands and permission prompts directly. When finished, the agent can call `agent_report_done`, or you can click **Finish step & run checks**. Checks, acceptance, human review, and integration retain their existing behavior. Terminal silence never completes a workflow node.

The connectivity lab provides the same terminal experience in a disposable scratch workspace, with a provider selector and the existing profile/skill context. Refresh Connection checks installed CLI versions. **Finish lab assignment** records the result; **Stop** ends its process; **New scratch session** creates a separate workspace.

Terminal transcripts are stored privately in Electron app data, outside repositories. No chat file is committed to the project. See [native terminals](docs/native-terminals.md) for persistence, MCP reconnects, and recovery limits.

## Checks

```sh
npm test
npm run build
npm run test:graph-ui
npm run test:workflow-ui
npm run test:terminal-ui
npm run probe:terminal
```

The terminal checks use actual PTYs and local MCP services with test CLI executables. They do not consume provider inference allowance. Native provider sign-in and trust prompts remain interactive.

## Structure

```text
src/main/             Electron window, validated IPC, Codex service
src/main/terminal/    Native CLI launch, detached PTY service, session transport
src/main/codex/       Retained attempt lifecycle, skill resolution, atomic storage
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

Only the main process accesses Codex, SQLite, the filesystem, and credentials. The renderer runs with context isolation and sandboxing. Projects, tasks, graphs, catalog metadata, profiles, node threads, attempts, workflows, human decisions, manager conversations, command receipts, and metadata change history live in `workspace.sqlite` in Electron's user data directory (`~/Library/Application Support/AgentConstella/` on macOS). Global skills live under `skills/`, run resource archives under `run-skills/`, task result worktrees under `task-worktrees-v2/`, agent worktrees under `node-worktrees/`, and legacy checkout backups under `task-worktrees/`. Connectivity lab metadata remains under `connectivity/` and its scratch files use the OS temporary directory. Codex thread rollouts remain in the active Codex home's session store.

`npm test` runs Vitest with Electron's Node runtime, so database tests load the same native SQLite module as the desktop app without switching binaries for the system Node version. This does not open the desktop UI.

Read [the integration record](docs/codex-integration.md) before implementing the full conversation UI or permission gates.
