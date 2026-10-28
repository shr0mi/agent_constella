const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const captureUi = require('./ui-capture.cjs')
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
  defaultModel: null,
  defaultEffort: null,
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
let projectDeleted = false,
  confirmProjectDeletion = false,
  deletionRequests = 0
ipcMain.handle('constella:state', () => result(state))
ipcMain.handle('constella:diagnostics', () => result(diagnostics))
ipcMain.handle('constella:workspace:snapshot', () =>
  result({
    revision: project.revision,
    projects: projectDeleted ? [] : [project],
    tasks: projectDeleted ? [] : [task],
  }),
)
ipcMain.handle('constella:workspace:delete-project', (event, input) => {
  assert.equal(input.projectId, project.id)
  assert.equal(input.expectedRevision, project.revision)
  deletionRequests++
  if (!confirmProjectDeletion) return result(false)
  projectDeleted = true
  event.sender.send('constella:workspace:changed', {
    revision: project.revision + 1,
    projects: [],
    tasks: [],
  })
  return result(true)
})
ipcMain.handle('constella:workspace:update-project', (event, input) => {
  assert.equal(input.projectId, project.id)
  assert.equal(input.expectedRevision, project.revision)
  const {
    projectId: _projectId,
    expectedRevision: _expectedRevision,
    ...fields
  } = input
  Object.assign(project, fields, { revision: project.revision + 1 })
  event.sender.send('constella:workspace:changed', {
    revision: project.revision,
    projects: [project],
    tasks: [task],
  })
  return result(project)
})
ipcMain.handle('constella:catalog:snapshot', () =>
  result({ projectId: project.id, revision: 1, skills, profiles }),
)
ipcMain.handle('constella:graph:get', () => result(snapshot))
const managerConversations = new Map()
const managerSelections = new Map()
const managerScopeKey = (scope) =>
  `${scope.projectId}:${scope.taskId ?? 'board'}`
function managerChat(scope) {
  const key = managerScopeKey(scope)
  if (!managerConversations.has(key)) {
    const chat = {
      projectId: scope.projectId,
      taskId: scope.taskId ?? null,
      id: randomUUID(),
      createdAt: now,
      threadId: randomUUID(),
      turns: [
        {
          id: randomUUID(),
          message: scope.taskId
            ? 'Earlier task conversation'
            : 'Earlier project conversation',
          context: '{}',
          startedAt: now,
          status: 'completed',
          items: [],
        },
      ],
    }
    managerConversations.set(key, [chat])
    managerSelections.set(key, chat.id)
  }
  return managerConversations
    .get(key)
    .find((chat) => chat.id === managerSelections.get(key))
}
ipcMain.handle('constella:manager:get', (_event, scope) =>
  result(managerChat(scope)),
)
ipcMain.handle('constella:manager:history', () => result([]))
ipcMain.handle('constella:manager:list', (_event, scope) => {
  const current = managerChat(scope)
  return result(
    managerConversations.get(managerScopeKey(scope)).map((chat) => ({
      ...scope,
      id: chat.id,
      title: chat.turns[0]?.message ?? 'New conversation',
      createdAt: chat.createdAt,
      updatedAt: chat.createdAt,
      turnCount: chat.turns.length,
      current: chat.id === current.id,
    })),
  )
})
ipcMain.handle('constella:manager:new-chat', (event, input) => {
  assert.equal(managerChat(input).id, input.expectedChatId)
  const chat = {
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    id: randomUUID(),
    createdAt: now,
    turns: [],
  }
  managerConversations.get(managerScopeKey(input)).push(chat)
  managerSelections.set(managerScopeKey(input), chat.id)
  event.sender.send('constella:manager:changed', {
    projectId: input.projectId,
    taskId: input.taskId,
  })
  return result(chat)
})
ipcMain.handle('constella:manager:select-chat', (event, input) => {
  assert.equal(managerChat(input).id, input.expectedChatId)
  const chat = managerConversations
    .get(managerScopeKey(input))
    .find((chat) => chat.id === input.chatId)
  assert(chat)
  managerSelections.set(managerScopeKey(input), chat.id)
  event.sender.send('constella:manager:changed', {
    projectId: input.projectId,
    taskId: input.taskId,
  })
  return result(chat)
})
const attempts = []
let activeRun = null,
  threadId
const worktree = {
  taskId: task.id,
  projectId: project.id,
  path: '/tmp/constella-task-fixture',
  branch: `codex/constella-${task.id}`,
  baseRevision: 'baseline',
  sourceHead: 'source',
  sourceBranch: 'main',
  state: 'ready',
  createdAt: now,
}
ipcMain.handle('constella:node:task', () =>
  result({
    projectId: project.id,
    taskId: task.id,
    worktree: attempts.length ? worktree : null,
    active: activeRun,
    nodeStates: attempts.length
      ? [
          {
            nodeId: nodes[1].id,
            runId: attempts.at(-1).id,
            status: attempts.at(-1).status,
          },
        ]
      : [],
  }),
)
ipcMain.handle('constella:node:get', (_event, input) =>
  result({
    ...input,
    worktree: attempts.length ? worktree : null,
    threadId,
    runs: attempts,
    active: activeRun,
  }),
)
ipcMain.handle('constella:node:start', (event, input) => {
  assert.equal(input.nodeId, nodes[1].id)
  assert.equal(input.expectedGraphRevision, snapshot.revision)
  assert.equal(activeRun, null)
  const previous = attempts.at(-1)
  const run = {
    id: randomUUID(),
    projectId: project.id,
    taskId: task.id,
    nodeId: nodes[1].id,
    graphRevision: snapshot.revision,
    mode: input.mode,
    prompt: input.message ?? nodes[1].data.prompt,
    resolvedPrompt: 'Resolved task prompt with fixture profile and skills.',
    options: { sandbox: 'workspace-write', skillIds: [skills[0].id] },
    skillSnapshots: [],
    nodeSnapshot: nodes[1],
    taskSnapshot: task,
    projectContext: project,
    profileSnapshot: profiles[0],
    startedAt: new Date().toISOString(),
    status: 'running',
    items: [
      {
        id: randomUUID(),
        type: 'command_execution',
        title: 'write welcome.ts',
        text: 'Working in task worktree',
        status: 'in_progress',
      },
    ],
    events: [{ type: 'turn.started', at: now, detail: '{}' }],
    tests: {
      command: 'npm test',
      status: 'not-run',
      output: '',
      truncated: false,
      exitCode: null,
    },
    worktree,
    dependencyResults: [],
  }
  if (input.mode === 'followup') assert.equal(threadId, previous.threadId)
  threadId ??= 'thread-ui-saved-conversation'
  run.threadId = threadId
  attempts.push(run)
  activeRun = {
    projectId: project.id,
    taskId: task.id,
    nodeId: run.nodeId,
    runId: run.id,
    status: run.status,
  }
  event.sender.send('constella:node:changed', {
    projectId: project.id,
    taskId: task.id,
  })
  if (input.message !== 'Wait until I stop you')
    setTimeout(() => {
      if (run.status !== 'running') return
      run.status = 'completed'
      run.finishedAt = new Date().toISOString()
      run.items.push({
        id: randomUUID(),
        type: 'agent_message',
        title: 'Codex',
        text:
          input.mode === 'followup'
            ? 'Revised the welcome copy in the same conversation.'
            : 'Created welcome.ts in the task worktree.',
      })
      run.tests = {
        command: 'npm test',
        status: 'passed',
        output: 'FIXTURE_TEST_PASS',
        truncated: false,
        exitCode: 0,
      }
      run.before = { head: 'baseline', commit: 'before' }
      run.changes = {
        before: run.before,
        after: { head: 'baseline', commit: 'after' },
        files: [
          {
            path: 'welcome.ts',
            status: input.mode === 'followup' ? 'modified' : 'added',
          },
        ],
        omittedFiles: 0,
      }
      activeRun = null
      event.sender.send('constella:node:changed', {
        projectId: project.id,
        taskId: task.id,
      })
    }, 160)
  return result({ runId: run.id })
})
ipcMain.handle('constella:node:stop', (event) => {
  const run = attempts.at(-1)
  run.status = 'cancelled'
  run.finishedAt = now
  activeRun = null
  event.sender.send('constella:node:changed', {
    projectId: project.id,
    taskId: task.id,
  })
  return result()
})
ipcMain.handle('constella:node:diff', (_event, input) => {
  assert(attempts.some((run) => run.id === input.runId))
  assert.equal(input.path, 'welcome.ts')
  return result({
    path: input.path,
    original: '',
    modified: 'export const welcome = "Hello, constellation!"\n',
    binary: false,
  })
})
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
}, process.env.CONSTELLA_GRAPH_SCREENSHOT ? 120000 : 30000)
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
        `Array.from((document.querySelector('dialog[open]') ?? document).querySelectorAll('button')).find(button => button.textContent.trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())}).click()`,
      )
    const select = (selector, value) =>
      run(
        `{ const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); }`,
      )
    const text = (selector, value) =>
      run(
        `{ const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); }`,
      )
    async function checkManagerChats(label, scope) {
      await click(label)
      await waitFor('document.querySelectorAll(".manager-turn").length === 1')
      await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, scope.taskId ? 'task-manager' : 'project-manager')
      const original = managerChat(scope)
      await click('New chat')
      await waitFor(
        'document.querySelectorAll(".manager-turn").length === 0 && document.querySelectorAll("#manager-conversation option").length === 2',
      )
      assert.notEqual(managerChat(scope).id, original.id)
      assert.equal(managerChat(scope).threadId, undefined)
      await select('#manager-conversation', original.id)
      await waitFor('document.querySelectorAll(".manager-turn").length === 1')
      assert.equal(managerChat(scope).id, original.id)
      assert.equal(
        await run('document.querySelector(".manager-user p").textContent'),
        original.turns[0].message,
      )
      await run(
        `document.querySelector('[aria-label="Close manager chat"]').click()`,
      )
      await waitFor('!document.querySelector(".manager-panel")')
    }
    await waitFor('document.querySelectorAll(".workflow-node").length === 4')
    await waitFor(
      'document.querySelector(".graph-validation strong").textContent === "Graph is valid"',
    )
    assert.equal(
      await run(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Check readiness").disabled',
      ),
      false,
    )
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await waitFor('!!document.querySelector("#graph-node-profile")')
    assert.equal(
      await run(
        'document.querySelector("#graph-node-profile").selectedOptions[0].textContent',
      ),
      'Default Codex',
    )
    await click('Conversation & runs')
    await waitFor(
      'document.querySelector(".node-workspace")?.open && Array.from(document.querySelectorAll(".node-workspace button")).some(button => button.textContent.trim() === "Run node" && !button.disabled)',
    )
    assert.equal(
      await run('!!document.querySelector(".node-run-blockers")'),
      false,
    )
    await run(
      'document.querySelector(".node-workspace > header button").click()',
    )
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
    await click('Conversation & runs')
    await waitFor(
      'document.querySelector(".node-run-blockers")?.textContent.includes("unsaved graph changes")',
    )
    assert.equal(
      await run(
        'document.querySelector(".node-run-blockers").textContent.includes("archived")',
      ),
      false,
    )
    assert(
      await run(
        'Array.from(document.querySelectorAll(".node-workspace button")).find(button => button.textContent.trim() === "Run node").disabled',
      ),
    )
    await click('Back to graph')
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
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'projects')
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
    const beforeDragSaves = saves
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
    const viewKey = `constella:graph-view:${project.id}:${task.id}`
    await waitFor(
      `!!JSON.parse(localStorage.getItem(${JSON.stringify(viewKey)}))?.positions[${JSON.stringify(nodes[1].id)}]`,
    )
    const viewAfterDrag = await run(
      `JSON.parse(localStorage.getItem(${JSON.stringify(viewKey)}))`,
    )
    assert.notDeepEqual(viewAfterDrag.positions[nodes[1].id], beforeDrag)
    assert.deepEqual(snapshot.document.nodes[1].position, beforeDrag)
    const beforeZoom = await run(
      'document.querySelector(".react-flow__viewport").style.transform',
    )
    await run('document.querySelector(".react-flow__controls-zoomin").click()')
    await waitFor(
      `document.querySelector('.react-flow__viewport').style.transform !== ${JSON.stringify(beforeZoom)}`,
    )
    await run('document.querySelector(".react-flow__controls-zoomout").click()')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(
      await run(
        'document.querySelector(".graph-heading p").textContent.includes("Unsaved")',
      ),
      false,
    )
    assert(
      await run(
        'Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="Save graph").disabled',
      ),
    )
    assert.equal(saves, beforeDragSaves)
    // View preferences survive route navigation without saving the graph.
    await run('document.querySelector(".graph-back").click()')
    await waitFor('!!document.querySelector(".project-board-page")')
    await checkManagerChats('Project manager', {
      projectId: project.id,
      taskId: null,
    })
    await click('Project settings')
    await waitFor('!!document.querySelector("#project-default-model")')
    assert.equal(
      await run(
        'document.querySelector(".settings-repository code").textContent',
      ),
      project.repoPath,
    )
    await select('#project-default-model', 'fixture-model')
    await select('#project-default-effort', 'high')
    await text('#ide-command', 'zed --new')
    await text('#parallel-agents', '3')
    await click('Save settings')
    await waitFor('!document.querySelector("dialog[open]")')
    assert.equal(project.defaultModel, 'fixture-model')
    assert.equal(project.defaultEffort, 'high')
    assert.equal(project.ideCommand, 'zed --new')
    assert.equal(project.maxParallelAgents, 3)
    await click('Project settings')
    await waitFor('!!document.querySelector("#project-default-model")')
    assert.equal(
      await run('document.querySelector("#project-default-model").value'),
      'fixture-model',
    )
    assert.equal(
      await run('document.querySelector("#project-default-effort").value'),
      'high',
    )
    await click('Cancel')
    await run(`location.hash = ${JSON.stringify(route)}`)
    await waitFor('document.querySelectorAll(".workflow-node").length === 4')
    await checkManagerChats('Task manager', {
      projectId: project.id,
      taskId: task.id,
    })
    assert.deepEqual(
      await run(
        `JSON.parse(localStorage.getItem(${JSON.stringify(viewKey)})).positions[${JSON.stringify(nodes[1].id)}]`,
      ),
      viewAfterDrag.positions[nodes[1].id],
    )
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await waitFor('!!document.querySelector("#graph-node-profile")')
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
    await click('Conversation & runs')
    await waitFor(
      'document.querySelector(".node-workspace")?.open && !!document.querySelector(".node-chat")',
    )
    await click('Run node')
    await waitFor(
      'document.querySelector(".node-chat")?.textContent.includes("Created welcome.ts")',
    )
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].status, 'completed')
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'conversation-result')
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'conversation-focus', { focus: '.node-composer textarea' })
    if (process.env.CONSTELLA_GRAPH_SCREENSHOT) {
      assert.equal(await run('getComputedStyle(document.querySelector(".node-composer")).outlineWidth'), '2px')
      assert.equal(await run('getComputedStyle(document.querySelector(".node-composer")).outlineStyle'), 'solid')
    }
    await click('Tests')
    await waitFor(
      'document.querySelector(".node-test-output")?.textContent.includes("FIXTURE_TEST_PASS")',
    )
    await click('Files & diffs')
    await waitFor(
      'document.querySelector(".node-file-list button")?.textContent.includes("welcome.ts")',
    )
    await run('document.querySelector(".node-file-list button").click()')
    await waitFor('!!document.querySelector(".monaco-diff-editor")')
    await waitFor(
      'document.querySelector(".monaco-diff-editor")?.textContent.includes("constellation!")',
    )
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'diff')
    await click('Conversation')
    await run(
      "{const el = document.querySelector('#node-followup');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Revise the welcome copy');el.dispatchEvent(new Event('input',{bubbles:true}));}",
    )
    await run('document.querySelector(".node-composer button").click()')
    await waitFor(
      'document.querySelectorAll(".node-turn").length === 2 && document.querySelector(".node-chat").textContent.includes("Revised the welcome copy")',
    )
    assert.equal(attempts[1].threadId, attempts[0].threadId)
    await run(
      "{const el = document.querySelector('#node-followup');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Wait until I stop you');el.dispatchEvent(new Event('input',{bubbles:true}));}",
    )
    await run('document.querySelector(".node-composer button").click()')
    await waitFor(
      'Array.from(document.querySelectorAll(".node-workspace button")).some(button => button.textContent.trim() === "Stop")',
    )
    await click('Stop')
    await waitFor(
      'document.querySelectorAll(".node-turn").length === 3 && document.querySelector(".node-workspace-bar strong").textContent === "Stopped"',
    )
    assert.equal(attempts[2].status, 'cancelled')
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'conversation')
    await waitFor(
      '!document.querySelector(".node-workspace > header button").disabled',
    )
    await run(
      'document.querySelector(".node-workspace > header button").click()',
    )
    await waitFor('!document.querySelector(".node-workspace")')
    await run('document.querySelector(".graph-back").click()')
    await waitFor('!!document.querySelector(".project-board-page")')
    await click('Project settings')
    await waitFor('!!document.querySelector("#project-name")')
    await click('Delete project')
    await waitFor(
      '!!document.querySelector("dialog[open]") && !Array.from(document.querySelectorAll("dialog[open] button")).find(button => button.textContent.trim() === "Delete project").disabled',
    )
    assert.equal(deletionRequests, 1)
    assert.equal(projectDeleted, false)
    confirmProjectDeletion = true
    await click('Delete project')
    await waitFor(
      '!!document.querySelector(".projects-page") && document.querySelectorAll(".project-card").length === 0',
    )
    assert.equal(deletionRequests, 2)
    assert.equal(projectDeleted, true)
    await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'projects-empty')
    if (process.env.CONSTELLA_GRAPH_SCREENSHOT) {
      await run("location.hash = '/playground'")
      await waitFor('!!document.querySelector(".lab-page .welcome")')
      await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'connectivity')
      await run("location.hash = '/integration'")
      await waitFor('!!document.querySelector(".notes-page")')
      await captureUi(window, process.env.CONSTELLA_GRAPH_SCREENSHOT, 'integration-notes')
    }
    assert.equal(
      await run('document.querySelectorAll(".sidebar-projects a").length'),
      0,
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
          projectDefaultsPersisted: true,
          projectDirectoryShown: true,
          newProjectManagerChat: true,
          newTaskManagerChat: true,
          savedManagerChats: true,
          projectDeletionCancelled: true,
          projectDeletedFromWorkspace: true,
          cycleRejected: true,
          reviewHumanOnly: true,
          nodeAndEdgeEditing: true,
          canvasChangesNeedNoSave: true,
          routeReopened: true,
          nodeConversation: true,
          sameThreadFollowup: true,
          stopNode: true,
          monacoDiff: true,
          testOutput: true,
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
