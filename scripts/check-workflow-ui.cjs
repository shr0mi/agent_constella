// Real SQLite/Git/scheduler/preload/renderer; only provider inference is injected.
const { app, BrowserWindow, ipcMain } = require('electron')
const { tsImport } = require('tsx/esm/api')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..'),
  data = mkdtempSync(join(tmpdir(), 'constella-workflow-ui-'))
app.setPath('userData', join(data, 'electron'))
const load = (path) => tsImport(join(root, path), __filename)
const errors = [],
  calls = []
let window,
  scheduler,
  database,
  ending = false
const deadline = setTimeout(() => {
  console.error('Workflow UI timed out', errors)
  void finish(1)
}, 45000)
async function finish(code) {
  if (ending) return
  ending = true
  clearTimeout(deadline)
  await scheduler?.shutdown()
  window?.destroy()
  database?.close()
  rmSync(data, { recursive: true, force: true })
  app.exit(code)
}
function git(path, ...args) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
app
  .whenReady()
  .then(async () => {
    const { openWorkspaceDatabase } = await load('src/main/db/database.ts')
    const { WorkspaceService } = await load(
      'src/main/application/workspace-service.ts',
    )
    const { CatalogService } = await load(
      'src/main/application/catalog-service.ts',
    )
    const { GraphService } = await load('src/main/application/graph-service.ts')
    const { NodeExecutionService } = await load(
      'src/main/application/node-execution-service.ts',
    )
    const { WorkflowService } = await load(
      'src/main/application/workflow-service.ts',
    )
    const { applicationFailure } = await load('src/main/application/errors.ts')
    const { makeWorkflowNode } = await load('src/shared/graph.ts')
    const { channels } = await load('src/shared/ipc.ts')

    const appData = join(data, 'metadata')
    database = openWorkspaceDatabase(join(appData, 'workspace.sqlite'))
    const workspace = new WorkspaceService(database)
    let project = await workspace.createProject({ path: join(data, 'project') })
    writeFileSync(join(project.repoPath, 'README.md'), 'Workflow fixture\n')
    git(project.repoPath, 'add', '.')
    git(
      project.repoPath,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Fixture baseline',
    )
    project = workspace.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name: 'Workflow studio',
      description: 'Exercise dependency acceptance and review.',
      instructions: '',
      devCommand: '',
      testCommand: 'node -e "console.log(\'WORKFLOW_CHECK_PASS\')"',
    })
    const task = workspace.createTask({
      projectId: project.id,
      title: 'Build a reviewed feature',
      description: 'A branching implementation and review.',
    })
    const identity = { projectId: project.id, taskId: task.id }
    const catalog = new CatalogService(database, appData),
      graphs = new GraphService(database, catalog)
    const initial = graphs.get(identity)
    const make = (type, title, x, y) => {
      const node = makeWorkflowNode(type, randomUUID(), { x, y })
      node.data.title = title
      if (type === 'agent') {
        node.data.prompt = `Complete ${title}`
        node.data.acceptance = title === 'Implement feature' ? 'manual' : 'auto'
      }
      return node
    }
    const start = make('start', 'Start', 20, 180),
      a = make('agent', 'Implement feature', 300, 50),
      b = make('agent', 'Verify branch', 300, 300),
      j = make('agent', 'Join results', 580, 180),
      review = make('review', 'Human review', 860, 180),
      end = make('end', 'End', 1140, 180)
    const nodes = [start, a, b, j, review, end],
      pairs = [
        [start, a],
        [start, b],
        [a, j],
        [b, j],
        [j, review],
        [review, end],
      ]
    graphs.save({
      ...identity,
      expectedRevision: initial.revision,
      commandId: randomUUID(),
      document: {
        nodes,
        edges: pairs.map(([source, target]) => ({
          id: randomUUID(),
          source: source.id,
          target: target.id,
        })),
        viewport: { x: 20, y: 30, zoom: 0.64 },
      },
    })
    let failed = false
    const thread = (options, resumed) => ({
      async runStreamed(prompt) {
        const name = prompt.match(/\nNode: (.+)\n/)[1]
        return {
          events: (async function* () {
            calls.push({ name, resumed, prompt })
            yield {
              type: 'thread.started',
              thread_id: resumed ?? `ui-thread-${name}`,
            }
            writeFileSync(
              join(
                options.workingDirectory,
                `${name.replaceAll(' ', '-')}.txt`,
              ),
              `Completed ${name}\n${calls.length}`,
            )
            if (name === a.data.title && !failed) {
              failed = true
              yield {
                type: 'turn.failed',
                error: { message: 'Deliberate UI fixture failure' },
              }
              return
            }
            yield {
              type: 'item.completed',
              item: {
                id: 'message',
                type: 'agent_message',
                text: `Finished ${name}. Checks and code are ready for inspection.`,
              },
            }
            yield {
              type: 'turn.completed',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            }
          })(),
        }
      },
    })
    const execution = new NodeExecutionService(
      database,
      graphs,
      catalog,
      appData,
      {
        startThread: (options) => thread(options),
        resumeThread: (id, options) => thread(options, id),
      },
    )
    await execution.initialize()
    scheduler = new WorkflowService(
      database,
      graphs,
      catalog,
      execution,
      workspace,
    )
    await scheduler.initialize()
    const diagnostics = {
      sdkVersion: '0.164.0',
      cliVersion: 'fixture',
      runtimePath: 'fixture',
      auth: { status: 'signed-in', detail: 'fixture' },
      models: [],
      checkedAt: new Date().toISOString(),
    }
    const state = {
      session: {
        id: randomUUID(),
        workspace: data,
        createdAt: new Date().toISOString(),
        runs: [],
      },
      diagnostics,
    }
    const handle = (channel, action) =>
      ipcMain.handle(channel, async (_event, input) => {
        try {
          return { ok: true, value: await action(input) }
        } catch (error) {
          return { ok: false, error: applicationFailure(error) }
        }
      })
    const send = (channel, value) => {
      if (window && !window.isDestroyed())
        window.webContents.send(channel, value)
    }
    handle(channels.state, () => state)
    handle(channels.diagnostics, () => diagnostics)
    handle(channels.workspaceSnapshot, () => workspace.getSnapshot())
    handle(channels.catalogSnapshot, (input) => catalog.getSnapshot(input))
    handle(channels.graphGet, (input) => graphs.get(input))
    handle(channels.graphSave, (input) => graphs.save(input))
    handle(channels.graphPrepare, (input) => graphs.prepareStart(input))
    handle(channels.taskExecution, (input) => ({
      ...execution.getTask(input),
      workflow: scheduler.get(input),
    }))
    handle(channels.nodeGet, (input) => ({
      ...execution.get(input),
      workflow: scheduler.get({
        projectId: input.projectId,
        taskId: input.taskId,
      }),
    }))
    handle(channels.nodeStart, (input) => scheduler.startNode(input))
    handle(channels.nodeStop, (input) => execution.stop(input))
    handle(channels.nodeRun, (input) => execution.getRun(input))
    handle(channels.nodeDiff, (input) => execution.getDiff(input))
    handle(channels.workflowGet, (input) => scheduler.get(input))
    handle(channels.workflowStart, (input) => scheduler.start(input))
    handle(channels.workflowPause, (input) => scheduler.pause(input))
    handle(channels.workflowAccept, (input) =>
      scheduler.accept(input, 'desktop-human'),
    )
    handle(channels.workflowReview, (input) =>
      scheduler.review(input, 'desktop-human'),
    )
    handle(channels.workflowPreview, (input) =>
      scheduler.previewIntegration(input),
    )
    handle(channels.workflowIntegrate, (input) =>
      scheduler.integrate(input, 'desktop-human'),
    )
    workspace.subscribe((value) => send(channels.workspaceChanged, value))
    graphs.subscribe((value) => send(channels.graphChanged, value))
    execution.subscribe((value) => send(channels.nodeChanged, value))
    scheduler.subscribe((value) => send(channels.workflowChanged, value))
    window = new BrowserWindow({
      show: false,
      width: 1580,
      height: 1100,
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
    async function until(code) {
      for (let n = 0; n < 400; n++) {
        if (await run(code)) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(
        `DOM check failed: ${code}\n${JSON.stringify(await run('({review:document.querySelector(".workflow-review")?.outerHTML,controls:document.querySelector(".workflow-controls")?.textContent,selection:document.querySelector(".graph-details h2")?.textContent})'))}`,
      )
    }
    const click = (text) =>
      run(
        `{const button=Array.from((document.querySelector('dialog[open]') ?? document).querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error(${JSON.stringify('Missing button: ' + text)});if(button.disabled)throw new Error(${JSON.stringify('Disabled button: ' + text)});button.click()}`,
      )
    const set = (selector, value, kind = 'textarea') =>
      run(
        `{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${kind === 'select' ? 'HTMLSelectElement' : 'HTMLTextAreaElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('${kind === 'select' ? 'change' : 'input'}',{bubbles:true}));}`,
      )
    await until(
      'document.querySelectorAll(".workflow-node").length===6 && !!document.querySelector(".workflow-controls .workflow-progress")',
    )
    assert.equal(
      await run(
        'document.querySelectorAll(".workflow-node.state-pending").length',
      ),
      6,
    )
    const revisionBeforeView = graphs.get(identity).revision
    await run('document.querySelector(".react-flow__controls-zoomin").click()')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await run('document.querySelector(".react-flow__controls-zoomout").click()')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(
      await run(
        'document.querySelector(".graph-heading p").textContent.includes("Unsaved")',
      ),
      false,
    )
    assert.equal(graphs.get(identity).revision, revisionBeforeView)
    await run(
      'document.querySelectorAll(".graph-structure > button")[3].click()',
    )
    await until('!!document.querySelector(".graph-run-node")')
    assert(await run('document.querySelector(".graph-run-node").disabled'))
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await until(
      '!!document.querySelector(".graph-run-node") && !document.querySelector(".graph-run-node").disabled',
    )
    await run('document.querySelector(".graph-run-node").click()')
    await until('!!document.querySelector(".workflow-node.state-failed")')
    const colors = await run(
      '({failed:getComputedStyle(document.querySelector(".workflow-node.state-failed")).backgroundColor,pending:getComputedStyle(document.querySelector(".workflow-node.state-pending")).backgroundColor})',
    )
    assert.notEqual(colors.failed, colors.pending)
    if (process.env.CONSTELLA_WORKFLOW_SCREENSHOT)
      writeFileSync(
        `${process.env.CONSTELLA_WORKFLOW_SCREENSHOT}.failed.png`,
        (await window.webContents.capturePage()).toPNG(),
      )
    assert.equal(
      workspace.getBoard({ projectId: project.id }).tasks[0].status,
      'doing',
    )
    assert.equal(scheduler.get(identity).scheduling, 'manual')
    assert.equal(calls.length, 1)
    await until('document.querySelector(".node-workspace")?.open')
    await run(
      'document.querySelector(".node-workspace > header button").click()',
    )
    await click('Inspect Implement feature')
    await until(
      'document.querySelector(".node-workspace")?.open && document.querySelector(".node-workspace-bar").textContent.includes("Failed")',
    )
    await click('Retry last attempt')
    await until(
      'document.querySelector(".node-workspace-bar strong")?.textContent==="Awaiting acceptance"',
    )
    await until(
      'Array.from(document.querySelectorAll(".node-workspace button")).some(button=>button.textContent.trim()==="Accept latest result"&&!button.disabled)',
    )
    await click('Accept latest result')
    await until(
      'document.querySelector(".node-workspace-bar strong")?.textContent==="Completed"',
    )
    await run(
      'document.querySelector(".node-workspace > header button").click()',
    )
    assert.equal(calls.filter((call) => call.name === j.data.title).length, 0)
    assert.equal(calls.filter((call) => call.name === b.data.title).length, 0)
    await until(
      'Array.from(document.querySelectorAll(".workflow-controls button")).some(button => button.textContent.trim() === "Run workflow" && !button.disabled)',
    )
    await click('Run workflow')
    await until(
      '!!document.querySelector(".workflow-node.review.state-waiting-review")',
    )
    assert.equal(scheduler.get(identity).nodes[end.id].status, 'pending')
    const completeColor = await run(
      'getComputedStyle(document.querySelector(".workflow-node.state-completed")).backgroundColor',
    )
    assert.notEqual(completeColor, colors.pending)
    assert.notEqual(completeColor, colors.failed)
    await click('Open review')
    await until(
      '!!document.querySelector(".workflow-review") && document.querySelectorAll(".workflow-review details").length===3',
    )
    await set('#review-note', 'Refine the implementation before approval.')
    await set('#review-target', a.id, 'select')
    await click('Request changes & revise')
    for (let n = 0; n < 400; n++) {
      if (
        calls.filter((call) => call.name === a.data.title).length >= 3 &&
        scheduler.get(identity).phase === 'waiting'
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await until(
      '!!document.querySelector(".workflow-node.agent.state-awaiting-acceptance") && !!document.querySelector(".workflow-controls.phase-waiting")',
    )
    assert.equal(calls.filter((call) => call.name === j.data.title).length, 1)
    await click('Inspect result')
    await until(
      'document.querySelector(".node-workspace")?.open && Array.from(document.querySelectorAll(".node-workspace button")).some(button=>button.textContent.trim()==="Accept latest result"&&!button.disabled)',
    )
    await click('Accept latest result')
    await until(
      'document.querySelector(".node-workspace-bar strong")?.textContent==="Completed"',
    )
    await run(
      'document.querySelector(".node-workspace > header button").click()',
    )
    await until(
      '!!document.querySelector(".workflow-node.review.state-waiting-review") && !!document.querySelector(".workflow-controls.phase-waiting")',
    )
    await click('Open review')
    await until(
      'document.querySelector(".workflow-review > header strong")?.textContent==="Waiting for human"',
    )
    assert.equal(
      await run('document.querySelectorAll(".workflow-review").length'),
      1,
    )
    assert.equal(calls.filter((call) => call.name === a.data.title).length, 3)
    assert.equal(calls.filter((call) => call.name === j.data.title).length, 2)
    assert.equal(
      calls.filter((call) => call.name === a.data.title).at(-1).resumed,
      `ui-thread-${a.data.title}`,
    )
    assert.notEqual(scheduler.get(identity).nodes[end.id].status, 'completed')
    await click('Approve review')
    await until(
      'document.querySelectorAll(".workflow-node.state-completed").length===6',
    )
    if (process.env.CONSTELLA_WORKFLOW_SCREENSHOT)
      writeFileSync(
        `${process.env.CONSTELLA_WORKFLOW_SCREENSHOT}.graph.png`,
        (await window.webContents.capturePage()).toPNG(),
      )
    assert.equal(
      workspace.getBoard({ projectId: project.id }).tasks[0].status,
      'done',
    )
    await run(`location.hash=${JSON.stringify(`/projects/${project.id}`)}`)
    await until('!!document.querySelector(".task-workflow-badge.completed")')
    assert(await run('document.querySelector(".task-card select").disabled'))
    await run(`location.hash=${JSON.stringify(route)}`)
    await until(
      '!!document.querySelector(".workflow-controls.phase-completed")',
    )
    await click('Integrate branch')
    await until('document.querySelector(".integration-dialog")?.open')
    await click('Preview integration')
    await until('!!document.querySelector(".integration-plan.ready")')
    assert.equal(
      existsSync(join(project.repoPath, 'Implement-feature.txt')),
      false,
    )
    await click('Integrate into main')
    await until('!!document.querySelector(".integration-plan.integrated")')
    assert.equal(
      existsSync(join(project.repoPath, 'Implement-feature.txt')),
      true,
    )
    assert.equal(git(project.repoPath, 'status', '--porcelain'), '')
    if (process.env.CONSTELLA_WORKFLOW_SCREENSHOT)
      writeFileSync(
        process.env.CONSTELLA_WORKFLOW_SCREENSHOT,
        (await window.webContents.capturePage()).toPNG(),
      )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify(
        {
          result: 'PASS',
          realServices: true,
          canvasChangesNeedNoSave: true,
          individualNodeRun: true,
          branchJoin: true,
          failedAndCompletedVisuals: true,
          manualAcceptance: true,
          humanRevision: true,
          humanReview: true,
          boardDoingToDone: true,
          explicitIntegration: true,
          providerCalls: 0,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    )
    await finish(0)
  })
  .catch((error) => {
    console.error(error, errors)
    void finish(1)
  })
