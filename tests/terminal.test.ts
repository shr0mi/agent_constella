import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { TerminalHost, configureTerminalHost } from '../src/main/terminal/host'
import { NativeCliClient } from '../src/main/terminal/client'
import { cliArguments } from '../src/main/terminal/launch'
import { startDaemon } from '../src/main/terminal/daemon'
import {
  terminalInputSchema,
  terminalResizeSchema,
} from '../src/shared/terminal'
import { openWorkspaceDatabase } from '../src/main/db/database'
import { WorkspaceService } from '../src/main/application/workspace-service'
import { CatalogService } from '../src/main/application/catalog-service'
import { GraphService } from '../src/main/application/graph-service'
import { NodeExecutionService } from '../src/main/application/node-execution-service'
import { WorkflowService } from '../src/main/application/workflow-service'
import type { ThreadEvent } from '../src/main/terminal/types'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const action of cleanup.splice(0).reverse()) await action()
})
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
) {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('Terminal condition timed out')
}
async function fixture(detached = false) {
  const root = await mkdtemp(join(tmpdir(), 'constella-terminal-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  await mkdir(bin)
  // A real interactive process in a real PTY; no inference or provider credentials.
  for (const name of ['codex', 'claude'])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf 'NATIVE_${name} '; test -t 0 && printf 'TTY_OK\\n'\nprintf 'ASSIGNMENT:%s\\n' "$*"\nwhile IFS= read -r line; do printf 'RECEIVED:%s\\n' "$line"; done\n`,
      { mode: 0o755 },
    )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const directory = join(root, 'terminals')
  const host = new TerminalHost(
    directory,
    resolve('out/main/terminal-daemon.js'),
  )
  if (detached) {
    await host.initialize()
    const { pid } = JSON.parse(
      await readFile(join(directory, 'daemon.json'), 'utf8'),
    )
    cleanup.push(async () => {
      for (const session of await host.list())
        if (session.state !== 'exited') await host.close(session.id)
      await new Promise((r) => setTimeout(r, 150))
      process.kill(pid)
    })
  } else {
    const { server, sessions } = await startDaemon(directory)
    cleanup.push(async () => {
      for (const owned of sessions.values())
        if (owned.record.state !== 'exited') owned.process.kill()
      await new Promise((r) => setTimeout(r, 150))
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    })
  }
  return { root, host, directory }
}

describe('native CLI terminal multiplexer', () => {
  it('launches native providers with literal arguments and their own permission configuration', () => {
    const prompt = 'Fix $(do-not-execute) `literal`\nsecond line'
    const args = cliArguments(
      'codex',
      prompt,
      { model: 'custom', modelReasoningEffort: 'high' },
      { url: 'http://127.0.0.1:123/mcp/x' },
    )
    expect(args.at(-1)).toBe(prompt)
    expect(args).toContain(
      'mcp_servers.agent_constella.bearer_token_env_var="CONSTELLA_MCP_TOKEN"',
    )
    expect(args.join(' ')).not.toMatch(
      /approval_policy|dangerously|sandbox_mode|exec /,
    )
    const claude = cliArguments(
      'claude',
      prompt,
      {},
      { url: 'http://127.0.0.1:123/mcp/x' },
    )
    expect(claude).toContain('--mcp-config')
    expect(claude.at(-1)).toBe(prompt)
    expect(claude).not.toContain('--print')
  })
  it('isolates simultaneous PTYs, forwards input, resizes, and retains output on reconnect', async () => {
    const { host, root } = await fixture()
    const a = await host.launch(
      'first task',
      { workingDirectory: root, provider: 'codex' },
      {},
    )
    const b = await host.launch(
      'second task',
      { workingDirectory: root, provider: 'claude' },
      {},
    )
    const initial = await eventually(
      () => host.read({ sessionId: a.id }),
      (r) => r.data.includes('TTY_OK'),
    )
    expect(initial.data).toContain('first task')
    await host.input({ sessionId: a.id, data: 'only-first\r' })
    await eventually(
      () => host.read({ sessionId: a.id }),
      (r) => r.data.includes('RECEIVED:only-first'),
    )
    expect((await host.read({ sessionId: b.id })).data).not.toContain(
      'only-first',
    )
    await Promise.all(
      ['a', 'b', 'c', '\r'].map((data) =>
        host.input({ sessionId: a.id, data }),
      ),
    )
    await eventually(
      () => host.read({ sessionId: a.id }),
      (value) => value.data.includes('RECEIVED:abc'),
    )
    await host.resize({ sessionId: a.id, cols: 83, rows: 24 })
    const value = await host.read({ sessionId: a.id })
    expect(value.session.cols).toBe(83)
    expect(value.session.rows).toBe(24)
    expect((await host.list()).length).toBe(2)
    expect(JSON.stringify(value)).not.toContain('mcpToken')
    await expect(
      host.rpc({ op: 'input', sessionId: randomUUID(), data: 'x' }),
    ).rejects.toThrow('no longer running')
  })
  it('does not complete from silence, hands back a result explicitly, and continues the same terminal', async () => {
    const { host, root } = await fixture()
    const client = new NativeCliClient({}, host)
    const controller = new AbortController()
    const { events } = await client
      .startThread({ workingDirectory: root, provider: 'codex' })
      .runStreamed('initial exactly once', { signal: controller.signal })
    const seen: ThreadEvent[] = []
    const done = (async () => {
      for await (const event of events) seen.push(event)
    })()
    const session = (await host.list())[0]
    await eventually(
      () => host.read({ sessionId: session.id }),
      (r) => r.data.includes('ASSIGNMENT:'),
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(seen.some((e) => e.type === 'turn.completed')).toBe(false)
    await host.finish({
      sessionId: session.id,
      summary: 'Implemented and checked the assigned change.',
    })
    await done
    expect(seen.at(-1)?.type).toBe('turn.completed')
    await expect(
      host.input({ sessionId: session.id, data: 'change accepted code' }),
    ).rejects.toThrow('Continue')
    const next = await client
      .resumeThread(`terminal:${session.id}`, {
        workingDirectory: root,
        provider: 'codex',
      })
      .runStreamed('revision', {})
    const pending = (async () => {
      for await (const _ of next.events) {
        /* observe completion */
      }
    })()
    await host.finish({ sessionId: session.id, summary: 'Revision complete.' })
    await pending
    expect((await host.list()).length).toBe(1)
  })
  it('rejects unauthenticated local RPC and proxies only the session-scoped MCP credential', async () => {
    const { host, directory, root } = await fixture()
    const descriptor = JSON.parse(
      await readFile(join(directory, 'daemon.json'), 'utf8'),
    )
    const denied = await fetch(`http://127.0.0.1:${descriptor.port}/rpc`, {
      method: 'POST',
      body: '{}',
    })
    expect(denied.status).toBe(401)
    let authorization: string | undefined
    const mcp: Server = createServer((req, res) => {
      authorization = req.headers.authorization
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r))
    cleanup.push(() => new Promise<void>((r) => mcp.close(() => r())))
    const address = mcp.address() as { port: number }
    const sessionId = randomUUID(),
      token = 'proxy-token-for-test'
    await host.rpc({
      op: 'create',
      id: sessionId,
      provider: 'codex',
      title: 'scoped',
      cwd: root,
      executable: '/bin/sh',
      args: ['-c', 'read x'],
      prompt: '',
      mcpToken: token,
      mcp: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        token: 'app-scoped-token',
      },
    })
    const proxy = `http://127.0.0.1:${descriptor.port}/mcp/${sessionId}`
    expect((await fetch(proxy, { method: 'POST' })).status).toBe(401)
    expect(
      (
        await fetch(proxy, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)
    expect(authorization).toBe('Bearer app-scoped-token')
    await host.setMcp(sessionId, undefined)
    expect(
      (
        await fetch(proxy, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(503)
  })
  it('keeps a detached terminal service alive across application-client replacement without resending work', async () => {
    const { host, root, directory } = await fixture(true)
    const session = await host.launch(
      'one initial assignment',
      { provider: 'codex', workingDirectory: root },
      {},
    )
    await eventually(
      () => host.read({ sessionId: session.id }),
      (r) => r.data.includes('ASSIGNMENT:'),
    )
    const replacement = new TerminalHost(
      directory,
      'unused-while-daemon-is-live',
    )
    expect((await replacement.list())[0].id).toBe(session.id)
    await replacement.input({ sessionId: session.id, data: 'still-alive\r' })
    const screen = await eventually(
      () => replacement.read({ sessionId: session.id }),
      (r) => r.data.includes('RECEIVED:still-alive'),
    )
    expect(screen.data.match(/ASSIGNMENT:/g)?.length).toBe(1)
    const client = new NativeCliClient({}, replacement),
      controller = new AbortController()
    const { events } = await client
      .resumeThread(`terminal:${session.id}`, {
        provider: 'codex',
        workingDirectory: root,
        attachOnly: true,
      })
      .runStreamed('must not send this', { signal: controller.signal })
    const monitoring = (async () => {
      for await (const _ of events) {
      }
    })()
    controller.abort('detach')
    await monitoring
    expect((await replacement.list())[0].state).toBe('running')
  })
  it('reattaches an unfinished workflow assignment without cancellation or duplicate prompts, then preserves checks and review gates', async () => {
    const { host, root } = await fixture()
    configureTerminalHost(host)
    const database = openWorkspaceDatabase(join(root, 'workspace.sqlite'))
    cleanup.push(async () => database.close())
    const workspace = new WorkspaceService(database),
      catalog = new CatalogService(database, root)
    await catalog.initialize()
    const project = await workspace.createProject({
      path: join(root, 'project'),
    })
    workspace.updateProject({
      projectId: project.id,
      expectedRevision: project.revision,
      name: 'Native workflow',
      description: '',
      instructions: '',
      devCommand: '',
      testCommand: 'printf CHECKS_OK',
      defaultProvider: 'claude',
    })
    const task = workspace.createTask({
      projectId: project.id,
      title: 'Native implementation',
      description: 'Implement the requested change.',
    })
    const graphs = new GraphService(database, catalog),
      identity = { projectId: project.id, taskId: task.id }
    const graph = graphs.get(identity),
      nodeId = graph.document.nodes.find((node) => node.type === 'agent')!.id
    const node = { ...identity, nodeId }
    const first = new NodeExecutionService(database, graphs, catalog, root)
    await first.initialize()
    const workflow = new WorkflowService(
      database,
      graphs,
      catalog,
      first,
      workspace,
    )
    await workflow.initialize()
    workflow.startNode({
      ...node,
      expectedGraphRevision: graph.revision,
      mode: 'run',
    })
    await eventually(
      async () => first.get(node),
      (value) => !!value.threadId,
    )
    const sessionId = first.get(node).threadId!.slice(9)
    expect((await host.list())[0].provider).toBe('claude')
    await workflow.shutdown(true)
    expect((await host.list())[0].state).toBe('running')
    expect(first.get(node).runs.at(-1)!.status).toBe('running')
    expect(workflow.get(identity).nodes[nodeId].status).toBe('running')
    const second = new NodeExecutionService(database, graphs, catalog, root)
    await second.initialize()
    const recovered = new WorkflowService(
      database,
      graphs,
      catalog,
      second,
      workspace,
    )
    await recovered.initialize()
    cleanup.push(async () => recovered.shutdown())
    second.reconnect()
    expect(second.get(node).active).not.toBeNull()
    expect(recovered.get(identity).phase).toBe('paused')
    await host.finish({
      sessionId,
      summary: 'Native implementation handed back.',
    })
    await second.waitForIdle()
    const result = second.get(node).runs.at(-1)!
    expect(result.status).toBe('completed')
    expect(result.tests.status).toBe('passed')
    expect(result.tests.output).toContain('CHECKS_OK')
    expect(recovered.get(identity).nodes[nodeId].status).toBe(
      'awaiting-acceptance',
    )
    expect(workspace.getBoard({ projectId: project.id }).tasks[0].status).toBe(
      'doing',
    )
    expect(
      (await host.read({ sessionId })).data.match(/ASSIGNMENT:/g)?.length,
    ).toBe(1)
  })
  it('never launches replacement work when a recovery session is missing', async () => {
    const { host, root } = await fixture()
    const client = new NativeCliClient({}, host)
    await expect(
      client
        .resumeThread(`terminal:${randomUUID()}`, {
          attachOnly: true,
          workingDirectory: root,
        })
        .runStreamed('do not replay', {}),
    ).rejects.toThrow('ended while')
    expect(await host.list()).toHaveLength(0)
  })
  it('bounds renderer input and geometry at the IPC boundary', () => {
    expect(
      terminalInputSchema.safeParse({
        sessionId: randomUUID(),
        data: 'x',
        executable: 'sh',
      }).success,
    ).toBe(false)
    expect(
      terminalResizeSchema.safeParse({
        sessionId: randomUUID(),
        cols: -1,
        rows: 30,
      }).success,
    ).toBe(false)
  })
})
