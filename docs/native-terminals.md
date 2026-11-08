# Native CLI terminals

AgentConstella runs the user's installed **Codex CLI** or **Claude Code** in real pseudoterminals. The native CLI owns authentication, conversation context, permission prompts, commands, and tool execution.

## Provider and launch settings

Choose **Project settings → Default agent provider**. Existing projects migrate to Codex; Claude Code can be selected per project. New worker and manager terminals inherit this choice. Existing live terminals retain their provider. Model and effort overrides are passed at terminal creation; use native CLI commands to change a live session, or start a new conversation. The app no longer requires a provider model-list API to prepare a graph.

Install and authenticate the chosen CLI yourself. AgentConstella finds executables on PATH and common macOS/local installation paths. It does not install, update, replace, or copy provider credentials. Both providers receive a literal initial prompt argument, never an interpolated shell command. Native workspace trust and permission prompts remain interactive.

## Runtime and persistence

`src/main/terminal/daemon.ts` is a detached process, built to `out/main/terminal-daemon.js`. It owns node-pty processes and headless xterm screens; Electron is a client. The renderer uses xterm.js through validated, named preload operations for input, resize, output, handoff, and close. It does not receive the background service's credentials.

The service binds only to 127.0.0.1. A private descriptor contains its port and random authentication key. All control requests require that key; browser-origin requests are rejected. Session metadata and terminal transcripts live under the Electron user-data directory's `terminals/`, outside project repositories. Direct CLI interactions are retained in `terminal.ansi`, while `assignment.txt` and `session.json` preserve launch context and session state. The CLI also retains its own native chat history. No project chat file or global provider configuration is modified.

The **Terminals** view switches between sessions and opens two side by side, stacking them on narrow desktop windows. Closing a pane detaches its viewer. Quitting Electron detaches execution monitoring without stopping running CLI processes. On restart, active worker/manager assignments reconnect without resending the prompt; MCP proxies receive fresh project credentials. Workflow scheduling remains paused after restart until resumed explicitly. A reboot or terminal-service failure ends the processes. Retry or start a new conversation in that case; saved app records and terminal transcripts remain. Historical attempts remain inspectable and are not replayed automatically.

New Codex terminals launch with `--no-alt-screen`, so conversation output remains in the terminal's 5,000-line scrollback. Wheel scrolling works after handoff and after reopening a pane. Fullscreen CLI sessions retain their mouse encoding on reconnect; after handoff, only vertical wheel reports are forwarded for browsing history, while typing and clicks remain disabled. Existing fullscreen sessions keep their current display mode. The raw `terminal.ansi` transcript is retained separately and is not an unlimited scrollback viewer.

Terminal panes use xterm's WebGL renderer for scrolling, falling back to the DOM renderer when WebGL is unavailable or its context is lost. Empty output polls do not trigger terminal writes, and output parsing completes before another batch is fetched.

Normal scrollback stays local even when the CLI enables mouse tracking, so completed agent nodes remain scrollable without sending editing input. Detached services advertise support for fullscreen wheel input after handoff. Older services survive app restarts and cannot accept that input; those fullscreen sessions show one persistent explanation instead of a flashing error. Start a new terminal for normal scrollback in that case; the app does not stop running agents to upgrade their terminal service.

**Stop** ends the CLI process and cancels that assignment. It retains files. **Close terminal**, available after handoff, releases the idle process without changing accepted workflow records. Starting a fresh conversation retains prior attempt history and code.

## Agent-node view

Agent nodes use a nearly full-window terminal with one compact control row. **Open in IDE** is always available and opens that agent’s workspace. File/diff, activity, test, and snapshot tabs are removed from this view; checks and immutable execution records remain in the workflow engine. Revision input appears only after **Request revision**.

## Workflow handoff

A terminal's silence, an idle prompt, and a process exit are not workflow success.

Active worker terminals are monitored for interactive permission, trust, confirmation, and input prompts. The sidebar puts these sessions first with **Attention required**, a warning icon, and the reason. The corresponding graph node and minimap turn amber; selecting the sidebar session opens its native terminal to respond. Attention clears when the prompt disappears and normal work resumes. Results awaiting acceptance and human review also show **Attention required** in the graph, with their specific workflow state below it.

Detection reads the current terminal screen, including ANSI redraws, rather than searching transcript history or treating silence as a blocker. It also works with detached terminal services started before an app update. This is a screen-based hint: custom or localized CLI prompts may not match the recognized controls. It does not answer prompts, grant permissions, release a running agent's concurrency slot, or change the workflow handoff rules.

Worker terminals receive the existing read-only task-context MCP tools plus **agent_report_done**. The initial assignment instructs the worker to call it as its final tool, with a useful summary, only after completing the requested work. Alternatively, the developer can click **Finish step & run checks**. Manual handoff records terminal screen text as a fallback summary.

After handoff, terminal keyboard input is disabled until another explicit assignment. The existing execution engine runs configured checks, captures immutable file changes, combines results, and applies manual/automatic acceptance. Human review and final integration still require their existing decisions. A result handoff is a declaration by the agent or developer, not proof that the code is correct; configured checks, clean-worktree verification, review, and integration previews remain responsible for acceptance. Stop and Ctrl+C are distinct: typing Ctrl+C interacts with the native CLI, while the workflow Stop control ends its process.

## Managers and MCP

Opening **Project manager** or **Task manager** starts the selected saved chat's native terminal if it has not started yet. Its initial assignment supplies current project context and asks it to wait for instructions. You then type directly in the CLI. The manager uses the existing scoped MCP editing tools, so task/graph validation, revision checks, history, and Undo remain unchanged. It must refresh live context through MCP before editing. Manager tools cannot approve reviews, accept node results, start workflows, or integrate branches.

Finish the manager assignment before switching saved chats or creating a new one. The native terminal stays available for subsequent assignments. Previously saved chat metadata is retained; direct terminal input/output is stored in the local terminal transcript rather than reconstructed into a custom chat UI.

CLI sessions connect to a stable per-session MCP proxy in the terminal service. The proxy forwards to the app's authenticated MCP listener while the app is open. Session-specific tokens are passed through environment variables; they are not exposed in renderer messages or public session records. Project tools are unavailable while Electron is closed and reconnect when the app reopens. Background coding can continue during that time.

## Verification

- `npm test`: existing project/graph/review/integration coverage plus real PTY lifecycle, concurrent sessions, literal CLI arguments, MCP authentication/proxying, explicit handoff, and detached-service reconnection.
- `npm run build`: type-check and build all Electron entries, including the terminal daemon.
- `npm run test:terminal-ui`: isolated real Electron/SQLite/Git/MCP/PTY checks using test CLI executables; verifies provider settings, worker terminal rendering, checks/acceptance, and manager terminal launch. `CONSTELLA_TERMINAL_SCREENSHOT=/tmp/constella/check` adds desktop/narrow captures.
- `CONSTELLA_TERMINAL_PROFILE=/tmp/constella-scroll.json npm run test:terminal-ui`: profile real wheel scrolling through 5,000 styled history lines, recording renderer task/layout time, DOM mutations, and frame timing. UI checks also exercise scrollback after reconnect/handoff and DOM fallback when WebGL is unavailable or lost.
- `npm run test:graph-ui` and `npm run test:workflow-ui`: existing desktop regression flows.
- `npm run probe:terminal`: run the PTY integration tests without provider inference.

The automated provider processes are test CLIs. They exercise the real PTY and transport without consuming model allowance. Live provider authentication, account policy, and interactive trust prompts must be verified in the installed CLI.
