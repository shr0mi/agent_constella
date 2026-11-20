// Capture the actual bundled renderer using disposable demo repositories.
// Inference is a local fixture; SQLite, Git, scheduling, reviews and IPC are real.
const { app, BrowserWindow, ipcMain } = require('electron')
const { tsImport } = require('tsx/esm/api')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
const data = mkdtempSync(join(tmpdir(), 'constella-readme-'))
const output = resolve(process.env.CONSTELLA_README_SCREENSHOTS || join(root, 'docs/assets/screenshots'))
app.setPath('userData', join(data, 'electron'))
const load = (path) => tsImport(join(root, path), __filename)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let window, database, scheduler, managers, mcp, daemon, ending = false
const screenshots = []
const errors = []
const deadline = setTimeout(() => void finish(1, new Error('README capture timed out')), 60000)

async function finish(code, error) {
  if (ending) return
  ending = true
  clearTimeout(deadline)
  if (error) console.error(error)
  await managers?.shutdown()
  await scheduler?.shutdown()
  await mcp?.shutdown()
  if (daemon) {
    for (const session of daemon.sessions.values()) {
      if (session.record.state !== 'exited') session.process.kill()
    }
    daemon.server.closeAllConnections()
    daemon.server.close()
  }
  window?.destroy()
  database?.close()
  rmSync(data, { recursive: true, force: true })
  app.exit(code)
}

app.whenReady().then(async () => {
  const { openWorkspaceDatabase } = await load('src/main/db/database.ts')
  const { WorkspaceService } = await load('src/main/application/workspace-service.ts')
  const { CatalogService } = await load('src/main/application/catalog-service.ts')
  const { GraphService } = await load('src/main/application/graph-service.ts')
  const { NodeExecutionService } = await load('src/main/application/node-execution-service.ts')
  const { WorkflowService } = await load('src/main/application/workflow-service.ts')
  const { ManagerService } = await load('src/main/application/manager-service.ts')
  const { ManagerTools } = await load('src/main/application/manager-tools.ts')
  const { LocalMcpServer } = await load('src/main/mcp/server.ts')
  const { startDaemon } = await load('src/main/terminal/daemon.ts')
  const { TerminalHost } = await load('src/main/terminal/host.ts')
  const { NativeCliClient } = await load('src/main/terminal/client.ts')
  const { cliPath } = await load('src/main/terminal/launch.ts')
  const { applicationFailure } = await load('src/main/application/errors.ts')
  const { makeWorkflowNode } = await load('src/shared/graph.ts')
  const { channels } = await load('src/shared/ipc.ts')

  const appData = join(data, 'metadata')
  database = openWorkspaceDatabase(join(appData, 'workspace.sqlite'))
  const workspace = new WorkspaceService(database)
  const catalog = new CatalogService(database, appData)
  await catalog.initialize()
  const graphs = new GraphService(database, catalog)
  async function createProject(folder, name, description) {
    const project = await workspace.createProject({ path: join(data, folder) })
    return workspace.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name,
      description,
      instructions: 'Keep every interaction accessible. Prefer small, reviewable changes.',
      devCommand: 'npm run dev',
      testCommand: 'node -e "console.log(\'Demo checks passed\')"',
      ideCommand: 'code --new-window',
      maxParallelAgents: 4,
      defaultProvider: 'codex',
    })
  }
  const orbit = await createProject('orbit', 'Orbit · developer workspace', 'A thoughtful release, from the first task to the final review.')
  const reading = await createProject('reading-test-app', 'reading-test-app', 'Measure reading speed with a short passage, an elapsed timer, and a words-per-minute result.')
  const stopwatch = await createProject('stopwatch', 'stopwatch', 'A keyboard-friendly stopwatch with lap timing and a local session history.')
  const pomodoro = await createProject('pomodoro-timer', 'pomodoro-timer', 'A compact focus timer with configurable work and break durations.')

  // Each simulated agent turn writes one tiny text file in its worktree.
  const thread = (options) => ({
    async runStreamed(prompt) {
      const title = prompt.match(/\nNode: (.+)\n/)[1]
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: `demo-${randomUUID()}` }
        writeFileSync(join(options.workingDirectory, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`), `Demo result: ${title}\n`)
        yield { type: 'item.completed', item: { id: randomUUID(), type: 'agent_message', text: `${title} is ready for review. The configured checks passed.` } }
        yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }
      })() }
    },
  })
  const execution = new NodeExecutionService(database, graphs, catalog, appData, {
    startThread: thread,
    resumeThread: (_id, options) => thread(options),
  })
  await execution.initialize()
  scheduler = new WorkflowService(database, graphs, catalog, execution, workspace)
  await scheduler.initialize()
  const profiles = catalog.getSnapshot({ projectId: orbit.id }).profiles

  async function waitFor(check, label) {
    for (let n = 0; n < 400; n++) {
      if (await check()) return
      await delay(25)
    }
    throw new Error(`Timed out: ${label}`)
  }

  async function demoWorkflow(project, title, description, { integrate = false, parallel = true } = {}) {
    const task = workspace.createTask({ projectId: project.id, title, description,
      acceptanceCriteria: 'Keyboard navigation works, checks pass, and the result is reviewed.' })
    const identity = { projectId: project.id, taskId: task.id }
    const initial = graphs.get(identity)
    const node = (type, title, x, y, profile) => {
      const value = makeWorkflowNode(type, randomUUID(), { x, y })
      value.data.title = title
      if (type === 'agent') {
        value.data.prompt = `Complete ${title}. This is a disposable documentation demo.`
        value.data.acceptance = 'auto'
        value.data.profileId = profiles.find((p) => p.name === profile)?.id ?? null
      }
      if (type === 'review') value.data.instructions = 'Inspect the combined result, check keyboard navigation, and approve when ready.'
      return value
    }
    const start = node('start', 'Start', 0, 145)
    const frontend = node('agent', 'Build the interface', 240, parallel ? 15 : 145, 'frontend-master')
    const review = node('review', 'Review the experience', parallel ? 720 : 480, 145)
    const end = node('end', 'End', parallel ? 960 : 720, 145)
    const nodes = [start, frontend, review, end]
    const pairs = [[start, frontend], [review, end]]
    if (parallel) {
      const backend = node('agent', 'Implement the API', 240, 275, 'backend-sensei')
      const verify = node('agent', 'Verify combined changes', 480, 145)
      nodes.push(backend, verify)
      pairs.push([start, backend], [frontend, verify], [backend, verify], [verify, review])
    } else {
      pairs.push([frontend, review])
    }
    const saved = graphs.save({ ...identity, expectedRevision: initial.revision, commandId: randomUUID(),
      document: { nodes, edges: pairs.map(([a, b]) => ({ id: randomUUID(), source: a.id, target: b.id })), viewport: { x: 0, y: 0, zoom: 0.6 } } })
    await scheduler.start({ ...identity, expectedGraphRevision: saved.revision })
    await waitFor(() => scheduler.get(identity).nodes[review.id].status === 'waiting-review', title)
    if (integrate) {
      await scheduler.review({ ...identity, nodeId: review.id, expectedRevision: scheduler.get(identity).revision, decision: 'approve', note: 'Reviewed the demo result.' }, 'desktop-human')
      await waitFor(() => scheduler.get(identity).phase === 'completed', 'workflow completion')
      const preview = await scheduler.previewIntegration({ ...identity, expectedRevision: scheduler.get(identity).revision })
      assert.equal(preview.status, 'ready')
      await scheduler.integrate({ ...identity, expectedRevision: scheduler.get(identity).revision, targetBranch: preview.targetBranch, targetHead: preview.targetHead }, 'desktop-human')
    }
    return { task, identity, review }
  }

  await demoWorkflow(reading, 'Build the first reading test', 'Show a short passage, time a reading session, and calculate the reader’s words per minute.', { integrate: true, parallel: false })
  await demoWorkflow(orbit, 'Lay the project foundations', 'Repository structure, shared conventions, and the first passing checks.', { integrate: true })
  const feature = await demoWorkflow(orbit, 'Build the onboarding experience', 'Interface and API work in parallel, followed by combined checks and human review.')
  workspace.createTask({ projectId: orbit.id, title: 'Polish keyboard navigation', description: 'Make focus states and shortcuts feel natural throughout the workspace.', status: 'doing' })
  workspace.createTask({ projectId: orbit.id, title: 'Add saved workspace views', description: 'Return to the projects and filters that matter most.' })
  workspace.createTask({ projectId: orbit.id, title: 'Write the release walkthrough', description: 'Document the first-run flow with examples and screenshots.' })
  workspace.createTask({ projectId: pomodoro.id, title: 'Add configurable break durations' })

  // The manager launches a local stand-in through the normal PTY and MCP path.
  const bin = join(data, 'bin')
  mkdirSync(bin)
  const fixture = `require(${JSON.stringify(join(__dirname, 'readme-demo-codex.cjs'))})\n`
  const windows = process.platform === 'win32'
  const launcher = join(bin, windows ? 'codex.cmd' : 'codex')
  if (windows) {
    writeFileSync(join(bin, 'readme-demo.cjs'), fixture)
    writeFileSync(launcher, '@node "%~dp0readme-demo.cjs" %*\r\n')
  } else {
    writeFileSync(launcher, `#!/usr/bin/env node\n${fixture}`, { mode: 0o755 })
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  assert.equal(cliPath('codex'), launcher)
  const terminals = join(data, 'terminals')
  daemon = await startDaemon(terminals)
  const host = new TerminalHost(terminals, join(root, 'out/main/terminal-daemon.js'))
  const managerTools = new ManagerTools(database, workspace, graphs, catalog, scheduler)
  mcp = new LocalMcpServer(managerTools)
  await mcp.start()
  managers = new ManagerService(database, managerTools, mcp, (options) => new NativeCliClient(options, host))
  managers.initialize()
  const scope = { projectId: stopwatch.id, taskId: null }
  await managers.send({ ...scope, message: 'Create a task to save and display the last three stopwatch sessions.' })
  const taskTitle = 'Save and display the last three stopwatch sessions'
  await waitFor(() => workspace.getBoard({ projectId: stopwatch.id }).tasks.some((task) => task.title === taskTitle && task.status === 'todo'), 'manager creates task')
  await waitFor(async () => {
    const session = (await host.list())[0]
    return session && (await host.read({ sessionId: session.id })).data.includes('Created in To Do')
  }, 'manager terminal transcript')

  const diagnostics = { transport: 'Native CLI terminal', cliVersion: 'Documentation demo', runtimePath: launcher,
    providers: [{ provider: 'codex', available: true }],
    auth: { status: 'unknown', detail: 'Documentation demo fixture.' }, models: [], checkedAt: new Date().toISOString() }
  const state = { session: { id: randomUUID(), workspace: data, createdAt: new Date().toISOString(), runs: [] }, diagnostics }
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, input) => {
    try { return { ok: true, value: await action(input) } }
    catch (error) { return { ok: false, error: applicationFailure(error) } }
  })
  handle(channels.state, () => state)
  handle(channels.diagnostics, () => diagnostics)
  handle(channels.workspaceSnapshot, () => workspace.getSnapshot())
  handle(channels.catalogSnapshot, (input) => catalog.getSnapshot(input))
  handle(channels.graphGet, (input) => graphs.get(input))
  handle(channels.taskExecution, (input) => ({ ...execution.getTask(input), workflow: scheduler.get(input) }))
  handle(channels.nodeSessions, () => execution.listSessions())
  handle(channels.workflowGet, (input) => scheduler.get(input))
  handle(channels.managerGet, (input) => managers.get(input))
  handle(channels.managerList, (input) => managers.list(input))
  handle(channels.managerHistory, (input) => managerTools.history(input))
  handle(channels.terminalRead, (input) => host.read(input))
  handle(channels.terminalResize, (input) => host.resize(input))

  window = new BrowserWindow({ show: false, width: 1600, height: 1090, webPreferences: {
    preload: join(root, 'out/preload/index.cjs'), backgroundThrottling: false,
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  window.setContentSize(1600, 1090)
  window.webContents.on('preload-error', (_event, path, error) => errors.push(`${path}: ${error}`))
  window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
  const run = (code) => window.webContents.executeJavaScript(code)
  async function route(path, ready) {
    await run(`location.hash=${JSON.stringify(path)}`)
    await waitFor(() => run(ready), path)
  }
  async function capture(name) {
    await run('document.fonts.ready')
    await run(`Promise.allSettled(document.getAnimations().filter(animation =>
      Number.isFinite(animation.effect.getComputedTiming().endTime)
    ).map(animation => animation.finished)).then(() => undefined)`)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false)
    writeFileSync(join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    screenshots.push(name)
  }
  mkdirSync(output, { recursive: true })
  await window.loadFile(join(root, 'out/renderer/index.html'), { hash: '/projects' })
  await route('/projects', 'document.querySelectorAll(".project-card").length === 4 && !!document.querySelector(".dash-agents")')
  await run(`(async () => {
    const stats = document.querySelector('.dash-stats')
    await Promise.allSettled(stats.getAnimations().map(animation => animation.finished))
    stats.scrollIntoView({ block: 'start' })
    document.querySelector('.projects-page').scrollTop -= 8
  })()`)
  assert.ok(await run('document.querySelector(".project-card:last-child").getBoundingClientRect().bottom < innerHeight'))
  await capture('projects-overview')
  window.setContentSize(1600, 1150)
  await route(`/projects/${orbit.id}`, 'document.querySelectorAll(".task-card").length === 5 && !!document.querySelector(".task-status-chip.tone-you") && !!document.querySelector(".task-status-chip.tone-merged")')
  await capture('project-board')
  window.setContentSize(1600, 1100)
  await route(`/projects/${orbit.id}/tasks/${feature.task.id}/graph`, 'document.querySelectorAll(".workflow-node").length === 6')
  await run(`document.querySelector('[data-id="${feature.review.id}"]').click()`)
  await run('document.querySelector(".react-flow__controls-fitview").click()')
  await waitFor(() => run('document.querySelector(".graph-details")?.innerText.includes("Waiting for human")'), 'review details')
  await delay(350)
  await capture('task-graph')
  window.setContentSize(1600, 1090)
  await route(`/projects/${reading.id}`, 'document.querySelectorAll(".task-card").length === 1 && !!document.querySelector(".task-status-chip.tone-merged")')
  await capture('integrated-task')

  window.setContentSize(1600, 930)
  await route(`/projects/${stopwatch.id}`, `document.querySelector(".project-board-page")?.innerText.includes(${JSON.stringify(taskTitle)})`)
  await run('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Project manager").click()')
  await waitFor(() => run('document.querySelector(".manager-panel .terminal-toolbar")?.innerText.includes("Interactive terminal")'), 'manager terminal')
  await capture('project-manager')

  window.setContentSize(1000, 740)
  await route('/agents', 'document.querySelectorAll(".catalog-card").length >= 2')
  await capture('agent-profiles')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', output, screenshots, providerCalls: 0, rendererErrors: errors }, null, 2))
  await finish(0)
}).catch((error) => void finish(1, error))
