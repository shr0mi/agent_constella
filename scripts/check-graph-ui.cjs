const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
// Runs the real bundled renderer and sandboxed preload against isolated IPC fixtures.
// SQLite/admission behavior is covered separately by tests/graphs.test.ts.
const root = resolve(__dirname, '..')
const data = mkdtempSync(join(tmpdir(), 'constella-graph-ui-'))
app.setPath('userData', data)
const now = new Date().toISOString()
const project = {
  id: randomUUID(),
  repoPath: '/tmp/graph-ui-fixture',
  name: 'Constella studio',
  description: 'Build thoughtful tools for human and agent teams.',
  instructions: '',
  devCommand: '',
  testCommand: '',
  revision: 1,
  createdAt: now,
  updatedAt: now,
}
const task = {
  id: randomUUID(),
  projectId: project.id,
  title: 'Build the onboarding experience',
  description: 'Create an accessible welcome flow with clear next steps.',
  acceptanceCriteria:
    'Keyboard navigation works and the layout adapts to small windows.',
  status: 'todo',
  position: 0,
  revision: 1,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
}
const skills = ['interface-style', 'project-checks'].map((name, index) => ({
  id: randomUUID(),
  projectId: index ? project.id : null,
  name,
  description: 'Use semantic elements and deliberate spacing.',
  folderPath: '/tmp/fixture',
  revision: 1,
  contentHash: 'fixture',
  removedAt: null,
  createdAt: now,
  updatedAt: now,
}))
const profiles = ['Frontend builder', 'Project reviewer'].map(
  (name, index) => ({
    id: randomUUID(),
    projectId: index ? project.id : null,
    name,
    roleInstructions: 'Build a precise, accessible interface.',
    styleGuide: 'Use clear names and concise copy.',
    skillIds: [skills[index].id],
    model: 'fixture-model',
    effort: 'low',
    revision: 1,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
  }),
)
const diagnostics = {
  sdkVersion: '0.164.0',
  cliVersion: 'codex-cli 0.164.0',
  runtimePath: 'fixture',
  auth: { status: 'signed-in', detail: 'fixture' },
  models: [
    {
      id: 'fixture-model',
      name: 'Fixture model',
      isDefault: true,
      efforts: ['low', 'high'],
    },
  ],
  checkedAt: now,
}
const state = {
  session: {
    id: randomUUID(),
    workspace: '/tmp/fixture',
    createdAt: now,
    runs: [],
  },
  diagnostics,
}
const result = (value) => ({ ok: true, value })
const nodes = ['start', 'agent', 'review', 'end'].map((type, index) => ({
  id: randomUUID(),
  type,
  position: { x: 40 + index * 270, y: 140 },
  data:
    type === 'agent'
      ? {
          title: 'Build welcome flow',
          prompt: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          profileId: null,
          skillIds: [],
          acceptance: 'manual',
        }
      : type === 'review'
        ? {
            title: 'Design & usability review',
            instructions: 'Review keyboard behavior and the welcome copy.',
          }
        : { title: type === 'start' ? 'Start' : 'End' },
}))
let snapshot = {
  project,
  task,
  revision: 1,
  document: {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: randomUUID(),
      source: nodes[index].id,
      target: node.id,
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  validation: {
    valid: false,
    canSave: true,
    issues: [],
    topologicalOrder: nodes.map((node) => node.id),
  },
  prepared: null,
  updatedAt: now,
}
let saves = 0,
  prepares = 0
ipcMain.handle('constella:state', () => result(state))
ipcMain.handle('constella:diagnostics', () => result(diagnostics))
ipcMain.handle('constella:workspace:snapshot', () =>
  result({ revision: 1, projects: [project], tasks: [task] }),
)
ipcMain.handle('constella:catalog:snapshot', () =>
  result({ projectId: project.id, revision: 1, skills, profiles }),
)
ipcMain.handle('constella:graph:get', () => result(snapshot))
ipcMain.handle('constella:graph:save', (_event, input) => {
  assert.equal(input.expectedRevision, snapshot.revision)
  snapshot = {
    ...snapshot,
    revision: snapshot.revision + 1,
    document: structuredClone(input.document),
    prepared: null,
  }
  saves++
  return result(snapshot)
})
ipcMain.handle('constella:graph:prepare', (_event, input) => {
  assert.equal(input.expectedRevision, snapshot.revision)
  assert(
    snapshot.document.nodes.find((node) => node.type === 'agent').data
      .profileId,
  )
  snapshot = { ...snapshot, prepared: { revision: snapshot.revision, at: now } }
  prepares++
  return result({
    projectId: project.id,
    taskId: task.id,
    revision: snapshot.revision,
    checkedAt: now,
    nodeOrder: snapshot.document.nodes.map((node) => node.id),
    executionAvailable: false,
  })
})
const errors = []
const timeout = setTimeout(() => {
  console.error('Graph UI check timed out', errors)
  finish(1)
}, 30000)
function finish(code) {
  clearTimeout(timeout)
  rmSync(data, { force: true, recursive: true })
  app.exit(code)
}
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1540,
      height: 1060,
      webPreferences: {
        preload: join(root, 'out/preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.webContents.on('preload-error', (_event, path, error) =>
      errors.push(`${path}: ${error}`),
    )
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
    const route = `/projects/${project.id}/tasks/${task.id}/graph`
    await window.loadFile(join(root, 'out/renderer/index.html'), {
      hash: route,
    })
    const run = (code) => window.webContents.executeJavaScript(code)
    async function waitFor(code) {
      for (let n = 0; n < 140; n++) {
        if (await run(code)) return
        await new Promise((resolve) => setTimeout(resolve, 35))
      }
      throw new Error(`DOM check failed: ${code}`)
    }
    const click = (text) =>
      run(
        `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`,
      )
    const select = (selector, value) =>
      run(
        `{ const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); }`,
      )
    const text = (selector, value) =>
      run(
        `{ const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); }`,
      )
    await waitFor('document.querySelectorAll(".workflow-node").length === 4')
    assert(
      await run(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Check readiness").disabled',
      ),
    )
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await waitFor('!!document.querySelector("#graph-node-profile")')
    assert(
      (
        await run('document.querySelector("#graph-node-profile").textContent')
      ).includes('Frontend builder · Global'),
    )
    assert(
      (
        await run('document.querySelector("#graph-node-profile").textContent')
      ).includes('Project reviewer · Project'),
    )
    await select('#graph-node-profile', profiles[0].id)
    await text('#graph-node-title', 'Create a welcoming first run')
    await select('#graph-node-effort', 'high')
    await select('#graph-node-acceptance', 'auto')
    await run(
      'document.querySelectorAll(".catalog-skill-choice input")[1].click()',
    )
    await waitFor(
      'document.querySelector(".graph-validation strong").textContent === "Graph is valid"',
    )
    await click('Save graph')
    await waitFor(
      'document.querySelector(".graph-heading p").textContent.includes("Revision 2") && !document.querySelector(".graph-heading p").textContent.includes("Unsaved")',
    )
    assert.equal(
      snapshot.document.nodes[1].data.title,
      'Create a welcoming first run',
    )
    assert.equal(snapshot.document.nodes[1].data.effort, 'high')
    assert.equal(snapshot.document.nodes[1].data.acceptance, 'auto')
    assert(snapshot.document.nodes[1].data.skillIds.includes(skills[1].id))
    await click('Check readiness')
    await waitFor(
      'document.querySelector(".graph-notice")?.textContent.includes("passed readiness")',
    )
    // Form connection attempts use the same graph validation as canvas connections.
    await select('#graph-connect-source', nodes[2].id)
    await select('[aria-label="Connection target"]', nodes[1].id)
    await click('Connect')
    await waitFor(
      'document.querySelector(".graph-connection-error")?.textContent.includes("cycle")',
    )
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 3')
    await run(
      'document.querySelector(".graph-connection-error button").click()',
    )
    // Move to review details and verify it has no autoaccept control.
    await run(
      'document.querySelectorAll(".graph-structure > button")[2].click()',
    )
    await waitFor('!!document.querySelector("#graph-review-instructions")')
    assert.equal(
      await run('!!document.querySelector("#graph-node-acceptance")'),
      false,
    )
    assert(
      (
        await run('document.querySelector(".graph-human-note").textContent')
      ).includes('cannot auto accept'),
    )
    // Add and remove a draft node using editor controls.
    await run(
      'Array.from(document.querySelectorAll(".graph-palette button")).find(b=>b.textContent.includes("Agent task")).click()',
    )
    await waitFor('document.querySelectorAll(".workflow-node").length === 5')
    await click('Delete node & its connections')
    await waitFor('document.querySelectorAll(".workflow-node").length === 4')
    // Select, rewire, and remove an edge, then restore it via the form.
    await run(
      'document.querySelectorAll(".graph-structure > button")[4].click()',
    )
    await waitFor('!!document.querySelector("#graph-edge-source")')
    await select('#graph-edge-target', nodes[2].id)
    await waitFor(
      `document.querySelector('#graph-edge-target').value === '${nodes[2].id}'`,
    )
    await select('#graph-edge-target', nodes[1].id)
    await click('Delete connection')
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 2')
    await select('#graph-connect-source', nodes[0].id)
    await select('[aria-label="Connection target"]', nodes[1].id)
    await click('Connect')
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 3')
    await click('Save graph')
    await waitFor(
      'document.querySelector(".graph-heading p").textContent.includes("Revision 3")',
    )
    // Reopen the actual built route and make sure node data is restored.
    await run("location.hash = '/projects'")
    await waitFor('!!document.querySelector(".projects-page")')
    await run(`location.hash = ${JSON.stringify(route)}`)
    await waitFor('document.querySelectorAll(".workflow-node").length === 4')
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await waitFor(
      'document.querySelector("#graph-node-title")?.value === "Create a welcoming first run"',
    )
    assert.equal(
      await run('document.querySelector("#graph-node-effort").value'),
      'high',
    )
    // Mouse events exercise React Flow dragging without focusing a real window.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const beforeDrag = snapshot.document.nodes[1].position
    const box = await run(
      'document.querySelectorAll(".react-flow__node")[1].getBoundingClientRect().toJSON()',
    )
    const start = { x: Math.round(box.left + 50), y: Math.round(box.top + 35) }
    await run(
      `document.querySelectorAll('.react-flow__node')[1].dispatchEvent(new MouseEvent('mousedown', {bubbles:true, view:window, button:0, buttons:1, clientX:${start.x}, clientY:${start.y}}))`,
    )
    await run(
      `window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, view:window, button:0, buttons:1, clientX:${start.x + 65}, clientY:${start.y + 50}}))`,
    )
    await run(
      `window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, view:window, button:0, buttons:1, clientX:${start.x + 85}, clientY:${start.y + 70}}))`,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    await run(
      `window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, view:window, button:0, buttons:0, clientX:${start.x + 85}, clientY:${start.y + 70}}))`,
    )
    await waitFor(
      'document.querySelector(".graph-heading p").textContent.includes("Unsaved")',
    )
    await click('Save graph')
    await waitFor(
      'document.querySelector(".graph-heading p").textContent.includes("Revision 4")',
    )
    assert.notDeepEqual(snapshot.document.nodes[1].position, beforeDrag)
    await waitFor(
      'document.querySelectorAll(".react-flow__edge").length === 3 && Array.from(document.querySelectorAll(".react-flow__node")).every(node => node.style.visibility !== "hidden")',
    )
    // Skill checkboxes must retain their compact layout inside graph settings.
    await run(
      'document.querySelector(".catalog-skill-selector").scrollIntoView()',
    )
    assert(
      (await run(
        'document.querySelector(".catalog-skill-choice input").getBoundingClientRect().width',
      )) < 25,
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (process.env.CONSTELLA_GRAPH_SCREENSHOT)
      writeFileSync(
        process.env.CONSTELLA_GRAPH_SCREENSHOT,
        (await window.webContents.capturePage()).toPNG(),
      )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify(
        {
          result: 'PASS',
          nodes: 4,
          canvasEdges: 3,
          scopedAssignments: true,
          savedSettings: true,
          cycleRejected: true,
          reviewHumanOnly: true,
          nodeAndEdgeEditing: true,
          routeReopened: true,
          saves,
          prepares,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    )
    window.destroy()
    finish(0)
  })
  .catch((error) => {
    console.error(error, errors)
    finish(1)
  })
