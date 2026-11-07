const { app, BrowserWindow, ipcMain } = require('electron')
const { tsImport } = require('tsx/esm/api')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const captureUi = require('./ui-capture.cjs')
const root = resolve(__dirname, '..'),
  data = mkdtempSync(join(tmpdir(), 'constella-terminal-ui-'))
app.setPath('userData', join(data, 'electron'))
const load = (path) => tsImport(join(root, path), __filename)
let window,
  database,
  workflow,
  managers,
  mcp,
  terminalServer,
  owned,
  ending = false
const errors = []
const deadline = setTimeout(() => {
  console.error('Terminal UI timed out', errors)
  void finish(1)
}, 60000)
async function finish(code) {
  if (ending) return
  ending = true
  clearTimeout(deadline)
  await managers?.shutdown()
  await workflow?.shutdown()
  await mcp?.shutdown()
  for (const s of owned?.values() ?? [])
    if (s.record.state !== 'exited') s.process.kill()
  await new Promise((r) => setTimeout(r, 150))
  terminalServer?.closeAllConnections()
  terminalServer?.close()
  window?.destroy()
  database?.close()
  rmSync(data, { recursive: true, force: true })
  app.exit(code)
}
app
  .whenReady()
  .then(async () => {
    const bin = join(data, 'bin')
    mkdirSync(bin)
    for (const cli of ['codex', 'claude'])
      writeFileSync(
        join(bin, cli),
        `#!/bin/sh\nprintf '\\033[2J\\033[H${cli.toUpperCase()} — native terminal fixture\\n'\nprintf 'TTY: '; test -t 0 && printf 'connected\\n'\nprintf 'Ready for your instructions.\\n'\nwhile IFS= read -r line; do\nif [ "$line" = '__history_mouse__' ]; then\nprintf '\\033[?1003h\\033[?1006h'\ni=1; while [ "$i" -le 200 ]; do printf 'NODE_HISTORY_%s\\n' "$i"; i=$((i+1)); done\nelse printf 'You typed: %s\\n' "$line"; fi\ndone\n`,
        { mode: 0o755 },
      )
    process.env.PATH = `${bin}:${process.env.PATH}`
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
    const { ManagerTools } = await load('src/main/application/manager-tools.ts')
    const { ManagerService } = await load(
      'src/main/application/manager-service.ts',
    )
    const { LocalMcpServer } = await load('src/main/mcp/server.ts')
    const { startDaemon } = await load('src/main/terminal/daemon.ts')
    const { TerminalHost, configureTerminalHost } = await load(
      'src/main/terminal/host.ts',
    )
    const { NativeCliClient } = await load('src/main/terminal/client.ts')
    const { channels } = await load('src/shared/ipc.ts')
    const { applicationFailure } = await load('src/main/application/errors.ts')
    const dir = join(data, 'terminals'),
      daemon = await startDaemon(dir)
    terminalServer = daemon.server
    owned = daemon.sessions
    const host = new TerminalHost(dir, 'unused')
    configureTerminalHost(host)
    database = openWorkspaceDatabase(join(data, 'workspace.sqlite'))
    const workspace = new WorkspaceService(database),
      catalog = new CatalogService(database, data)
    await catalog.initialize()
    let project = await workspace.createProject({
      path: join(data, 'project'),
    })
    project = workspace.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name: 'Terminal studio',
      description: '',
      instructions: '',
      devCommand: '',
      defaultProvider: 'claude',
      ideCommand: 'code',
      testCommand: 'printf CHECKS_OK',
    })
    const task = workspace.createTask({
      projectId: project.id,
      title: 'Implement with native CLI',
      description: 'Use the terminal fixture.',
      acceptanceCriteria: 'Checks pass.',
    })
    const graphs = new GraphService(database, catalog)
    const identity = { projectId: project.id, taskId: task.id },
      graph = graphs.get(identity)
    const execution = new NodeExecutionService(database, graphs, catalog, data)
    await execution.initialize()
    workflow = new WorkflowService(
      database,
      graphs,
      catalog,
      execution,
      workspace,
    )
    await workflow.initialize()
    const tools = new ManagerTools(
      database,
      workspace,
      graphs,
      catalog,
      workflow,
    )
    mcp = new LocalMcpServer(tools)
    await mcp.start()
    managers = new ManagerService(
      database,
      tools,
      mcp,
      (options) => new NativeCliClient(options, host),
    )
    managers.initialize()
    execution.setMcpConnection((node) => {
      const connection = mcp.issue(
        { projectId: node.projectId, taskId: node.taskId },
        'worker',
        async (summary) => {
          const id = execution.get(node).threadId
          await host.finish({ sessionId: id.slice(9), summary })
        },
      )
      return {
        client: new NativeCliClient(connection.options, host),
        release: connection.release,
      }
    })
    const send = (channel, value) => {
      if (window && !window.isDestroyed())
        window.webContents.send(channel, value)
    }
    const handle = (channel, action) =>
      ipcMain.handle(channel, async (_event, input) => {
        try {
          return { ok: true, value: await action(input) }
        } catch (error) {
          return { ok: false, error: applicationFailure(error) }
        }
      })
    const now = new Date().toISOString()
    const state = {
      session: {
        id: require('node:crypto').randomUUID(),
        workspace: data,
        runs: [],
        createdAt: now,
      },
      diagnostics: {
        sdkVersion: 'Native CLI terminal',
        cliVersion: 'fixture',
        runtimePath: bin,
        auth: { status: 'unknown', detail: 'Native CLI authentication' },
        models: [],
        checkedAt: now,
      },
    }
    handle(channels.state, () => state)
    handle(channels.diagnostics, () => state.diagnostics)
    handle(channels.workspaceSnapshot, () => workspace.getSnapshot())
    handle(channels.updateProject, (input) => workspace.updateProject(input))
    handle(channels.catalogSnapshot, (input) => catalog.getSnapshot(input))
    handle(channels.graphGet, (input) => graphs.get(input))
    handle(channels.graphSave, (input) => graphs.save(input))
    handle(channels.graphPrepare, (input) => graphs.prepareStart(input))
    handle(channels.taskExecution, (input) => ({
      ...execution.getTask(input),
      workflow: workflow.get(input),
    }))
    handle(channels.nodeSessions, () => execution.listSessions())
    handle(channels.nodeGet, (input) => ({
      ...execution.get(input),
      workflow: workflow.get({
        projectId: input.projectId,
        taskId: input.taskId,
      }),
    }))
    let openedAgentWorkspace
    handle(channels.taskOpenIde, (input) =>
      execution.openInIde(input, async (_command, path) => {
        openedAgentWorkspace = path
      }),
    )
    handle(channels.nodeStart, (input) => workflow.startNode(input))
    handle(channels.nodeStop, (input) => execution.stop(input))
    handle(channels.nodeRun, (input) => execution.getRun(input))
    handle(channels.nodeDiff, (input) => execution.getDiff(input))
    handle(channels.workflowGet, (input) => workflow.get(input))
    handle(channels.workflowStart, (input) => workflow.start(input))
    handle(channels.workflowAccept, (input) =>
      workflow.accept(input, 'desktop-human'),
    )
    handle(channels.managerGet, (input) => managers.get(input))
    handle(channels.managerList, (input) => managers.list(input))
    handle(channels.managerNewChat, (input) => managers.newChat(input))
    handle(channels.managerSelectChat, (input) => managers.selectChat(input))
    handle(channels.managerSend, (input) => managers.send(input))
    handle(channels.managerStop, (input) => managers.stop(input))
    handle(channels.managerHistory, (input) => tools.history(input))
    handle(channels.terminalList, () => host.list())
    const legacyTerminals = new Set()
    handle(channels.terminalRead, async (input) => {
      const value = await host.read(input)
      if (legacyTerminals.has(input.sessionId))
        delete value.supportsReadOnlyWheel
      return value
    })
    const terminalInputs = []
    handle(channels.terminalInput, (input) => {
      terminalInputs.push(input)
      if (
        legacyTerminals.has(input.sessionId) &&
        owned.get(input.sessionId).record.state !== 'running'
      )
        throw new Error('Continue this node or manager from its controls before editing a completed result.')
      return host.input(input)
    })
    handle(channels.terminalResize, (input) => host.resize(input))
    handle(channels.terminalFinish, (input) =>
      host.finish({ summary: '', ...input }),
    )
    handle(channels.terminalClose, (input) => host.close(input.sessionId))
    workspace.subscribe((value) => send(channels.workspaceChanged, value))
    graphs.subscribe((value) => send(channels.graphChanged, value))
    execution.subscribe((value) => send(channels.nodeChanged, value))
    workflow.subscribe((value) => send(channels.workflowChanged, value))
    managers.subscribe((value) => send(channels.managerChanged, value))
    window = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        preload: join(root, 'out/preload/index.cjs'),
        // Keep GPU frames and wheel acknowledgements running in this hidden fixture.
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
    const run = (code) =>
      window.webContents.executeJavaScript(code).catch((error) => {
        console.error('Renderer check:', code, errors)
        throw error
      })
    const wheelAt = async (selector, waitForPaint = true) => {
      if (waitForPaint)
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const point = await run(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
        return { x: rect.left + 50, y: rect.top + 30 }
      })()`)
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...point, deltaY: -600, deltaX: 0,
      })
    }
    async function until(code) {
      for (let i = 0; i < 300; i++) {
        if (await run(code)) return
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error(
        `DOM timeout: ${code}\n${await run('document.body.innerText')}`,
      )
    }
    const click = (text) =>
      run(
        `{const button=Array.from((document.querySelector('dialog[open]')??document).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw new Error('Unavailable button: '+${JSON.stringify(text)});button.click()}`,
      )
    await window.loadFile(join(root, 'out/renderer/index.html'), {
      hash: `/projects/${project.id}`,
    })
    window.webContents.debugger.attach('1.3')
    // Native GPU wheel acknowledgements require a composited display surface
    // on macOS; profile a visible fixture without taking keyboard focus.
    if (process.env.CONSTELLA_TERMINAL_PROFILE) window.showInactive()
    await until('document.body.innerText.includes("Project settings")')
    await click('Project settings')
    await until('!!document.querySelector("#project-default-provider")')
    assert.equal(
      await run('document.querySelector("#project-default-provider").value'),
      'claude',
    )
    await captureUi(
      window,
      process.env.CONSTELLA_TERMINAL_SCREENSHOT,
      'provider-settings',
    )
    await run("document.querySelector('dialog[open] [aria-label]').click()")
    await run(
      `location.hash=${JSON.stringify(`/projects/${project.id}/tasks/${task.id}/graph`)}`,
    )
    await until('document.querySelectorAll(".workflow-node").length===4')
    await run(
      'document.querySelectorAll(".graph-structure > button")[1].click()',
    )
    await until(
      '!!document.querySelector(".graph-run-node") && !document.querySelector(".graph-run-node").disabled',
    )
    await run('document.querySelector(".graph-run-node").click()')
    await until(
      '!!document.querySelector(".node-workspace .terminal-screen .xterm")',
    )
    const nodeId = graph.document.nodes.find((n) => n.type === 'agent').id
    for (
      let i = 0;
      i < 100 && !execution.get({ ...identity, nodeId }).threadId;
      i++
    )
      await new Promise((r) => setTimeout(r, 30))
    const id = execution.get({ ...identity, nodeId }).threadId.slice(9)
    assert.equal(
      (await host.list()).find((s) => s.id === id).provider,
      'claude',
    )
    await host.input({ sessionId: id, data: 'hello from GUI test\r' })
    await host.input({ sessionId: id, data: '__history_mouse__\r' })
    const nodeSlider = 'parseFloat(document.querySelector(".node-workspace .scrollbar.vertical .slider")?.style.top ?? "0")'
    await until(`${nodeSlider}>0 && !!document.querySelector('.node-workspace .xterm.enable-mouse-events')`)
    await until(
      'document.querySelector(".terminal-toolbar").innerText.includes("Claude Code")',
    )
    await captureUi(
      window,
      process.env.CONSTELLA_TERMINAL_SCREENSHOT,
      'agent-terminal',
    )
    assert.equal(await run('!!document.querySelector(".node-tabs")'), false)
    assert.equal(
      await run('!!document.querySelector(".node-worktree-path")'),
      false,
    )
    await click('Open in IDE')
    for (let i = 0; i < 100 && !openedAgentWorkspace; i++)
      await new Promise((r) => setTimeout(r, 20))
    assert.equal(
      openedAgentWorkspace,
      execution.get({ ...identity, nodeId }).worktree.path,
    )
    await click('Finish step & run checks')
    for (let i = 0; i < 200 && execution.hasActiveRuns(); i++)
      await new Promise((r) => setTimeout(r, 30))
    const result = execution.get({ ...identity, nodeId }).runs.at(-1)
    assert.equal(result.status, 'completed')
    assert.equal(result.tests.status, 'passed')
    assert.equal(
      workflow.get(identity).nodes[nodeId].status,
      'awaiting-acceptance',
    )
    // A completed node can retain inline CLI mouse tracking. Its history must
    // scroll locally, without input requests or transient editing errors.
    await run(`(() => {
      window.__nodeScrollAlerts = []
      window.__nodeScrollObserver = new MutationObserver(() => {
        const error = document.querySelector('.node-workspace .terminal-error')
        if (error) window.__nodeScrollAlerts.push(error.textContent)
      })
      window.__nodeScrollObserver.observe(document.querySelector('.node-workspace'), { childList: true, subtree: true })
    })()`)
    const nodeInputCount = terminalInputs.filter(input => input.sessionId === id).length
    const nodeBottom = await run(nodeSlider)
    for (let i = 0; i < 3; i++)
      await wheelAt('.node-workspace .xterm-screen')
    await until(`${nodeSlider}<${nodeBottom}`)
    assert.equal(terminalInputs.filter(input => input.sessionId === id).length, nodeInputCount)
    assert.deepEqual(await run('window.__nodeScrollAlerts'), [])
    await run('window.__nodeScrollObserver.disconnect(); delete window.__nodeScrollObserver; delete window.__nodeScrollAlerts')
    await run("document.querySelector('dialog[open] [aria-label]').click()")
    await run(`location.hash=${JSON.stringify(`/projects/${project.id}`)}`)
    await until('document.body.innerText.includes("Project manager")')
    await click('Project manager')
    await until(
      '!!document.querySelector(".manager-panel .terminal-screen .xterm")',
    )
    assert.equal(
      managers.get({ projectId: project.id, taskId: null }).provider,
      'claude',
    )
    await captureUi(
      window,
      process.env.CONSTELLA_TERMINAL_SCREENSHOT,
      'manager-terminal',
    )
    await run(`location.hash='/terminals'`)
    await run(
      "document.querySelector('.manager-header-actions .icon-button')?.click()",
    )
    await until('document.querySelectorAll(".terminal-session").length===2')
    await run(
      'document.querySelectorAll(".terminal-session .icon-button")[1].click()',
    )
    await until(
      'document.querySelectorAll(".terminal-panes .xterm").length===2',
    )
    await captureUi(
      window,
      process.env.CONSTELLA_TERMINAL_SCREENSHOT,
      'multiplexer',
    )

    // Exercise real xterm wheel events through preload, IPC, and the PTY.
    const createScrollSession = async (title, command) => {
      const session = await host.rpc({
        op: 'create',
        id: require('node:crypto').randomUUID(),
        provider: 'codex',
        title,
        cwd: data,
        executable: '/bin/sh',
        args: ['-c', command],
        prompt: '',
      })
      await until(`Array.from(document.querySelectorAll('.terminal-session-select')).some(b => b.textContent.includes(${JSON.stringify(title)}))`)
      await run(`Array.from(document.querySelectorAll('.terminal-session-select')).find(b => b.textContent.includes(${JSON.stringify(title)})).click()`)
      await until('document.querySelectorAll(".terminal-panes .xterm").length===1')
      return session
    }
    const wheel = (waitForPaint = true) =>
      wheelAt('.terminal-panes .xterm-screen', waitForPaint)
    const sliderTop = 'parseFloat(document.querySelector(".terminal-panes .xterm .scrollbar.vertical .slider")?.style.top ?? "0")'
    const history = await createScrollSession(
      'Scrollback fixture',
      process.env.CONSTELLA_TERMINAL_PROFILE
        ? 'i=1; while [ "$i" -le 5000 ]; do printf "\\033[36mCHAT_%s\\033[0m \\033[32mfunction\\033[0m scrollHistory() { \\033[35mreturn\\033[0m \\033[33mreadPreviousMessages\\033[0m(session, history, viewport); }\\n" "$i"; i=$((i+1)); done; read line'
        : 'i=1; while [ "$i" -le 200 ]; do printf "CHAT_%s\\n" "$i"; i=$((i+1)); done; read line',
    )
    await until(`${sliderTop}>0`)
    let bottom = await run(sliderTop)
    await wheel()
    await until(`${sliderTop}<${bottom}`)
    if (process.env.CONSTELLA_TERMINAL_PROFILE) {
      console.log('Profiling 120 terminal wheel events')
      await window.webContents.debugger.sendCommand('Performance.enable')
      const metrics = async () => Object.fromEntries(
        (await window.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]),
      )
      await run(`(() => {
        const frames = [], sample = { mutations: 0, frames, last: performance.now() }
        sample.observer = new MutationObserver(records => { sample.mutations += records.length })
        sample.observer.observe(document.querySelector('.terminal-panes .xterm-screen'), { childList: true, subtree: true })
        const frame = now => { frames.push(now - sample.last); sample.last = now; sample.raf = requestAnimationFrame(frame) }
        sample.raf = requestAnimationFrame(frame)
        window.__terminalScrollProfile = sample
      })()`)
      const before = await metrics()
      for (let i = 0; i < 120; i++) {
        await wheel(false)
        await run('new Promise(resolve => requestAnimationFrame(resolve))')
      }
      const after = await metrics()
      const profile = await run(`(() => {
        const sample = window.__terminalScrollProfile
        sample.observer.disconnect(); cancelAnimationFrame(sample.raf)
        const frames = sample.frames.sort((a,b) => a-b)
        delete window.__terminalScrollProfile
        return {
          mutations: sample.mutations,
          frameP95Ms: frames[Math.floor(frames.length * .95)],
          frameMaxMs: frames.at(-1),
          framesOver25Ms: frames.filter(ms => ms > 25).length,
          domElements: document.querySelectorAll('.terminal-panes .xterm-screen *').length,
          canvas: !!document.querySelector('.terminal-panes .xterm-screen canvas'),
        }
      })()`)
      for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'])
        profile[key + 'Ms'] = (after[key] - before[key]) * 1000
      writeFileSync(process.env.CONSTELLA_TERMINAL_PROFILE, JSON.stringify(profile, null, 2))
      console.log('Terminal scroll profile:', JSON.stringify(profile))
    }
    await host.finish({ sessionId: history.id, summary: 'History remains readable' })
    // Remount the pane so this also tests the daemon's serialized history.
    await run('document.querySelector(".terminal-session-select").click()')
    await until('!document.querySelector(".terminal-session.selected").textContent.includes("Scrollback fixture")')
    await run('Array.from(document.querySelectorAll(".terminal-session-select")).find(b => b.textContent.includes("Scrollback fixture")).click()')
    await until('document.querySelector(".terminal-toolbar").textContent.includes("Result handed back")')
    await until(`${sliderTop}>0`)
    bottom = await run(sliderTop)
    await wheel()
    await until(`${sliderTop}<${bottom}`)
    await captureUi(
      window,
      process.env.CONSTELLA_TERMINAL_SCREENSHOT,
      'scrollback',
    )

    // Losing a GPU context must preserve history and wheel scrolling.
    const loseContext = `(() => {
      for (const canvas of document.querySelectorAll('.terminal-panes .xterm-screen canvas')) {
        const gl = canvas.getContext('webgl2')
        const extension = gl?.getExtension('WEBGL_lose_context')
        if (extension) { extension.loseContext(); return true }
      }
      return false
    })()`
    if (await run(loseContext)) {
      await until('!!document.querySelector(".terminal-panes .xterm-rows")')
      bottom = await run(sliderTop)
      await wheel()
      await until(`${sliderTop}<${bottom}`)
    }

    // Also cover hardware where WebGL is unavailable from the first mount.
    await run(`(() => {
      window.__originalCanvasContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        return type === 'webgl2' ? null : window.__originalCanvasContext.call(this, type, ...args)
      }
      document.querySelector('.terminal-session-select').click()
    })()`)
    await until('!document.querySelector(".terminal-session.selected").textContent.includes("Scrollback fixture")')
    await run('Array.from(document.querySelectorAll(".terminal-session-select")).find(b => b.textContent.includes("Scrollback fixture")).click()')
    await until('!!document.querySelector(".terminal-panes .xterm-rows")')
    await until(`${sliderTop}>0`)
    await run('HTMLCanvasElement.prototype.getContext = window.__originalCanvasContext; delete window.__originalCanvasContext')
    bottom = await run(sliderTop)
    await wheel()
    await until(`${sliderTop}<${bottom}`)

    for (const sgr of [true, false]) {
      const title = sgr ? 'SGR fullscreen fixture' : 'Binary fullscreen fixture'
      const session = await createScrollSession(
        title,
        `stty raw -echo; printf '\\033[?1049h\\033[?1003h${sgr ? '\\033[?1006h' : ''}FULLSCREEN_READY'; cat > /dev/null`,
      )
      await until('!!document.querySelector(".terminal-panes .xterm.enable-mouse-events")')
      const count = () => terminalInputs.filter(input => input.sessionId === session.id).length
      async function assertWheel() {
        const before = count()
        await wheel()
        for (let i = 0; i < 100 && count() === before; i++)
          await new Promise(resolve => setTimeout(resolve, 20))
        const input = terminalInputs.filter(input => input.sessionId === session.id).at(-1)
        assert.ok(count() > before, `${title}: wheel reaches the PTY`)
        assert.equal(input.encoding, sgr ? 'utf8' : 'binary')
        assert.ok(sgr ? /^\x1b\[<64;\d+;\d+M$/.test(input.data) : input.data.startsWith('\x1b[M`'))
      }
      await assertWheel()
      await host.finish({ sessionId: session.id, summary: 'Finished fullscreen fixture' })
      await until('document.querySelector(".terminal-toolbar").textContent.includes("Result handed back")')
      await assertWheel()
      const before = count()
      await run(`(() => {
        const input = document.querySelector('.terminal-panes .xterm-helper-textarea')
        input.value = 'must-not-submit'
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'must-not-submit' }))
      })()`)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(count(), before, 'Typing stays blocked after handoff')
    }
    const legacy = await createScrollSession(
      'Legacy fullscreen fixture',
      "stty raw -echo; printf '\\033[?1049h\\033[?1003h\\033[?1006hLEGACY_READY'; cat > /dev/null",
    )
    legacyTerminals.add(legacy.id)
    await host.finish({ sessionId: legacy.id, summary: 'Legacy handoff' })
    await until('document.querySelector(".terminal-toolbar").textContent.includes("Result handed back")')
    const legacyInputCount = terminalInputs.filter(input => input.sessionId === legacy.id).length
    for (let i = 0; i < 3; i++) await wheel()
    await until('document.querySelector(".native-terminal [role=status]")?.textContent.includes("older fullscreen session")')
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(terminalInputs.filter(input => input.sessionId === legacy.id).length, legacyInputCount)
    assert.equal(await run('!!document.querySelector(".terminal-error")'), false)
    assert.equal(await run('document.querySelectorAll(".native-terminal [role=status]").length'), 1)
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log(
      'Native terminal UI passed: provider settings, completed-node local scrolling without input/errors, checks/acceptance, manager CLI, scrollback after reconnect/handoff, GPU fallbacks, SGR/binary wheel input, legacy service compatibility, desktop/narrow captures.',
    )
    await finish(0)
  })
  .catch((error) => {
    console.error(error)
    void finish(1)
  })
