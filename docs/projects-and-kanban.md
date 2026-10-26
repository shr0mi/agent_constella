# Milestone 2: Projects, persistence, and Kanban

Implemented on 25 October 2026. The desktop checkpoint remains pending user verification; the plan's milestone checkbox is not changed automatically.

## Implemented behavior

- **Create project** uses a native name/location dialog to create a new folder, initialize Git on `main` with an empty initial commit, register the project, and open its board. Existing destination files/folders are never overwritten; users can open them instead.
- **Open folder** selects an existing directory and reuses its repository or initializes Git when the folder has none. Existing files are kept. Git discovery resolves repository roots and symlinks and accepts existing Git worktrees. Bare repositories, broken Git metadata, inaccessible folders, and missing Git produce visible errors. Canonical paths prevent duplicate projects; reopening a registered repository selects it.
- Project settings persist the name, canonical path, brief, project instructions, development command, and test command. The repository path is fixed at registration. Saving command text never executes it.
- Every project has an independent To Do / Doing / Done board. Tasks persist their title, description, acceptance criteria, status, column position, revision, timestamps, and optional archive timestamp.
- Task creation, viewing, editing, status moves, reordering, archiving, Undo, and archive restoration are available. Drag and drop and accessible status/order controls use the same move command. Restoring a task appends it to its former column and retains its content. Permanent task deletion is not exposed.
- Task filters search titles, descriptions, and acceptance criteria. Reordering is disabled while filtering so hidden tasks cannot make a destination ambiguous.
- Board progression is manual for milestone 2. No repository commands or Codex runs are triggered by creating tasks, moving cards, or saving project settings. Graph-based execution and accepted-work progression belong to later milestones.

## Database and migrations

The main process opens `workspace.sqlite` in Electron's user data directory, outside project repositories. On macOS this is `~/Library/Application Support/AgentConstella/workspace.sqlite`. The connection uses SQLite WAL, foreign keys, and a 5-second busy timeout. Repository opening performs Git discovery, and new/non-Git project folders additionally receive Git initialization. Any current project branch without a commit receives an empty `Initialize AgentConstella project` commit, giving all future task branches a shared ancestor. Existing working files, staged changes, and committed history are preserved. Initialization uses Git plumbing with app-local author identity, disabled hooks/signing, and an atomic ref creation; it does not stage files, create a remote, or publish anything. Concurrent opens share the same initialization operation, and a competing external commit is preserved rather than overwritten.

If folder creation or Git initialization fails, no project row is registered. Missing Git is checked before creating a new directory. If Git initialization succeeds but database registration fails, the folder is retained and the error explains how to retry using Open folder.

An initial-commit failure also leaves the folder and index intact and prevents registration until retry succeeds. New task branches recheck this invariant for projects registered by older versions. This prevention does not rewrite already-created unrelated task branches; those require a separate repair.

## Deleting a project

**Project settings → Delete project** opens a native confirmation dialog with Cancel as the default. It names the project and repository and describes the permanent removal of its app metadata. The trusted desktop handler supplies the confirmation callback; MCP tools cannot delete projects or supply a confirmation flag. The application service requires the live project revision, rejects active manager/worker/integration operations and pending catalog changes, and rechecks after the dialog before deleting in one SQLite transaction.

Foreign-key cascades remove the selected project's tasks, graph revisions/commands, worktree registrations, node threads/runs, workflows/decisions, manager chats, change history, and local catalog entries. Global skills/profiles and other projects stay available. Migration 10 binds manager command receipts to their projects, backfilling supported legacy result shapes so those receipts are also removed. Cancellation, stale state, and transaction failures leave the project records intact. A committed removal publishes a new workspace snapshot and returns the UI to Projects. An idle scratch lab selection for the removed project is cleared so it can continue without the deleted project context.

Deletion never removes repository files, skill folders, Git refs, or task worktree directories, including unintegrated code. Deleting app metadata has no Undo. Reopening the same repository creates a new project entry with an empty board; preserved folders/branches remain available on disk.

`src/main/db/schema.ts` declares the Drizzle tables. `src/main/db/migrations.ts` contains append-only versioned SQL embedded in the main bundle, avoiding runtime dependencies on copied migration assets. `openWorkspaceDatabase` applies pending migrations transactionally and records each version, name, SHA-256 checksum, and application time in `app_schema_migrations`.

An edited applied migration or a schema version newer than this app causes a visible startup error. Existing data is preserved. Future schema work must append a migration and update the Drizzle schema rather than editing an applied migration or recreating the database.

The initial migration adds:

| Table                   | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `projects`              | Canonical repository identity and editable settings            |
| `tasks`                 | Project-owned content, board state, ordering, and soft archive |
| `workspace_meta`        | Monotonic committed workspace revision for renderer snapshots  |
| `app_schema_migrations` | Applied migration history and checksums                        |

Task rows reference their project through a foreign key. Status and position constraints also exist in SQL. Codex connectivity lab JSON is retained separately; this milestone does not rewrite existing chat history.

## Shared application service

`WorkspaceService` is independent of Electron. It validates every public command using shared Zod schemas and is the sole project/task mutation layer. Its methods can be called directly by a future MCP adapter:

| Method                        | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `getSnapshot`                 | Full local workspace for the UI                          |
| `getBoard`                    | Read one explicitly scoped project and its tasks         |
| `openRepository`              | Validate a repository and register or reuse the project  |
| `openFolder`                  | Open an existing folder and initialize Git if needed     |
| `createProject`               | Create a new folder and Git repository, then register it |
| `updateProject`               | Save settings with an expected revision                  |
| `createTask` / `updateTask`   | Create and edit task content                             |
| `moveTask`                    | Move/reorder within an explicit project and column       |
| `archiveTask` / `restoreTask` | Reversible removal and restoration                       |

Every task mutation requires both project and task IDs; a task from another project is rejected. Updates require the caller's expected revision, preventing stale drafts from silently overwriting newer data. Moves, source/destination ordering, revision updates, and archive operations commit atomically. Positions are dense per active column. Subscribers receive a snapshot only after commit; notification failures do not turn an already committed command into a failed mutation.

The preload exposes named methods under `window.constella.workspace` and strips Electron event objects from subscriptions. Its runtime imports remain dependency-free. Command validation runs in the application service, while Drizzle and SQLite remain in the main process. Renderer snapshot revisions prevent an older async response from replacing a newer committed view.

Future MCP tools should bind their authenticated project context to these commands and use `getBoard` for project-scoped reads. This milestone does not implement tool transport, roles, graph revisions, scheduler integration, or task execution.

## Native runtime and verification

Dependencies are pinned: `better-sqlite3@13.0.3`, `drizzle-orm@0.45.4`, and `@electron/rebuild@4.2.1`. `npm ci`/installation runs the Electron rebuild hook. `npm run rebuild:native` performs an explicit rebuild when needed. Tests run through Electron's Node runtime to use the desktop native module consistently.

Verification completed:

- **30 automated tests passed**, including a real SQLite close/reopen test retaining two independent project boards, settings, edited content, task statuses, and archived state.
- Project creation tests cover `main` branch initialization, persistence after reopening the database, initializing folders containing existing files, collision protection, missing Git, preserved metadata, and recovery after database registration fails.
- Repository tests cover ordinary repositories, subdirectories, canonical/symlink deduplication, Git worktrees, and rejected bare/non-repositories.
- Service tests cover cross-project isolation, transaction rollback, dense ordering, archive/restore, stale writes, malformed commands, migration incompatibility, and post-commit subscriber failures.
- The built sandboxed preload test verifies the new workspace API and subscription cleanup without allowing arbitrary `require` calls.
- Typechecking and production builds pass.
- An isolated hidden Electron renderer check with fixture data confirmed two project cards, three board columns, independent task display after project switching, and a working task dialog with no renderer/preload errors. This check used a temporary profile and did not alter the user's app data; it does not replace the manual desktop checkpoint.

Run `npm run dev`, create or open two project folders, create tasks/settings in each, quit Electron completely, and reopen it for the manual checkpoint.

References: [Drizzle SQLite driver](https://orm.drizzle.team/docs/sqlite/get-started-sqlite), [Drizzle migration approaches](https://orm.drizzle.team/docs/migrations), [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/).
