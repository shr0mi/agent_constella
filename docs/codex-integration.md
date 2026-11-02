# Milestone 1: Codex integration record

> Historical SDK implementation record. Current execution and manager behavior is documented in [Native terminals](native-terminals.md).

Implementation date: 25 October 2026. The manual Electron checkpoint is pending user verification; milestone 1 is not checked off automatically.

## Runtime and architecture

- `@openai/codex-sdk` **0.164.0**, with its transitive native `@openai/codex` **0.164.0**, are pinned by the package manifest and lockfile. The desktop app's bundled alpha CLI is not used.
- Electron **45.0.0**, electron-vite **6.0.0**, React **19.3.1**, React Router **7.18.4**, TypeScript **7.0.2**, Tailwind **4.3.3**, and Zustand **5.0.16** supply the starter.
- The SDK stays in the main process as an external dependency. It starts `codex exec` and consumes JSONL events. Electron's renderer has no Node access and receives only named preload operations. Main checks the calling WebContents/frame and validates run payloads using Zod.
- One service slot runs one conversation turn at a time. Working directory, environment, executable, and arbitrary config cannot be supplied through the renderer. All work uses an app-created scratch directory with an ownership marker.
- The service saves the `thread.started` ID immediately and upserts items by ID. A turn succeeds only after `turn.completed`; stream errors, `turn.failed`, and premature EOF remain failed. Tool failures are visible even when the model completes its turn successfully. A completed model turn is not acceptance of a task.
- Application metadata is saved atomically outside the agent-writable workspace. On restart, unfinished turns become interrupted; the service never reruns a prompt automatically. New scratch sessions archive the previous metadata. There is no archive browser yet.

## Authentication

The SDK inherits the main process environment and local CLI configuration/authentication. The app never reads or sends the login token to the renderer. The pinned CLI's `login status` reports only a preflight result; model inference is the actual authentication/access check. `npx codex login` from the repository selects the pinned executable.

Different `CODEX_HOME` values, a GUI application's environment, expired credentials, and provider/account access can produce different results from the host Codex desktop chat. Missing/expired authentication is a visible failure, with a login hint. No login web flow is embedded in this starter.

## Stream and tool events

The installed SDK defines `thread.started`, `turn.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed`, `turn.failed`, and `error`. Item types include assistant text, reasoning summaries, shell commands, file changes, MCP calls, web searches, plans, and tool errors.

The live CLI emits `exit_code: null` for a running command although the SDK declaration types it as an optional number. The adapter checks for a numeric exit code explicitly; a regression check covers this observed mismatch.

**Observed event coverage gap:** a read-only write attempted through the runtime's nested `exec` wrapper returned a genuine `operation not permitted` tool result in the generated Codex session log, but the SDK's canonical JSONL stream emitted only assistant messages and turn lifecycle events. The filesystem also confirmed no file was created. Nested/custom tools are not guaranteed to appear as `command_execution` or `mcp_tool_call` items. The app displays emitted failures and model reports, and explicitly labels this limitation; it cannot promise a complete tool audit or reliable permission-wait state through this transport. The probe can consult only its own generated thread log to corroborate a missing denial event. The production app does not depend on that private log format.

The app stores and displays these events, replaces updated items by ID, and exposes a run configuration/skill/prompt snapshot. This transport does **not** expose guaranteed token deltas or continuously streamed stdout. A tool can appear running without providing output until it finishes. The transcript retains the most recent 300 events per turn; individual large strings are clipped at 24,000 characters. Codex owns the original thread history.

## Cancellation and saved continuation

`runStreamed(prompt, { signal: controller.signal })` accepts an AbortSignal. **Stop** aborts that invocation; it does not roll back files. The UI stays in Stopping until the SDK iterator exits. If completion has already arrived, the turn remains completed. An abort before any thread ID is emitted cannot be resumed; a later message starts a new thread in that case.

Every follow-up reconstructs a thread with `resumeThread(savedId, options)`. This exercises the persisted ID rather than relying on a live in-memory Thread object, and lets run configuration changes apply on the next turn. Continue sends a new user turn; it does not revive the old subprocess. Removing Codex's own session data or its scratch directory can break continuation. Scratch directories are disposable OS temporary storage, not permanent project worktrees.

## Selected skills

The SDK's typed inputs support text and local images, with no typed skill input or skills-list API. The application stages a small fixture skill under the scratch workspace's `.agents/skills/connectivity-proof/SKILL.md`, saves its exact contents and path per run, and injects the selected instructions and resource path into the prompt. The skill asks Codex to read `workspace-proof.txt` and return `CONSTELLA_SKILL_OK` with `ORBIT`.

Unselecting the demo skill removes its staged directory for future native discovery. Milestone 3 adds global/project catalogs and explicit profile/skill resolution: selected catalog resources are archived in app data and staged under the scratch workspace's `.constella/skills/<run-id>/<skill-id>/`; the resolved profile, style guide, project brief, SKILL.md contents, and staged resource paths are supplied to the SDK. See [the catalog implementation record](skills-and-agents.md).

Previous instructions remain part of an existing thread's history; start a new session to eliminate that history. Changing the lab project always creates a fresh scratch session. This remains explicit instruction resolution, **not** an exclusive native skill allowlist. Inherited user configuration and installed skills may still be discovered by Codex. Catalog removal preserves the source folder and does not alter Codex's native discovery configuration.

## Models and effort

The TypeScript SDK takes a model string but does not list models or validate account access. Its effort union is `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`.

The auxiliary diagnostics client starts the **same pinned native CLI** in `app-server` mode, initializes it, pages through `model/list`, filters returned effort values against that SDK union, and closes the process. It never creates a conversation or handles approvals. Initialization/catalog failures are shown; the configured-default option remains usable. The UI does not present the entire SDK union as supported by every model, and the execution service rejects a model/effort combination absent from the retrieved catalog.

The initial local catalog returned seven models: GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna. Their supported effort options come from the live catalog. These observations are account/runtime specific; a catalog listing is not proof that a particular inference request will succeed.

## Permission interaction: decision needed before full UI

The SDK exposes `approvalPolicy` values `never`, `on-request`, `on-failure`, and `untrusted`, plus sandbox options. Its event union has **no approval request**, and there is **no approve/deny callback**. A policy option alone does not supply a bidirectional approval UI.

This starter explicitly uses `approvalPolicy: 'never'`, workspace writes or read-only access, disabled web search, and disabled network access for tools. Provider inference still requires the internet. It does not select full access or retry with weaker permissions. Emitted tool failures and run errors are visible; nested tool denials can be missing from the SDK feed as described above. Sandbox controls are provided by the local Codex runtime and OS; the app does not add container isolation. Inherited CLI configuration, MCP tools, and managed policies also affect behavior and must be addressed before broader execution is offered.

**Before adding actual approval gates, choose either:**

1. Keep the TypeScript SDK and explicitly support noninteractive execution with visible restrictions.
2. Move the transport adapter to Codex app-server for bidirectional approval requests, native skill inputs, model/auth APIs, and richer streaming. Keep the service boundary so the renderer does not depend on transport details.

The graph's human review/acceptance gates are a separate application concern and must never be treated as runtime command approvals.

## Verification

`npm test` covers item updates, selected-skill snapshots, thread restoration, overlapping starts, cancellation signals, continuation after stop, fatal/permission/auth errors, EOF without completion, interrupted-run recovery, corrupt metadata, storage failures, and IPC option boundaries. These injected-client tests are lifecycle checks, not proof of provider access.

`npm run build` typechecks main/preload/renderer and creates all three production bundles.

`npm run probe:codex` inspects the pinned login and model/effort catalog. `npm run probe:codex -- --live` performs real inference in a new disposable workspace and reports each observed behavior. It retains a JSON report and the scratch files under printed temporary paths. The live probe requires a writable Codex home and provider connectivity; a host sandbox can block these even when the code is correct.

### Observed results on 25 October 2026

| Check                                                   | Result                                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned authentication and real inference                | Passed with the existing ChatGPT login                                                                                                    |
| Streamed assistant output and shell tool lifecycle      | Passed; real `item.started`, `item.completed`, and turn events observed                                                                   |
| Selected skill and workspace resources                  | Passed; the reply included `CONSTELLA_SKILL_OK`, `ORBIT`, and the shell read the staged skill and fixture                                 |
| Saved thread continuation from a new service/SDK client | Passed; recalled `COMET` from the earlier turn                                                                                            |
| Stop during `sleep 30`                                  | Passed; cancellation settled in 7 ms after the running tool event                                                                         |
| Continue after stop using another new client            | Passed; replied `RESUMED COMET` in the same thread                                                                                        |
| Catalog-selected model and effort                       | Passed with `gpt-6.1-sol` and `low`                                                                                                       |
| Read-only write restriction                             | Passed; write denied and file absent. The nested tool error was verified in the generated thread log, but omitted from the SDK event feed |
| Typecheck, production bundles, and lifecycle checks     | Passed; 13 tests including built-preload sandbox compatibility                                                                            |
| Desktop execute / stop / continue walkthrough           | Pending user checkpoint                                                                                                                   |

The first probe exposed the nullable command exit-code mismatch. After that fix, all conversation and cancellation checks passed, while the permission check exposed incomplete SDK event coverage. A targeted follow-up (`npm run probe:codex -- --live --permissions-only`) corroborated the actual denial and verified an explicit model/effort combination. The probe now distinguishes canonical tool events from probe-only evidence in its own Codex session log; it does not count a model's assertion as proof of a denied write.

The initial catalog returned seven models; the later refresh returned an additional `gpt-5.5` entry. The application always uses the current runtime response rather than a fixed model list.

### Preload startup repair

The first desktop run exposed a build boundary error: importing channel constants from the validation module left an external `require('zod')` in the preload. Electron's sandbox cannot load that package, so the bridge was never exposed. Channel constants now live in a dependency-free module, bridge interfaces use type-only imports, and dependency externalization is disabled for preload builds. Sandboxing and context isolation remain enabled.

A regression test builds the actual preload configuration and executes its output with only Electron available to `require`; it reproduced the Zod load failure before the fix and passes afterward. A hidden native Electron window using a temporary profile also verified all six bridge methods, a successful IPC response, and the absence of Node globals in the renderer. Preload errors are now printed in the launch terminal, and the renderer's fallback message accounts for desktop preload failures.

## Sources

- [Official Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)
- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- The installed `@openai/codex-sdk@0.164.0` README, exported TypeScript declarations, and implementation in `node_modules/@openai/codex-sdk/dist/` are the authority for the pinned version's actual surface.
- [electron-vite getting started](https://electron-vite.org/guide/)
- [Electron sandboxed preload restrictions](https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts)
