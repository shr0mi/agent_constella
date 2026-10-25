# AgentConstella

An Electron starter for local human + Codex workflows. Milestone 1 provides a real Codex connectivity lab; projects, catalogs, graphs, and scheduling remain in later milestones.

## Run

Requires Node.js 22.12+ (or a newer supported LTS), npm, and internet access for Codex inference.

```sh
npm ci
npx codex login
npm run dev
```

The pinned SDK reuses the local Codex CLI login. Signing in to another application does not necessarily authenticate this runtime. API credentials can be supplied to the CLI environment; never put credentials in renderer code or a `VITE_*` variable.

Electron downloads its native binary on first launch if it is not cached. To prepare it explicitly:

```sh
node node_modules/electron/install.js
```

To use the production build locally:

```sh
npm run build
npm start
```

## Connectivity lab

- Refresh Connection to inspect login status, the pinned SDK/CLI versions, and runtime model/effort options.
- Send **Read a file** with **Connectivity proof** selected. A successful reply includes `CONSTELLA_SKILL_OK` and `ORBIT`, and shell activity appears in the conversation and SDK events tab.
- Send **Try cancellation**, then press **Stop** while the shell command is running.
- Send a follow-up to continue the saved thread. Quit/reopen the app to exercise continuation from disk.
- Select **Read only**, ask Codex to attempt a workspace file write, and inspect the failed tool activity. This SDK cannot present an interactive approve/deny dialog.
- **New scratch session** archives the previous metadata and creates another disposable workspace. Previous files are retained for inspection.

The desktop checkpoint is intentionally left for the user. The lab displays actual runtime failures, with no simulated successful responses.

The SDK can omit nested/custom tool events, including denied writes. A model may report a failure without a corresponding tool item in the feed. The lab and integration notes expose this limitation; use app-server before promising a complete activity/approval UI.

## Checks

```sh
npm test
npm run build
npm run probe:codex
npm run probe:codex -- --live
# Optional targeted check after a permission/transport change:
npm run probe:codex -- --live --permissions-only
```

The default probe only inspects login and runtime model options. `--live` uses your existing login and inference allowance for several short turns in a fresh temporary workspace: tools/skill output, continuation from a new client, cancellation during a shell command, continuation after cancellation, and a denied write under read-only permissions. A JSON report and temporary paths are printed; failures exit nonzero. Local Codex state must be writable and the provider must be reachable.

## Structure

```text
src/main/             Electron window, validated IPC, Codex service
src/main/codex/       Runtime discovery, lifecycle, skill resolution, atomic storage
src/preload/          Narrow typed context bridge
src/shared/           IPC contracts and Zod inputs
src/renderer/         React Router, Zustand, Tailwind, connectivity UI
scripts/              Disposable real-SDK integration probe
tests/                Lifecycle, failure, restart, and boundary tests
docs/                 Integration findings and limitations
```

Only the main process accesses Codex, the filesystem, and credentials. The renderer runs with context isolation and sandboxing. Session metadata lives in Electron's user data directory under `AgentConstella/connectivity`; the Codex thread itself remains in the active Codex home's session store. Worker files live in the operating system temporary directory, separately from app metadata. There is no SQLite project database or application MCP server yet.

Read [the integration record](docs/codex-integration.md) before implementing the full conversation UI or permission gates.
