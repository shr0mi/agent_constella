// Capture the actual bundled renderer using disposable demo repositories.
// Inference is a local fixture; SQLite, Git, scheduling, reviews and IPC are real.
const { app, BrowserWindow, ipcMain } = require('electron')
const { tsImport } = require('tsx/esm/api')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
const data = mkdtempSync(join(tmpdir(), 'constella-readme-'))
const output = resolve(process.env.CONSTELLA_README_SCREENSHOTS || join(root, 'docs/assets/screenshots'))
app.setPath('userData', join(data, 'electron'))
const load = (path) => tsImport(join(root, path), __filename)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let window, database, scheduler, ending = false
const errors = []
const deadline = setTimeout(() => void finish(1, new Error('README capture timed out')), 60000)

async function finish(code, error) {
  if (ending) return
  ending = true
  clearTimeout(deadline)
  if (error) console.error(error)
  await scheduler?.shutdown()
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
  const { applicationFailure } = await load('src/main/application/errors.ts')
  const { makeWorkflowNode } = await load('src/shared/graph.ts')
  const { channels } = await load('src/shared/ipc.ts')

  const appData = join(data, 'metadata')
  database = openWorkspaceDatabase(join(appData, 'workspace.sqlite'))
  const workspace = new WorkspaceService(database)
  const catalog = new CatalogService(database, appData)
  await catalog.initialize()
  const graphs = new GraphService(database, catalog)
  let project = await workspace.createProject({ path: join(data, 'orbit') })
  project = workspace.updateProject({
    projectId: project.id,
    expectedRevision: project.revision,
    name: 'Orbit · developer workspace',
    description: 'A thoughtful release, from the first task to the final review.',
    instructions: 'Keep every interaction accessible. Prefer small, reviewable changes.',
    devCommand: 'npm run dev',
    testCommand: 'node -e "console.log(\'Demo checks passed\')"',
    ideCommand: 'code --new-window',
    maxParallelAgents: 4,
    defaultProvider: 'codex',
  })

  // No provider CLI or network calls: each demo turn writes one tiny text file.
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
  const profiles = catalog.getSnapshot({ projectId: project.id }).profiles

  async function waitFor(check, label) {
    for (let n = 0; n < 400; n++) {
      if (await check()) return
      await delay(25)
    }
    throw new Error(`Timed out: ${label}`)
  }

  async function demoWorkflow(title, description, integrate) {
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
    const frontend = node('agent', 'Build the interface', 270, 15, 'frontend-master')
    const backend = node('agent', 'Implement the API', 270, 275, 'backend-sensei')
    const verify = node('agent', 'Verify combined changes', 540, 145)
    const review = node('review', 'Review the experience', 810, 145)
    const end = node('end', 'End', 1080, 145)
    const nodes = [start, frontend, backend, verify, review, end]
    const pairs = [[start, frontend], [start, backend], [frontend, verify], [backend, verify], [verify, review], [review, end]]
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

  await demoWorkflow('Lay the project foundations', 'Repository structure, shared conventions, and the first passing checks.', true)
  const feature = await demoWorkflow('Build the onboarding experience', 'Interface and API work in parallel, followed by combined checks and human review.', false)
  workspace.createTask({ projectId: project.id, title: 'Polish keyboard navigation', description: 'Make focus states and shortcuts feel natural throughout the workspace.', status: 'doing' })
  workspace.createTask({ projectId: project.id, title: 'Add saved workspace views', description: 'Return to the projects and filters that matter most.' })
  workspace.createTask({ projectId: project.id, title: 'Write the release walkthrough', description: 'Document the first-run flow with examples and screenshots.' })

  const diagnostics = { transport: 'Native CLI terminal', cliVersion: 'Documentation demo', runtimePath: 'demo',
    auth: { status: 'signed-in', detail: 'Demo fixture; no provider authentication used.' }, models: [], checkedAt: new Date().toISOString() }
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

  window = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: {
    preload: join(root, 'out/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  window.setContentSize(1600, 1000)
  window.webContents.on('preload-error', (_event, path, error) => errors.push(`${path}: ${error}`))
  window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
  const run = (code) => window.webContents.executeJavaScript(code)
  async function route(path, ready) {
    await run(`location.hash=${JSON.stringify(path)}`)
    await waitFor(() => run(ready), path)
    await delay(300)
  }
  async function capture(name) {
    await run('document.fonts.ready')
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false)
    writeFileSync(join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  mkdirSync(output, { recursive: true })
  await window.loadFile(join(root, 'out/renderer/index.html'), { hash: `/projects/${project.id}` })
  await waitFor(() => run('document.querySelectorAll(".task-card").length === 5'), 'board')
  await capture('project-board')
  await route(`/projects/${project.id}/tasks/${feature.task.id}/graph`, 'document.querySelectorAll(".workflow-node").length === 6')
  await run(`document.querySelector('[data-id="${feature.review.id}"]').click()`)
  await run('document.querySelector(".react-flow__controls-fitview").click()')
  await delay(350)
  await capture('task-graph')
  window.setContentSize(1000, 740)
  await route('/agents', 'document.querySelectorAll(".catalog-card").length >= 2')
  await capture('agent-profiles')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', output, screenshots: ['project-board', 'task-graph', 'agent-profiles'], providerCalls: 0, rendererErrors: errors }, null, 2))
  await finish(0)
}).catch((error) => void finish(1, error))
