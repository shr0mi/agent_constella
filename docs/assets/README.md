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

### Automated demo captures

The screenshots show the actual bundled Electron renderer, captured at the display's native pixel density. The board and graph use a 1600 × 1000 CSS-pixel viewport; the profile catalog uses a compact 1000 × 740 desktop viewport. The sample project is disposable. SQLite, Git worktrees, workflow scheduling, checks, acceptance, review, and integration use the real application services. Only provider inference is replaced with a local fixture; there are no provider calls or real account data.

| File | View |
| --- | --- |
| `screenshots/project-board.png` | Five demo tasks across To Do, Doing, and Done; a real completed integration and a pending human review. |
| `screenshots/task-graph.png` | Parallel frontend/backend nodes, a combined result, and a selected human review gate. |
| `screenshots/agent-profiles.png` | The bundled global agent profiles. |

Regenerate from the repository root after installing dependencies:

```sh
npm run build
node_modules/.bin/electron scripts/capture-readme.cjs
```

This requires a desktop session capable of launching Electron. The script isolates app data and Git repositories in a temporary directory, cleans them up on completion, and writes only the three screenshot files to the repository. Set `CONSTELLA_README_SCREENSHOTS` to capture into another directory.

### User-supplied desktop captures

These screenshots were supplied by the project owner and are copied unchanged from the attachments. They retain their original desktop window framing, terminal text, and visible project paths. The demo capture script does not overwrite them.

| File | View |
| --- | --- |
| `screenshots/projects-overview.png` | The Projects view listing reading-test-app, stopwatch, and pomodoro-timer. |
| `screenshots/project-manager.png` | A native Codex CLI manager conversation reading live context and creating a stopwatch session-history task through MCP. |
| `screenshots/integrated-task.png` | The reading-test-app board with an integrated task in Done. |
