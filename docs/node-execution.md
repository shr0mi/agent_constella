# Agent node execution

Agent nodes run the project's installed Codex CLI or Claude Code in a native terminal on an isolated Git branch and worktree. **Run node** starts the saved initial prompt once. Follow-ups, retries, stop, and **New conversation** operate on that node's saved conversation. See [Native terminals](native-terminals.md) for transport and [Parallel workflows](parallel-workflows.md) for dependency scheduling and worktree management.

New nodes use **Default agent** without requiring a custom profile. A null profile adds no custom role or preset skills; project/task instructions and explicitly selected skills still apply. Model and effort use project/provider defaults unless a profile or node overrides them. An explicit profile must resolve to an active item in the correct scope. Use **New conversation** to reset previous conversation context.

An agent response or quiet terminal does not complete an attempt. The agent must call `agent_report_done`, or the developer must click **Finish step & run checks**. The app then runs configured checks and collects changes. Completion remains separate from automatic/manual acceptance, required Human Review, and branch integration.

Select an agent and click **Run node** for an individual attempt. Rerunning completed work continues its saved conversation; failed attempts retry their last request. These controls execute only that node. **Run workflow** enables scheduling of other ready nodes. Canvas zoom, pan, and placement do not require saving or block execution.

## Worktrees and snapshots

- Each agent node has a persistent branch and worktree, with independent conversation state. Ready nodes and tasks can run concurrently up to the project's configured agent limit.
- Each task has a combined result workspace on a readable `codex/<task-title>` branch. Agent execution leaves the original project checkout on its current branch.
- Attempts capture before/after Git snapshots and retain file changes after failure or stop. Diffs read immutable Git objects, including nonignored untracked files; binary and large-file previews are bounded.
- Successful agent results combine serially into the task workspace. Conflicts preserve agent branches and block acceptance. Combined results are checked again when they differ from individually tested code.
- **Open in IDE** opens the node's worktree from its conversation, or the combined task workspace from task review. Dependencies and ignored environment files may need to be configured in each worktree.

Integration is an explicit human action after the required work is accepted and the workflow reaches End. Preview checks the accepted task result against its saved base branch; integration merges it into the original repository and moves the task to Done. Archive, restart, stop, and failed runs preserve files and branches. Existing older worktrees migrate lazily, retaining backups; see [Parallel workflows](parallel-workflows.md) for recovery details.

## Persistence and lifecycle

`NodeExecutionService` owns preparation, terminal monitoring, checks, and code collection independently of Electron. SQLite retains node conversation IDs, bounded attempt records, exact task/project/node settings, resolved prompts, skill resource hashes and archived copies, effective model/effort, predecessor summaries, checks, and code snapshots.

The service checks project/task scope, graph revision, accepted predecessors, todo dependencies, required files, and active assignments before starting. Graph configuration is frozen while that task has active work. Archiving stops relevant active execution before applying the metadata change.

Native sessions are stored as `terminal:<session-id>`. Follow-ups reuse an available session and worktree. **New conversation** resets conversation state while retaining prior attempts and code. Changing profiles does not erase instructions already present in a live conversation.

Quitting Electron detaches monitoring and leaves native CLI processes running. On startup, live assignments reconnect without resending prompts; missing processes leave attempts interrupted. Scheduling remains paused until explicitly resumed. Historical attempts remain readable. A storage failure remains visible and blocks further execution until persistence is restored.

The UI reads recent attempts per node; complete saved records remain available through scoped service methods. The renderer receives named preload operations and validated session data. Processes, filesystem APIs, and credentials stay in the main process and terminal service.

## Checks and runtime permissions

The saved project test command runs locally in the agent worktree after explicit handoff. Output is bounded to 64 KB; command failures, a two-minute timeout, and cancellation are distinct outcomes. No configured command is recorded as **not run**. Failed checks retain code and feed their output into the next retry/follow-up context. Stop ends active CLI/check processes and preserves files.

Authentication, model support, workspace trust, and command permissions belong to the selected native CLI. Permission questions appear in its terminal. Git worktrees isolate code changes; they do not add operating-system isolation. Human Review and acceptance remain separate application decisions.

Selected skills resolve through the catalog service. Node runs reference app-data resource archives so skill staging does not add generated files to code diffs. Prompts include task/node objectives, acceptance criteria, profile/style instructions, project context, required inputs, and accepted predecessor summaries. Source-quality guidance asks agents to respect repository formatting and inspect edited files. These instructions cannot approve reviews or integrate code.

## Verification

`npm test` uses temporary Git repositories and SQLite with injected agent clients to cover lifecycle, snapshots, checks, cancellation, concurrency, recovery, and validation. `tests/terminal.test.ts` adds real PTYs and local MCP services with test CLI executables, including explicit handoff and restart reconnection without duplicate prompts. These checks do not perform provider inference.

`npm run build` typechecks and builds the main process, terminal daemon, preload, and renderer. `npm run test:graph-ui`, `npm run test:workflow-ui`, and `npm run test:terminal-ui` exercise the actual renderer/preload in isolated Electron fixtures. The terminal UI check covers provider settings, input, scrollback, reconnection, checks, and acceptance. Desktop checks require a desktop session; terminal and MCP checks require local loopback access.
