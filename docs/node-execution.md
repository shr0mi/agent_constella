# Codex node execution — milestone 5

Agent nodes now have a **Conversation & runs** workspace. **Run node** executes the saved initial prompt through the pinned Codex TypeScript SDK in an app-managed task worktree. The conversation supports follow-ups, stop, retry, and an explicit fresh conversation. Activity, test output, per-attempt file diffs, and saved execution context are available in separate tabs.

New nodes use **Default Codex**: no custom profile is required. A null profile ID adds no custom role or preset profile skills; project/task instructions and explicitly selected extra skills still apply. Model/effort use configured defaults unless overridden. An explicit custom profile ID must resolve to an active item in the correct scope. Existing same-thread instructions remain in history; use New conversation to reset previous profile context.

A completed attempt means its SDK turn and configured checks settled successfully and its changes were recorded; this is distinct from workflow acceptance. [Milestone 6](workflow-scheduling.md) adds scheduling, auto/manual acceptance, human review, board progression, and explicit branch integration around this execution service. Explicit node runs now require accepted predecessors too.

Select an agent and click **Run node** in its graph details for an individual run. The same action is available in its conversation. Rerunning completed work continues its saved thread; failed attempts retry their last request. These actions, follow-ups, and new conversations execute only that node and leave other ready nodes waiting for your selection. Use **Run workflow** to enable automatic scheduling again. Canvas zoom, pan, and node placement do not require saving or block these actions.

## Worktrees and code snapshots

- One worktree per task lives at `<app-data>/task-worktrees/<project-id>/<task-id>`. New branches use `codex/<todo-title>`, normalized to a readable Git-safe slug with numbered suffixes when names are occupied. Existing branches, including legacy `codex/constella-<task-id>` names, are reused unchanged; renaming a todo does not rename its existing branch. All of a task's nodes share its code; each node has its own thread. App metadata and archived skill resources are outside the agent's worktree.
- Project setup creates an empty initial commit if the current branch has none, so all task branches share a common ancestor. New worktree creation also checks this for projects registered by earlier app versions. A private Git index then captures the project's current working files, including nonignored untracked files. It preserves the primary index, HEAD, branch, and working files while creating a private baseline commit and checking out the task branch from it.
- Existing task worktrees are verified and reused. Missing, moved, occupied, or switched-branch worktrees fail visibly instead of being deleted, reset, or silently recreated. An in-progress creation record lets a retry recover a checkout created before the app stopped.
- Each attempt records the worktree's starting HEAD and a complete before snapshot. After the SDK and checks settle, it captures an after snapshot and a changed-file list. Captures use separate indexes and protected `refs/constella/snapshots/<commit>` refs so Git garbage collection does not prune saved inspection history. User-facing task branches are not advanced by snapshot creation.
- Added, modified, deleted, and type-changed files are recorded. Renames appear as delete/add. Nonignored untracked files are included; ignored dependencies/build artifacts are not copied or collected. Binary data stays in Git objects. Text previews are limited to 512 KB per side and 2,000 listed files; oversized/submodule/binary entries explain why preview is unavailable. Full snapshots remain in Git.
- Diffs use recorded Git objects, not current mutable file contents. Later revisions therefore do not alter an earlier attempt's diff. The diff endpoint only accepts paths already recorded for that scoped attempt.

The worktree is retained after failure, stop, restart, or archive. There is no automatic rollback or cleanup. Branch integration is a separate explicit action after workflow completion. Install dependencies or perform other environment preparation in the displayed worktree when needed; ignored files such as node_modules are not copied from the source checkout.

**Review task** on the graph and human-review panel fetches current project/task metadata and verifies the ready checkout, branch, and shared repository. It shows the task and primary folder/branch, opens the task folder through the OS, and copies a terminal command using the saved development command and quoted task directory. It does not create a checkout or run development commands. Missing/switched worktrees fail visibly; the folder-opening IPC accepts only project/task IDs and rechecks the saved checkout. The node workspace also offers **Open folder**.

## Persistence and concurrency

Migration 4 appends `task_worktrees`, `node_threads`, and `node_runs`; migrations 1–3 are unchanged. Thread IDs and complete bounded attempt records are stored in SQLite, including exact node/task/project settings, resolved prompt, profile/style guide, skill text/resource hashes and archived copies, effective model/effort, predecessor summaries, prior test results, and code snapshots.

`NodeExecutionService` owns lifecycle and authorization independently of Electron. It reserves the project's single execution slot synchronously before any async work, so overlapping requests cannot create concurrent code writers in that project. Other projects can run independently. The slot stays reserved through preparation, streaming, checks, and diff collection. `GraphService` rejects active-task writes; the renderer also disables editing. Archiving through the desktop waits for the task's active attempt to stop before applying the archive command.

Named preload methods expose task state, node state, start/stop, saved attempt lookup, diff lookup, and invalidation events. No SDK, process handle, filesystem API, or credentials are exposed to the renderer. Scope and expected graph revision are checked in the service. A valid graph and active scoped assignments are required; Start, End, and Human Review nodes cannot execute SDK turns.

Each `thread.started` event persists its ID with the attempt. Follow-ups call `resumeThread` using that node's current saved ID and the same worktree. Retries preserve the last request and thread when one exists, resolving current saved configuration for the new attempt. Fresh conversations explicitly reset the current thread while retaining old attempts and code. Earlier same-thread instructions can remain in Codex's conversation history; changing a profile is not a history reset.

On startup, recorded preparing/running/testing/stopping attempts become **interrupted**. Their worktree changes are collected where possible and collection failures are shown. No inference or checks run automatically during recovery. A storage failure retains the latest volatile attempt and shows a persistence error; additional starts are blocked until storage is restored and the app is restarted.

The UI reads the latest 20 attempts per node and retains up to 300 raw events and 500 activity items per attempt, with bounded text. All attempts remain in SQLite. Older attempts can be fetched by ID through the service; a complete history browser remains future work.

## Checks and runtime boundaries

The saved project test command is displayed before execution and runs automatically after a successful SDK turn. It runs in the verified task worktree as a local app process with the user's normal process permissions; it is separate from the SDK sandbox. Output is bounded to 64 KB. Exit failures, a two-minute timeout, and cancellation are distinct recorded outcomes. No configured command means **not run**, rather than an implied test pass. Test failures keep code changes available and feed the recorded output into the next retry/follow-up context. Stop terminates the test process group on supported platforms as well as aborting the SDK signal.

Codex uses `workspace-write`, `approvalPolicy: never`, disabled tool networking, and disabled web search. There is no automatic escalation or fabricated approval UI. Authentication, model/effort, permission, stream EOF, process, storage, and Git errors are visible in the attempt. The [integration record](codex-integration.md) documents the pinned SDK's incomplete nested tool events and lack of interactive approve/deny callbacks. Provider inference still requires account access and connectivity.

Selected skills resolve through the existing catalog service. Node runs use app-data resource archives directly so staging does not add generated skill files to code diffs. The prompt includes task and node objectives, acceptance criteria, profile/style instructions, project brief/commands, and accepted predecessor summaries supplied by the scheduler. These are context; they do not permit a model to accept a manual result or approve a review.

Every task turn also receives source-quality defaults, including when no profile is selected: respect repository formatting configuration, keep handwritten source readable, inspect edited files, and use an existing formatter when available. Explicit project/user requirements and intentional build artifacts can require a different style. These are agent instructions; the app does not automatically format source or enforce a formatting gate before acceptance.

Monaco and its worker are bundled locally and loaded on demand. The renderer permits local/blob workers but does not load a CDN or enable Node integration. The direct adapter detaches models before editor/model disposal when tabs change.

## Verification

`npm test` exercises real temporary Git repositories and SQLite with an injected SDK client: new/unborn and dirty repositories, preserved source index/HEAD, immutable snapshots, same-thread revisions, restart continuation, independent node threads, streaming item updates, project concurrency, graph freezing, stop during preparation/stream/checks, test failures/timeouts/output limits, binary/deleted/large file diffs, stale/foreign/removed assignments, missing/switched worktrees, crash recovery, and visible storage failures. These tests do not consume provider inference.

`npm run test:graph-ui` builds and opens an isolated hidden Electron fixture using the actual renderer/preload. It exercises graph edits, scope selectors, visible edges, node conversations, same-thread follow-ups, stop, test output, Monaco rendering, and tab disposal with no renderer/preload errors. `npm run build` typechecks and builds main, preload, renderer, and the local editor worker.

The live desktop checkpoint remains for the user. Official SDK guidance: [start, continue, and resume local Codex threads](https://learn.chatgpt.com/docs/codex-sdk), and [noninteractive Codex execution](https://learn.chatgpt.com/docs/non-interactive-mode).
