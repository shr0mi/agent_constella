# Parallel workflows

AgentConstella gives each coding node a persistent branch and Git worktree. The project’s original folder remains available for normal development; concurrent runs do not switch its branch. A task has a separate combined result worktree used for review and final integration.

## Scheduling and code combination

The execution service reserves slots synchronously by node ID. The project limit defaults to four and is editable from one to eight in Project settings. A second request for the same node is rejected. Independent nodes and tasks can use free slots; graph joins wait for every predecessor to be accepted. Pausing or archiving stops all active nodes for that task. The graph configuration stays frozen while any of its nodes is active.

Workspace preparation and result collection use short per-task queues. Preparing a new task also reserves its branch name through a project queue. Agent inference runs outside these queues. Each agent starts from the task’s current combined commit, preserving its own earlier progress and merging upstream changes before another attempt. Local IDE edits in a known task/agent workspace are saved as progress commits when execution is explicitly requested. Opening an IDE alone does not commit edits.

The app snapshots and commits each settled attempt on the agent branch, including failed or cancelled attempts. Successful results merge into the combined task branch through a per-task queue. `git merge-tree` previews the combination without starting an unfinished merge. Conflicting paths are reported with `AGENT_MERGE_CONFLICT`; both agent branches and their files remain available. Resolve the divergence in the agent’s IDE against the combined task branch, finish that Git operation, and retry the node.

The configured command checks each agent’s result. When combining concurrent results produces a different file tree from the individually checked result, the app checks that combined tree too. Its output appears under Combined result checks. A conflict, failed combined check, changed workspace, or failed collection prevents acceptance and downstream execution. Unconfigured checks are explicitly not run.

## Todo dependencies and required inputs

Tasks store `dependencyIds` and `requiredFiles`. Both can be changed in the task editor or through project-manager `todo_create` / `todo_update` tools, using the usual revisions and Undo history. Dependencies must be unique, belong to the same project, and contain no cycles. Required paths are relative and cannot escape the workspace.

A started automatic workflow with unmet todo prerequisites waits without starting inference. Explicit node requests fail with an actionable prerequisite message. The dependency must have a current completed workflow and an integrated receipt; a manually changed board column cannot satisfy this requirement. Integration wakes other waiting workflows in the project.

Before preparing the agent, the app verifies that every prerequisite integration commit is an ancestor of the task’s saved base branch. It merges the updated base into an already-created task workspace. Therefore opening a dependent task early does not permanently freeze it on the version before its prerequisite was integrated. A prerequisite integrated into a different base branch is reported as unavailable.

Before inference, every declared required input must resolve to a regular file inside the agent’s workspace. Missing inputs fail with `MISSING_REQUIRED_INPUT`, naming the path, and no provider call occurs. Small text input content is added to the saved prompt within a bounded total; large and binary inputs are referenced for inspection. Runs retain the exact prerequisite integration commits. Revisions to those prerequisites prevent accepting or integrating an older result until it is rerun. Files mentioned only in ordinary prose remain covered by the worker instruction to report missing prerequisites; declare required files to enforce this in code.

## Review, integration, and Done

Reaching End records accepted work and displays Awaiting integration. The board stays Doing. Only a successful integration receipt moves the task to Done; failed or conflicting integration stays Doing. Revising an integrated task returns it to Doing and requires acceptance, review, and integration again.

Integration previews the combined task branch against its saved base and checks clean task/project files and accepted content. Applying creates a merge commit in the shared repository, selects the base in the original checkout, and advances it to that commit. Agent worktrees and branches are retained. No remote push, forced reset, automatic branch deletion, or per-node rollback is performed.

The checks described above verify agent results and their combination inside the task. A final merge with newer base changes is not automatically tested; inspect that result as appropriate.

## IDE and workspace lifecycle

Project settings stores an IDE executable with optional arguments, for example `code --new-window` or `zed`. Quoted executable paths are supported. Open in IDE appends the workspace path as a literal argument with no shell expansion. Errors explain how to configure the launcher. Saving settings never starts it.

Task-card and review buttons open the combined workspace, creating it if necessary. Node conversations open that agent’s workspace after its first run; before then they open the task workspace. The original project path and task workspace path are shown separately. Development commands are context/copyable commands and are not automatically launched.

Fresh worktrees contain committed files only. Dependencies, ignored environment files, and generated local configuration must be prepared inside them. There is no automatic dependency installation or copying of ignored files. Worktrees remain on disk after archive or project deletion so unfinished work is recoverable.

Migration 11 appends IDE/concurrency settings, todo input/dependency arrays, and the `node_worktrees` table. Previously started unintegrated Done tasks return to Doing. Existing shared-directory task branches migrate lazily when opened or run; a dirty selected branch blocks migration without losing files or staging state. Existing isolated worktrees are reused, including compatible detached backups. Missing/altered workspaces fail visibly rather than silently recreating saved work. Restart marks unfinished attempts interrupted and never reruns inference or checks automatically.

## Verification

The test suite uses real temporary repositories and SQLite, with injected inference. Coverage includes simultaneous agents, separate files and branches, combined output at joins, conflicts, combined-check failures, missing required inputs, dependencies waiting for integration, refreshing a previously opened dependent workspace, manager edits and Undo, IDE argument handling, and Doing-to-Done integration. Desktop checks exercise the real renderer/preload and services, including review paths and IDE launch routing with a stub launcher.
