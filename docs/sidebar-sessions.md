# Sidebar sessions

**Sessions** shows the latest attempt for each existing agent node in nonarchived tasks across all projects. A new attempt replaces that node’s earlier result in the list. Nodes without attempts and nodes removed from their saved graph do not appear.

| Indicator | Label | Meaning |
| --- | --- | --- |
| Grey dot | Running | The attempt is preparing, running, running checks, or stopping. |
| Yellow dot | Needs attention | The result awaits acceptance, or the latest attempt/result failed, stopped, was interrupted, or became stale. |
| Green check | Done | The latest attempt completed and that exact result was accepted. |

**Done** describes an accepted node result. Task integration remains a separate action; other workflow nodes or human reviews may still be pending. Native CLI permission prompts remain in the terminal and are not detected as a separate attention signal here.

Attention entries appear first, followed by running entries. The **Recent** group below them contains up to eight completed, accepted node results. Each group shows the most recently updated entries first. The Sessions count includes running and attention entries only.

Each row shows the node’s current name, its status, and its project. Hover for the full name, status reason, project, and task. Click a row to open the matching task graph and agent node workspace. The matching row is highlighted while its node is open.

The list refreshes automatically after execution, workflow, graph, or workspace changes. Before any runs exist, it prompts you to run an agent node. If refresh fails, existing entries stay visible with an outdated notice and **Retry**. An initial load failure also offers **Retry**.

Sessions shares the sidebar’s scrolling region with navigation and projects. The workspace identity and bottom links stay in place.

## Verification

The workflow UI fixture covers running, attention, and done states at desktop (1440 × 800) and narrow desktop (1000 × 740) viewports. To build and capture the fixture, use an absolute output prefix:

```sh
npm run build
CONSTELLA_SESSIONS_SCREENSHOT=/absolute/path/sidebar node_modules/.bin/electron scripts/check-workflow-ui.cjs
```

The capture writes state and viewport suffixes such as `sidebar.sessions-running.desktop.png` and `sidebar.sessions-done.narrow.png`.
