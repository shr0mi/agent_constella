# Scheduling, reviews, and integration — milestone 6

> Historical milestone notes: the current parallel-worktree execution, todo dependency, IDE, and integration behavior is documented in [Parallel workflows](parallel-workflows.md). The original single-directory and serial-execution details below describe the earlier design.

`WorkflowService` owns progression independently of Electron. Start, explicit node runs, retries, follow-ups, and fresh conversations all pass the same predecessor admission rules. A valid saved graph and active scoped assignments are required. Each project has one code-writing slot shared by all its tasks and integration operations. Ready branches run serially in topological order; other projects can execute independently. A workflow waiting for a human does not hold its project's execution slot.

**Run node** in the details panel or conversation runs only the selected node. Explicit retries, follow-ups, and new conversations also switch that task to individual execution. Completion and acceptance update readiness without launching another agent. **Start workflow / Run workflow / Resume workflow** explicitly enables automatic scheduling again. A join still requires every predecessor to be complete and accepted; a successful manual result must be accepted first. Review-requested changes preserve this execution choice: automatic workflows rerun affected work, while individual execution revises the chosen upstream agent and waits for the next node selection. The choice persists in the existing workflow JSON; older records retain automatic behavior until an individual run is requested.

## Acceptance and progression

- Start completes when execution begins. An agent becomes ready only when every incoming predecessor has a current acceptance token. An explicit terminal handoff, successful configured checks (or explicitly unconfigured checks), and successful code collection are all required before acceptance.
- Auto acceptance grants a token after success. Manual acceptance records the human's decision against the exact current run ID and workflow revision. A successful run by itself cannot release a manual node's successors.
- Human Review becomes available after every predecessor is accepted. Its panel shows upstream summaries, check results, and links to conversations/diffs. Approval releases the gate. Request changes requires a note and an accepted upstream agent; it continues that conversation, invalidates the target and its descendants, reruns affected work, and requires review again. Revised manual nodes need a new acceptance.
- End completes only when all required nodes are accepted. Start moves the task to Doing; failures, decisions, paused work, and interruptions keep it there. End moves it to Done. Integration is a separate action after Done. Started tasks cannot be moved to another column manually, but remain reorderable and archivable.
- Failed/stopped/interrupted nodes block the workflow until an explicit node retry or revision. The scheduler does not silently retry failures. A different queued task in the same project can use the free slot.

The canvas uses labels and icons as well as color: pending nodes are muted, running nodes purple, accepted nodes green, failed nodes red, and human decisions amber. Stale/stopped/interrupted states have distinct labels and borders. Accepted edges and failed dependencies also have different styles. The graph progress bar and board badges report accepted/required counts and blockers; the count excludes Start and includes End.

The main IPC handler supplies the trusted `desktop-human` origin for acceptance, review, and integration. The application service rejects absent, manager, and worker origins. Strict input schemas reject a caller-supplied origin or approval field. Graph data, model messages, and run summaries cannot approve a review. No manager/MCP server is exposed in this milestone; later adapters must preserve these authority checks.

## Persistence, edits, and recovery

Migration 5 appends `workflows` and `workflow_decisions`; migrations 1–4 are unchanged. Workflow records retain node states, exact run references, acceptance tokens, graph/context signatures, completion snapshots, errors, and integration receipts. Human decisions retain actor, note, target, and time. Each state transition and board column change commits in one SQLite transaction, followed by renderer notifications. Service methods recheck project/task scope and expected revisions; stale decisions fail visibly.

Node signatures include incoming dependencies, settings, selected profile/skills, and relevant project/task context. Changed nodes and descendants lose their acceptance and become stale when they have prior work. Code and historical runs stay available. Saving configuration changes pauses started scheduling; explicit resume validates current configuration before continuing. Canvas zoom, pan, and placement are separate local preferences and do not require a graph save or pause scheduling. Unaffected accepted nodes can be reused. Active task runs freeze graph configuration writes. Catalog/project edits during a run mark its eventual result stale rather than accepting old configuration.

An explicit follow-up can reopen a completed or integrated workflow in the same node conversation. Its prior downstream acceptance and End completion are revoked, the board returns to Doing, and affected work must pass acceptance and review again. Earlier integration receipts stay in history; revising a task never rolls back code already integrated into the project.

Pause records the paused state before stopping active execution. Archiving also stops active work before changing archive metadata. Restoring unfinished work leaves it paused. On restart, live native assignments reconnect and missing processes leave attempts interrupted. Running/waiting workflows become paused; prompts and test commands are never replayed automatically. Previously completed workflows and human approvals remain persisted. Attempts recorded before this milestone remain inspectable but are not silently adopted as accepted workflow results.

## Explicit Git integration

After End, **Integrate branch** opens a separate dialog. Preview compares the accepted content with the task branch tip and merges it against the saved base branch from task creation, even if the project directory currently shows another branch. It rejects missing branches, unaccepted task commits, dirty/untracked project files, and unfinished Git operations. Preview writes inspection Git objects but does not switch branches or change working files.

Use the existing project directory and IDE to review: select the task branch and run the product. **Review task** also offers branch selection and a copyable development command. Task progress is committed after each settled attempt, so branch switching shows its saved output without integration. **Done** records accepted work; integration merges it into the base branch.

Project initialization establishes an empty initial commit before task branches are created. Two tasks started before either is integrated still share that ancestor, so integrating the first does not make the second an unrelated history. Starting a later task after integration includes the updated project files. Already-created unrelated branches from older app versions are retained and need separate repair.

Preview uses [Git merge-tree --write-tree](https://git-scm.com/docs/git-merge-tree/2.38.0) (Git 2.38+). It writes Git objects and inspection snapshot refs, but leaves indexes, branch tips, and working files untouched. A conflict plan lists paths and blocks the apply button. Resolve divergence explicitly and preview again; the app does not resolve conflicts, stash local work, or reset the primary checkout.

**Integrate into <branch>** rechecks workflow revision, task content, base branch/commit, and clean project state. It creates an integration merge commit, selects the base branch in the existing project directory, and fast-forwards it to that commit. The task branch stays available for IDE inspection and further revisions. Nothing is pushed remotely. Changed target revisions fail with a request to preview again. Branches and working files are never force-reset to recover an error.

Integration failures and conflicts persist separately from node completion, so reviewed work can remain Done while awaiting integration. A crash during integration is recorded as interrupted; inspect the project branch and preview again. If the task result is already an ancestor of the base branch, preview records that receipt without reapplying code.

Configured checks run on the task branch before acceptance. The merged combination with newer base changes is not automatically tested. All nodes in a task use the same project directory and branch. There is no per-node code rollback, automatic dependency installation, branch deletion, or remote integration. See [node execution](node-execution.md) for progress commits, dirty-file protection, and migration from legacy worktrees.

## Verification

`npm test` uses real temporary SQLite databases and Git repositories with injected provider inference. Scheduler cases cover individual runs without implicit scheduling, switching back to automatic execution, branching joins, serial project execution and queued tasks, auto/manual acceptance, human-only reviews, same-thread requested revisions in both execution modes, blocked failures and retries, stale decisions, changed context, paused decisions, archive/restore, and restart recovery. Integration cases cover clean merges, conflicts without primary-file changes, dirty checkouts, unaccepted task drift, moved targets, and empty initial repositories.

`npm run test:workflow-ui` builds and opens an isolated hidden Electron window using the actual services, renderer, preload, SQLite, Git, and local test command. Only provider inference is injected. It exercises failure/completion visuals, retry, both manual acceptances around a same-thread review revision, the join/review gate, Doing → Done badges, and preview followed by explicit integration. `npm run test:graph-ui` retains the graph/conversation regression. Both require a desktop session and make no provider calls.

The live Codex desktop checkpoint and plan checkboxes remain for the user.
