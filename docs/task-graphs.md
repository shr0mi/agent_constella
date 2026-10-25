# Task graphs — milestone 4

Each task has a graph at `/projects/:projectId/tasks/:taskId/graph`, reached from its board card or task editor. First open creates one persistent Start → Agent Task → Human Review → End draft. The agent prompt and criteria are copied from the task once; later task edits do not overwrite graph settings.

The React Flow editor supports node creation, dragging, deletion, connection/reconnection, endpoint editing, connection deletion, zoom/pan, a minimap, and a node/edge list. The list and connection form provide keyboard-accessible alternatives to pointer connections. Zoom, pan, and node placement are local canvas preferences, automatically stored per project/task in renderer local storage. They never dirty the workflow, change its revision, pause scheduling, or block runs/navigation. Node measurements and selection remain transient. Explicit saves persist settings/topology and include the current layout as a fallback for a fresh local profile. Deleting a node removes its incident edges.

Agent settings include title, prompt, acceptance criteria, optional active scoped profile, extra skills, model/effort overrides, and Auto accept / Accept manually. A null profile ID selects **Default Codex**, which adds no custom role or preset profile skills and uses configured model/effort defaults unless overridden. The panel shows a selected profile's role/style text and required skills. Global profiles/skills are visible across projects; local IDs resolve only in their project. Omitted model/effort values inherit profile settings; explicit null selects configured/model defaults. Changing a model drops inherited effort unless it still matches the profile model. Required profile skills and extras resolve as a deduplicated union.

Human Review settings include title and review instructions. Its strict schema has no acceptance mode or approval field. Agent chats, tools, and execution controls are available in [milestone 5](node-execution.md). [Milestone 6](workflow-scheduling.md) adds scheduling and a separate human-only decision service; editing a graph cannot grant approval.

## Persistence and service boundary

Migration 3 appends `task_graphs`, `graph_revisions`, and `graph_commands`; migrations 1 and 2 remain unchanged. Existing projects, tasks, skills, and profiles are preserved. App data remains outside repository workspaces.

`GraphService` owns reads, saves, scope enforcement, validation, and readiness checks independently of Electron. The sandboxed preload exposes named `graphs.get`, `graphs.save`, `graphs.prepareStart`, and `graphs.onChange` operations. The renderer has no database or filesystem access. The service can also back later MCP operations.

Saves are explicit and atomic: document changes, revision history, command receipt, and shared workspace revision commit in one SQLite transaction. Every command supplies an expected graph revision and UUID idempotency key. Exact retries return the current snapshot plus the original applied revision without applying the edit twice. Reusing a command key for different content, stale writes, and cross-project operations fail. Notifications follow commits. A newer saved revision never silently overwrites a dirty renderer draft; the user explicitly reloads/discards it. Archived tasks retain readable graphs while rejecting saves and preparation.

## Validation and readiness

The renderer and main process share the topology and assignment validator; the service always validates again against current catalog/runtime data. The node workspace lists specific blockers, including unsaved changes or graph validation issues, with a return-to-graph action.

| Rule                                                      | Draft save               | Readiness |
| --------------------------------------------------------- | ------------------------ | --------- |
| Missing Start/End, disconnected node                      | Allowed, issue displayed | Blocked   |
| Missing title or agent prompt                             | Allowed, issue displayed | Blocked   |
| Cycles/self-loops, duplicate IDs/edges, missing endpoints | Rejected                 | Blocked   |
| More than one Start/End, incoming Start/outgoing End      | Rejected                 | Blocked   |
| Missing/removed/foreign profile or skill IDs              | Rejected                 | Blocked   |
| Unsupported model/effort, effort without a model          | Rejected                 | Blocked   |
| Explicit model while runtime options are unavailable      | Allowed, issue displayed | Blocked   |
| Archived task                                             | Rejected                 | Blocked   |

Readiness additionally reads and validates selected skill folders/resources. After asynchronous file checks, it rechecks the graph revision and a fingerprint of current project/task/catalog/model data before stamping that saved revision. Graph saves clear the stamp; changed catalog/context/runtime data makes old stamps inapplicable. A failed recheck clears an older stamp, including when files changed outside the app. This is a point-in-time check; later execution must perform admission and snapshot resolution again.

Limits are 100 nodes, 400 edges, and 20 resolved skills per agent. Schemas constrain IDs, node types, text sizes, and finite canvas coordinates. The scheduler uses the topological ordering to execute branches serially; joins require every predecessor's current acceptance.

`prepareStart` deliberately returns `executionAvailable: false`; the UI calls it **Check readiness**. That operation does not invoke Codex, create worktrees, move the task to Doing, accept results, or approve a review. **Run node** in agent details or the conversation executes only that node, requiring all predecessors' current acceptance. **Start workflow / Run workflow** enables automatic scheduling. Both reuse validation and execution admission. Active task attempts freeze configuration writes; canvas navigation and layout remain available. Saved configuration changes pause scheduling and invalidate affected acceptance until explicit resume. Revision history is stored now; history browsing and Undo arrive with milestone 7.

## Engineering verification

- SQLite tests reopen saved settings/positions/edges and isolated task graphs, and upgrade a version-2 database with existing projects/tasks/profiles.
- Tests exercise cycles (including a corrupt persisted graph), dangling/duplicate/directional edges, disconnected drafts, branching joins, missing prompt/profile settings, scoped/removed assignments, runtime model/effort inheritance, skill-file failures, archived tasks, stale writes, duplicate commands, and changes during asynchronous readiness checks.
- The built preload runs under Electron sandbox restrictions with graph invocation and subscription checks.
- A hidden Electron fixture check exercised the built renderer/preload: scoped selectors, profile skills, node settings, visible canvas edges after updates, cycle rejection, node/edge creation/editing/deletion, readiness feedback, and reopening the route. It used temporary data and made no Codex calls.

Run `npm test` for service/preload tests and `npm run test:graph-ui` for the isolated UI regression check (requires a desktop session). The UI check builds first, uses a temporary Electron profile, and makes no provider calls.

The manual desktop checkpoint remains for the user. Reference: [React Flow documentation](https://reactflow.dev/learn) and its [cycle prevention example](https://reactflow.dev/examples/interaction/prevent-cycles).
