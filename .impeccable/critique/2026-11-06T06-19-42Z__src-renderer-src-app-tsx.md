---
target: AgentConstella product usefulness and simplification on terminal-multiplexer
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/kak_shromi/Documents/repos/agent_constella/src/renderer/src/App.tsx"
target_fingerprint: "sha256:ca3c907a978f6128d7fec0e703dc23edaf13b41675ea56082a0357d2c4843651"
target_path: /Users/kak_shromi/Documents/repos/agent_constella/src/renderer/src/App.tsx
timestamp: 2026-11-06T06-19-42Z
slug: src-renderer-src-app-tsx
---
Method: dual-agent (A: /root/product_design_review; B: /root/implementation_evidence). Both reviewed independently; A finished before B detector findings entered synthesis.

AgentConstella product review — 6 November 2026

Reviewed the current terminal-multiplexer branch at 4a976cc. This is a source-based evaluation. Electron inspection returned “Computer Use was not approved to use Electron.” No usable screenshots were available, so rendered appearance and real user effort remain unverified. No source code was changed.

The product is useful for developers coordinating several coding tasks, but the default path exposes too much workflow machinery. Its execution engine is stronger than its everyday review experience. The durable promise is less human effort per reviewed, integrated change; it should remain useful as models become faster.

| Goal | Assessment | Reason |
| --- | --- | --- |
| Faster, visual agent development | Partly achieved | The board, dependency graph and lifecycle labels expose work. Users still navigate between graph, terminal and IDE to understand and finish it. |
| Several features at once | Strong foundation | Real isolated agent worktrees, configurable concurrency, combination queues and combined-result checks exist. Environment setup and final integration still require attention. |
| Accessible human review | Partly achieved | Human authority is enforced, but detailed diffs and checks are not readily accessible in the current review flow. |
| Senior/junior team oversight | Not implemented | The app is local and single-user. Shared ownership, reviewer identity, attribution and permissions are future work. |

Useful things to preserve:

- Persistent tasks with goals, dependencies and acceptance criteria keep intent visible beyond a conversation.
- Separate agent worktrees and a combined task workspace provide real parallel development. Checks can run on the combined code, rather than only isolated outputs.
- Required human decisions cannot be supplied by manager or worker agents. Explicit integration makes Done mean something concrete, and retained code makes interrupted work recoverable.

The design is functionally specific to coding work. The visual vocabulary documented in DESIGN.md is conventional but coherent. The greatest opportunity for product identity is exceptionally clear task state and review evidence. Visual craft cannot be judged from source alone.

Four priority issues:

1. [P1] The ordinary task path exposes too many concepts and decisions. Every default task gets Start → Agent → Human Review → End. The agent defaults to manual acceptance, so an ordinary feature can require accepting its result, approving human review, then integrating. Save graph, Check readiness, Run node and Start workflow are separate visible choices. Use a default Brief → Run → Review → Integrate flow. Keep extra checkpoints, branching and configuration under Customize workflow. A Run action can save and validate before starting; users should see actionable failures when necessary. One human review should normally cover the ordinary result decision. Keep explicit final integration and allow more gates for risky tasks. Suggested follow-up: Impeccable distill/shape.

2. [P1] Planning later steps interrupts current execution. TaskGraph.tsx:289–293 disables editing while any node is active, and graph-service.ts:200–204 enforces that in the backend. “Pause & edit” stops active assignments. This conflicts with the stated goal of creating the rest of a workflow while earlier steps execute. Keep the running assignment's snapshot fixed, allow an editable next-plan draft, and apply changes at a clear boundary. Preview which future work and approvals will change. Until that exists, label the interruption clearly. Do not simply remove the guard. Suggested follow-up: Impeccable shape/clarify.

3. [P1] Review decisions are protected better than review evidence is presented. WorkflowControls.tsx:280–297 offers summaries, check state and “Inspect conversation & diffs,” but NodeWorkspace.tsx:282–291 now opens a terminal-focused view. TaskReview.tsx:140–211 primarily hands off to the IDE and provides workspace metadata and a copyable run command. Persisted diffs and checks still exist. Build a single review page with the goal, acceptance criteria, changed files/diff, agent summary, actual check commands and output, combined checks, and the reviewed run/commit. Approve and Request changes belong there. The IDE and terminal remain available for deeper inspection. Show whether the final merge with a newer base has been tested; current integration checks Git mergeability without automatically testing that final tree. Suggested follow-up: Impeccable shape/clarify.

4. [P2] Several parallel sessions still require too much attention switching. The board has helpful badges, but its three columns group running work, review, failures and awaiting integration under Doing. Task titles open metadata editing; execution uses a separate Graph link. The terminal list mainly shows title/provider/process state and at most two panes. Make opening a task lead to its current work and next action. Add a cross-task Needs you inbox for review, failed checks, blocked integration, and reliably observable input requests. Native terminal output does not currently provide a full structured activity feed, so do not promise perfect detection of permission waits. Suggested follow-up: Impeccable distill/shape.

A simpler default:

- One board: Queued, Working, Needs you, Done. Show blockers as explicit labels. Filter Needs you by review, input, checks and integration.
- One task page: a clear brief, optional short plan, current state and one main next action. Changes/Review and Terminal are nearby views. Keep one canonical task brief; step prompts should add instructions rather than become silently divergent copies.
- An optional graph for genuine branching, joins and checkpoints. Hide Start/End and advanced settings during ordinary work. Generate an initial plan from the brief, then let the user change meaningful decisions.
- Project defaults for provider, model, test command and setup. Agent profiles, skill catalogs, effort overrides and diagnostic tools belong behind settings unless needed. Prepare dependencies and local configuration deliberately for each worktree. Add practical lifecycle/cleanup controls without silently deleting recoverable work.
- Limit active work when reviews pile up. More simultaneous agent output only helps when the developer can inspect and integrate it.

For teams, preserve one human owner per task. A senior defines the outcome, constraints and review expectations; the task owner chooses how agents execute and remains responsible for the result. The senior needs to see owner, goal, agreed plan, blockers, checks, review evidence, and who approved which revision. Terminal watching is an optional drill-down. Begin with shared task state, owner/reviewer identity, comments, attributed approvals and links to pull requests. Do not start by building a broad issue tracker or remote execution platform. Merely adding a dashboard to local sessions will not create trustworthy team oversight.

The strongest first audience is developers already coordinating multiple tasks. Validate the default workflow there before building the full team model. Test whether developers can start a second feature, discover what needs them, request changes, and integrate without repeated setup help. Measure time to the first useful run, human time per accepted change, review waiting time, correction effort and setup failures. Completed nodes and token counts are weaker success measures than reviewed changes delivered.

Current product context supports the problem, but does not prove demand for this implementation. Conductor's official workflow already describes isolated parallel workspaces, diffs, checks and reviewed integration: https://www.conductor.build/docs/concepts/workflow . Vibe Kanban's founders reported thousands of daily users but closed its company in April 2026 after failing to find a suitable business model: https://www.vibekanban.com/blog/shutdown . Useful software and a sustainable business need separate validation. These are primary-source claims, not independent market measurements.

Source-based Nielsen heuristic assessment (provisional; not a rendered usability test):

| Heuristic | Score /4 | Evidence |
| --- | ---: | --- |
| Visible system status | 3 | Explicit node states, board badges and blockers; live activity remains coarse. |
| Familiar language | 2 | Node, workflow, acceptance, review, handoff and integration require learning. |
| User control | 2 | Strong explicit decisions and recovery, but Pause & edit stops active work. |
| Consistency | 2 | Competing execution actions and a stale conversation-and-diffs label. |
| Error prevention | 3 | Validation, revision guards and human-only decisions. |
| Recognition over memory | 2 | Context must be carried between graph, terminal and IDE. |
| Efficiency | 2 | Powerful advanced paths, with too much of them exposed by default. |
| Minimalism | 2 | Many simultaneous controls; rendered hierarchy unverified. |
| Error recovery | 3 | Specific blockers and preserved files; conflict recovery remains external. |
| Help | 2 | Substantial docs and useful copy; complete mental model still takes learning. |
| Total | 23/40 | Acceptable foundation with important workflow friction. |

Cognitive load is likely highest for first-time users. Node settings expose more than four independent decisions at once: profile, prompt, criteria, model/effort, acceptance and skills, alongside title. Grouping is deliberate, but progressive disclosure and a single next action need work. The likely emotional journey is promising at planning, uncertain at handoff, then administratively heavy near completion. This is a hypothesis requiring observation.

Persona red flags:

- A developer shipping three features needs an attention queue more than more terminal panes.
- A first-time user must understand several execution and completion states before a simple success. Task edits do not update an already-created agent prompt, so intent may diverge.
- A senior reviewer needs concise code/check evidence and attributable decisions; the current single-user records only identify the decision actor as human.

Minor observations: correct “Inspect conversation & diffs”; distinguish original, agent and combined task workspaces where relevant; show which tree was tested; make interrupted/paused state explicit after restart; keep app diagnostics and catalog management away from the first useful run.

The deterministic detector returned exit 0 with 58 quality advisories: 34 radius, 23 font size and one color. These are not 58 demonstrated usability defects. Many values are expressly allowed by DESIGN.md prose; the color is a documented rail status dot. A reported 6px size is overridden by later 10px CSS, and some findings concern unused rules. No rendered typography, contrast, layout or overlay conclusions follow from this scan. Detector findings do not change the main product priorities.

Questions for a later design decision: should the first audience be solo developers coordinating several features or small senior/junior teams? Should the first redesign focus on the default task flow, review evidence, or planning while agents run? The recommended order is task flow and review, then editable future plans, followed by team collaboration.
