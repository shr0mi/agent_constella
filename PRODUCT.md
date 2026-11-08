# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual developers managing native Codex CLI and Claude Code workflows. The current application is a local, single-user workspace for a developer working with repository projects and one or more coding agents.

The primary job is to organize coding tasks, coordinate agent work, understand progress and blockers, review changes, and integrate accepted results into a repository.

## Product Purpose

Manage repository tasks, coordinate coding agents through visible workflows, review their changes, and integrate approved work locally.

Success means the developer can follow work from a task through execution, review, and integration, with clear evidence of what changed and which decisions still require their attention.

## Positioning

AgentConstella connects persistent task boards and editable workflow graphs to real native CLI terminals, isolated Git worktrees, code review, and explicit local branch integration. Agent profiles and reusable skills provide context for the work; human review nodes make required decisions part of the workflow.

## Operating Context

- The product is an Electron desktop application with a React renderer. The `web` platform value describes its HTML/CSS interface; it does not imply a standalone browser application.
- Developers work with local Git repositories, task and agent worktrees, terminals, and their preferred IDE.
- Project settings, task boards, workflow configuration, conversations, and execution records persist locally. Workspace metadata is stored in SQLite.
- Provider inference uses the installed CLI and its configured account and requires provider connectivity. Local storage and Git workflows do not imply offline inference.
- Full application flows require the Electron preload bridge. Opening the renderer URL alone does not provide repository or Codex access.
- The existing development entry point is `npm run dev`; production builds use `npm run build` and `npm start`.

## Capabilities and Constraints

Existing capabilities are documented in `README.md` and implemented in the repository:

- Create or open repository projects and manage persistent To Do, Doing, and Done boards.
- Configure project briefs, instructions, development and test commands, model settings, and an IDE command.
- Manage global and project-scoped skills and agent profiles.
- Edit task graphs with agent nodes, human review nodes, dependencies, prompts, and acceptance settings.
- Execute ready agent work in isolated branches and worktrees, subject to dependencies and the configured concurrency limit.
- Inspect conversations, execution state, checks, code changes, and review outcomes.
- Use project and task manager chats to make supported task, configuration, and graph edits, with saved change history and scoped Undo.
- Preview and explicitly integrate accepted task results into the repository's base branch.

Behavior future UI work must accurately represent:

- A successful agent turn is distinct from accepting its result, completing required human review, and integrating the task.
- Reaching workflow End leaves a task awaiting integration. Integration moves it to Done.
- Human Review nodes require a human decision. Manager chat tools do not start workflows, accept results, approve human reviews, or integrate branches.
- Stopping execution retains work already performed; it does not roll back repository changes. Metadata Undo does not roll back code or restore prior approvals.
- Graph review gates are separate from runtime command permissions. Native CLI terminals own runtime permission prompts and conversation history; the app records workflow handoffs and check results.
- Project settings selects the default Codex/Claude provider for new terminals. Existing sessions retain their provider.
- UI refinements must preserve existing repository data, saved work, and workflow semantics.

The owner confirmed the audience and core purpose during initialization. Broader collaboration, additional platforms, and further product constraints remain open decisions rather than established requirements.

## Brand Commitments

The existing product name is AgentConstella. The owner's stated UI goal is to make the interface feel less generic and less AI generated. A specific visual identity, palette, typography, and reference products have not been confirmed.

## Evidence on Hand

- `README.md`: current capabilities, desktop workflows, setup, and documented limitations.
- `docs/projects-and-kanban.md`, `docs/skills-and-agents.md`, and `docs/task-graphs.md`: project, catalog, and graph behavior.
- `docs/node-execution.md`, `docs/workflow-scheduling.md`, and `docs/parallel-workflows.md`: execution, dependencies, worktrees, and integration.
- `docs/manager-chats.md` and `docs/native-terminals.md`: manager tools, runtime behavior, and transport limitations.
- `src/renderer/src/`: existing interface implementation and terminology.
- `scripts/check-graph-ui.cjs` and `scripts/check-workflow-ui.cjs`: automated desktop flow checks with screenshot support.

Repository documentation includes pending manual desktop checkpoints. Do not present those checkpoints as completed user validation, or invent customer evidence, performance claims, or guarantees.

## Product Principles

1. Keep the developer in control of execution, required reviews, and integration.
2. Make task state, dependencies, blockers, and the next available action understandable.
3. Ground progress and completion in saved state, checks, and inspectable changes.
4. Preserve repository work and make the consequences of stop, Undo, acceptance, and integration clear.
5. Keep project context and agent responsibilities available where the developer makes decisions.
