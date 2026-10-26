# Manager chats and local MCP

The board's **Project manager** can edit project settings, tasks and graphs within that project. A graph's **Task manager** is restricted to that task and can read project settings. Manager conversations, context packets, activity, status, errors, and resumable Codex thread IDs live in `manager_chats`, separately from node runs and the connectivity lab. Startup marks unfinished manager turns interrupted; it never reruns a request.

`ManagerService` sends role instructions as the SDK's `developer_instructions` configuration and includes a fresh project packet with every message. The packet contains project description/instructions, development and test commands, ancestor/repository `AGENTS.md`, root `README.md`, scoped task/node IDs, graph revision and validation, active profile/skill catalogs, model options, and recent execution summaries. File reads and text excerpts are bounded. Full graph data remains available through tools. Manager runs use the project directory with a read-only filesystem sandbox; application metadata changes go through MCP.

Project settings also store a default model and reasoning effort (migration 7). New manager turns inherit these live defaults; choosing a model or effort in the chat overrides them for that conversation while the panel is open. Node runs inherit the project pair unless an agent profile or the node overrides it. Explicit configured-runtime/model-default selections remain available. An inherited effort follows its model, so choosing a different model does not carry over the prior model's effort setting. The same resolution rules drive graph validation, UI labels, and run preparation.

## Transport and authority

`LocalMcpServer` uses `@modelcontextprotocol/sdk` Streamable HTTP on an ephemeral `127.0.0.1` port. It checks the exact Host header, rejects browser Origin requests, and requires a random per-turn bearer token. Tokens are passed only to the Codex subprocess environment using `bearer_token_env_var`; they are never saved to SQLite or sent to the renderer. The SDK receives the listener configuration per client, without editing user config files. Every tool invocation derives project/task identity from the credential, never from caller-supplied project identity. The server rechecks a credential before committing an operation that waited for cancellation.

Manager tokens allow these tools:

| Tool | Behavior |
| --- | --- |
| `workspace_get_context` | Live project, board or selected task/node context |
| `project_update` | Board manager only: partial project brief/instructions, development/run and test commands, name, and model/effort defaults, using the live project revision |
| `todo_create` | Create a To Do task with an optional full graph atomically |
| `todo_update` | Partial task text edits with an expected task revision |
| `todo_archive` | Reversible archive/restore; archive cancels active task execution |
| `graph_get` | Full saved document, live revision and validation |
| `graph_apply_changes` | Atomic add/update/remove node and add/remove edge operations |
| `agent_profiles_list`, `skills_list` | Existing active scoped assignments |
| `change_history`, `change_undo` | Inspect and reverse saved metadata edits |

Workers get the first context tool, graph reads, and catalog reads, restricted to their task. Managers cannot start execution, approve reviews, accept results, integrate branches, create unrestricted profiles/skills, or access other projects through this server. Worker suggestions can be described in their response for the human or manager. Tokens are revoked at turn completion/cancellation and shutdown. Inherited Codex tools/configuration remain subject to the runtime's own permissions; these scope checks protect the application MCP surface.

`project_update` is advertised only to the board project manager; the application service also rejects task-scoped calls and task-scoped Undo of project edits. It derives project identity from the authenticated session and accepts only editable settings, so callers cannot redirect an edit to another project or change its repository path. Omitted fields stay unchanged. Empty text clears a field/command, and null clears a model/effort override. Saving commands does not run them. Subsequent turns and runs receive the updated settings; started workflows retain the existing pause/revalidation behavior for configuration edits.

## Mutations and Undo

Both IPC and MCP delegate to `WorkspaceService`/`GraphService`. Graph changes use one expected revision and command UUID for the complete batch. Cycles, duplicate/missing references, invalid scoped profiles/skills, and unsupported model/effort combinations are validated by the graph service. Incomplete drafts can save. Graph edits during an active run fail with `GRAPH_ACTIVE`; an edited started workflow pauses, invalidates affected results and requires explicit resume.

Manager command receipts persist an input hash and original result in the mutation transaction. An identical retry returns its original result, and a reused UUID with different inputs fails. Task creation and optional graph validation occur in one transaction; failed graph creation leaves no task or history rows behind. UI notifications are deferred until an enclosing transaction has settled so renderers only read saved state.

Migration 6 adds `change_history` alongside conversations and command receipts. Task CRUD/order changes and graph saves record before/after metadata in the same SQLite transaction. History is scoped and limited to the latest 100 entries per view. Undo uses the original change's saved revision and the same validation services; it rejects a conflicting newer revision instead of overwriting it. Undoing creation archives the task, preserving its graph and conversation. Archiving through Undo also stops active execution. Undo itself records another reversible metadata change and marks the original entry undone. It never rewinds code, reinstates prior human approval, or resumes a workflow. An older edit may be unavailable to undo after newer saves; the UI reports the conflict and retains current data.

Migration 8 preserves existing task/graph history and allows project-level entries with no task ID. `WorkspaceService.updateProject` records settings changes from both IPC and MCP in the same mutation transaction. Board history includes project settings; task history remains task-scoped. Project Undo checks the current project revision and restores settings through the same validated service, without changing repository identity, running commands, or resuming execution.

## Verification and runtime limits

`tests/manager.test.ts` covers live MCP initialization/tool calls, bearer authentication/revocation, origin checks, worker tool restrictions, project/task isolation, atomic graph edits, assignment validation, stale writes/Undo, duplicate calls, archive cancellation, persisted history, separate manager conversations, thread continuation, context injection and interrupted-turn recovery. The normal test command needs permission to bind/connect to local loopback. Provider inference and the natural-language desktop checkpoint are left for the user.

The pinned Codex SDK uses `codex exec`. Its stream can omit nested/custom tool activity, so change history is the authoritative record of saved edits. Stop retains committed edits and partial history. A successful conversational reply alone does not prove an edit saved; tool results and history do. Account authentication/model availability are checked by the existing runtime, and provider failures remain visible in the chat. Reopening the app reissues current endpoint credentials when continuing a saved thread.

Configuration follows the official [Codex SDK configuration override documentation](https://learn.chatgpt.com/docs/codex-sdk) and [MCP HTTP/authentication configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), with types checked against the pinned installed SDK.
