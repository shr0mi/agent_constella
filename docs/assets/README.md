# README visuals

All images are stored in this repository so the README does not depend on an external image host.

## Logo

`brand/agentconstella-logo.png` was generated with the built-in image generation tool. It is a transparent PNG used for the documentation identity; the application UI is unchanged.

Final generation prompt:

```text
Use case: logo-brand
Asset type: new standalone logo for the GitHub README of AgentConstella, a local desktop workspace for human and coding-agent workflows.
Primary request: Design a distinctive premium geometric constellation monogram: three linked cobalt orbital paths form an abstract capital A / open star, with a luminous four-point north star at its apex and small precise circular workflow nodes at the joints. Make the silhouette simple, cohesive and instantly readable at 96 pixels.
Style/medium: crisp vector-like brand design, precise geometry, flat rich cobalt with a small ice-blue accent, restrained dimensional shading only within the mark.
Composition/framing: one large centered symbol, square image, generous clear space, all edges contained.
Color palette: cobalt #2c54cf, midnight ink #172131, ice blue #b1c2f3. The symbol must stand out on both white and dark GitHub backgrounds.
Text: none.
Constraints: actual transparent background. Logo symbol only. No wordmark, no letters written as text, no slogan, no mockup, no device, no star field, no border, no watermark. Avoid generic AI brain icons, robots, excessive thin lines, photorealism, and visual clutter.
```

## Screenshots

The screenshots show the bundled Electron renderer at the display's native pixel density. The profile catalog uses a 1000 × 740 CSS-pixel viewport. The other captures use a 1600 CSS-pixel width, with heights chosen to frame each view.

The demo uses disposable Git repositories and real application services for workflow scheduling, checks, review, and integration. A local CLI fixture reads project context and creates a task through the app's MCP server in the Project manager capture. The fixture supplies the terminal transcript, and workflow agent responses are simulated.

| File | View |
| --- | --- |
| `screenshots/project-board.png` | Five Orbit tasks across To Do, In progress, and Done, including a pending human review and a merged task. |
| `screenshots/task-graph.png` | Parallel frontend and backend steps, combined verification, and a selected human review gate. |
| `screenshots/project-manager.png` | The Codex terminal in a Stopwatch project manager conversation that creates a session-history task through MCP. |
| `screenshots/agent-profiles.png` | The bundled global agent profiles. |
| `screenshots/projects-overview.png` | The Projects dashboard with four demo repositories and workspace totals. |
| `screenshots/integrated-task.png` | The reading-test-app board with a task marked Merged in Done. |

Regenerate from the repository root after installing dependencies:

```sh
npm run build
node_modules/.bin/electron scripts/capture-readme.cjs
```

The script needs a desktop session that can launch Electron. It uses temporary app data and Git repositories, removes the demo repositories on completion, and writes all six screenshots to `docs/assets/screenshots`. Set `CONSTELLA_README_SCREENSHOTS` to capture into a different directory.
