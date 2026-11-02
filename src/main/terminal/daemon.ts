import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import headless from '@xterm/headless'
import type { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { TerminalSession } from '../../shared/terminal'

interface Owned {
  record: TerminalSession
  process: pty.IPty
  screen: Terminal
  serialize: SerializeAddon
  chunks: { cursor: number; data: string }[]
  cursor: number
  deliveryBytes: number
  queuedBytes: number
  screenCursor: number
  queue: Promise<void>
  mcpToken: string
  mcp?: { url: string; token: string }
  directory: string
}

export async function startDaemon(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const key = randomBytes(32).toString('hex')
  const sessions = new Map<string, Owned>()
  let port = 0
  const save = (owned: Owned) =>
    writeFileSync(
      join(owned.directory, 'session.json'),
      JSON.stringify(owned.record),
      { mode: 0o600 },
    )
  const body = async (req: IncomingMessage) => {
    const parts: Buffer[] = []
    let size = 0
    for await (const part of req) {
      size += part.length
      if (size > 2_000_000) throw new Error('Terminal request is too large')
      parts.push(part)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(403).end()
        return
      }
      if (req.url?.startsWith('/mcp/')) {
        const session = sessions.get(req.url.slice(5))
        if (
          !session ||
          req.headers.authorization !== `Bearer ${session.mcpToken}`
        ) {
          res.writeHead(401).end()
          return
        }
        if (!session.mcp) {
          res
            .writeHead(503)
            .end('Open AgentConstella to reconnect project tools.')
          return
        }
        const target = new URL(session.mcp.url)
        const proxy = httpRequest(
          target,
          {
            method: req.method,
            headers: {
              ...req.headers,
              host: target.host,
              authorization: `Bearer ${session.mcp.token}`,
            },
          },
          (reply) => {
            res.writeHead(reply.statusCode ?? 502, reply.headers)
            reply.pipe(res)
          },
        )
        proxy.setTimeout(65_000, () =>
          proxy.destroy(new Error('Project tool timed out')),
        )
        proxy.on('error', () => {
          if (!res.headersSent) res.writeHead(503)
          res.end('Project tools disconnected. Reopen AgentConstella.')
        })
        req.pipe(proxy)
        return
      }
      if (
        req.url !== '/rpc' ||
        req.method !== 'POST' ||
        req.headers.authorization !== `Bearer ${key}`
      ) {
        res.writeHead(401).end()
        return
      }
      const input = await body(req)
      const reply = (value: unknown) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ value }))
      }
      if (input.op === 'list') {
        reply([...sessions.values()].map((s) => s.record))
        return
      }
      if (input.op === 'create') {
        if (sessions.has(input.id)) {
          reply(sessions.get(input.id)!.record)
          return
        }
        const sessionDir = join(directory, input.id)
        mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
        const env = {
          ...process.env,
          ...input.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as Record<string, string>
        delete env.ELECTRON_RUN_AS_NODE
        delete env.ELECTRON_NO_ASAR
        const child = pty.spawn(input.executable, input.args, {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: input.cwd,
          env,
        })
        const screen = new headless.Terminal({
          cols: 100,
          rows: 30,
          scrollback: 5000,
          allowProposedApi: true,
        })
        const serialize = new SerializeAddon()
        screen.loadAddon(serialize)
        const owned: Owned = {
          record: {
            id: input.id,
            provider: input.provider,
            role: input.role,
            title: input.title,
            cwd: input.cwd,
            state: 'running',
            generation: 1,
            completedGeneration: 0,
            summary: '',
            cols: 100,
            rows: 30,
            createdAt: new Date().toISOString(),
          },
          process: child,
          screen,
          serialize,
          chunks: [],
          cursor: 0,
          deliveryBytes: 0,
          queuedBytes: 0,
          screenCursor: 0,
          queue: Promise.resolve(),
          mcpToken: input.mcpToken,
          mcp: input.mcp,
          directory: sessionDir,
        }
        sessions.set(input.id, owned)
        writeFileSync(join(sessionDir, 'assignment.txt'), input.prompt, {
          mode: 0o600,
        })
        save(owned)
        child.onData((data) => {
          owned.cursor++
          owned.chunks.push({ cursor: owned.cursor, data })
          // Bound replay delivery and apply backpressure while parsing large output.
          owned.deliveryBytes += data.length
          while (
            owned.chunks.length > 1 &&
            (owned.chunks.length > 1000 || owned.deliveryBytes > 2_000_000)
          )
            owned.deliveryBytes -= owned.chunks.shift()!.data.length
          owned.queuedBytes += data.length
          if (owned.queuedBytes > 1_000_000) child.pause()
          const sequence = owned.cursor
          owned.queue = owned.queue.then(
            () =>
              new Promise<void>((resolve) =>
                screen.write(data, () => {
                  owned.screenCursor = sequence
                  owned.queuedBytes -= data.length
                  if (
                    owned.queuedBytes < 250_000 &&
                    owned.record.state !== 'exited'
                  )
                    child.resume()
                  resolve()
                }),
              ),
          )
          try {
            appendFileSync(join(sessionDir, 'terminal.ansi'), data, {
              mode: 0o600,
            })
          } catch {
            /* Live terminal remains usable if transcript storage fills. */
          }
        })
        child.onExit(({ exitCode }) => {
          owned.record.state = 'exited'
          owned.record.exitCode = exitCode
          save(owned)
        })
        reply(owned.record)
        return
      }
      const owned = sessions.get(input.sessionId)
      if (!owned)
        throw new Error(
          'Terminal session is no longer running. Start a new attempt; saved terminal history is retained in app data.',
        )
      const record = owned.record
      switch (input.op) {
        case 'read': {
          await owned.queue
          const cursor = owned.screenCursor
          const reset =
            !input.after ||
            input.after < (owned.chunks[0]?.cursor ?? cursor) - 1 ||
            input.after > cursor
          reply({
            session: record,
            cursor,
            reset,
            data: reset
              ? owned.serialize.serialize()
              : owned.chunks
                  .filter((c) => c.cursor > input.after && c.cursor <= cursor)
                  .map((c) => c.data)
                  .join(''),
          })
          break
        }
        case 'input':
          if (record.state !== 'running')
            throw new Error(
              'Continue this node or manager from its controls before editing a completed result.',
            )
          owned.process.write(input.data)
          reply(null)
          break
        case 'resize':
          owned.process.resize(input.cols, input.rows)
          owned.screen.resize(input.cols, input.rows)
          record.cols = input.cols
          record.rows = input.rows
          reply(null)
          break
        case 'finish':
          if (record.state !== 'running')
            throw new Error('This terminal has no active assignment.')
          record.summary =
            input.summary ||
            Array.from(
              { length: Math.min(80, owned.screen.buffer.active.length) },
              (_, index) =>
                owned.screen.buffer.active
                  .getLine(
                    Math.max(0, owned.screen.buffer.active.length - 80) + index,
                  )
                  ?.translateToString(true) ?? '',
            )
              .join('\n')
              .slice(-24000)
          record.completedGeneration = record.generation
          record.state = 'ready'
          save(owned)
          reply(null)
          break
        case 'continue':
          if (record.state !== 'ready')
            throw new Error(
              'This terminal is busy or has exited. Stop it or start a new conversation.',
            )
          owned.mcp = input.mcp
          record.state = 'running'
          record.generation++
          record.summary = ''
          save(owned)
          // Bracketed paste preserves multiline assignments without executing intermediate lines.
          owned.process.write(`\x1b[200~${input.prompt}\x1b[201~`)
          setTimeout(() => {
            if (record.state === 'running') owned.process.write('\r')
          }, 100)
          reply(record)
          break
        case 'mcp':
          owned.mcp = input.mcp
          reply(null)
          break
        case 'close':
          if (record.state !== 'exited')
            await new Promise<void>((resolve, reject) => {
              let force: ReturnType<typeof setTimeout>,
                deadline: ReturnType<typeof setTimeout>
              const exit = owned.process.onExit(() => {
                clearTimeout(force)
                clearTimeout(deadline)
                exit.dispose()
                resolve()
              })
              force = setTimeout(() => {
                try {
                  owned.process.kill('SIGKILL')
                } catch {
                  /* Exit callback handles an already stopped process. */
                }
              }, 1500)
              deadline = setTimeout(() => {
                exit.dispose()
                reject(
                  new Error(
                    'The terminal process did not stop. Inspect it before collecting code.',
                  ),
                )
              }, 3500)
              try {
                owned.process.kill()
              } catch (error) {
                clearTimeout(force)
                clearTimeout(deadline)
                exit.dispose()
                reject(error)
              }
            })
          reply(null)
          break
        default:
          throw new Error('Unknown terminal operation')
      }
    })().catch((error) => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: String(error instanceof Error ? error.message : error),
          }),
        )
      } else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Terminal service could not bind')
  port = address.port
  const descriptor = { port, key, pid: process.pid, version: 1 }
  const temp = join(directory, `daemon-${process.pid}.tmp`)
  writeFileSync(temp, JSON.stringify(descriptor), { mode: 0o600 })
  renameSync(temp, join(directory, 'daemon.json'))
  return { server, sessions }
}

if (process.argv[2] === '--terminal-daemon') {
  void startDaemon(process.argv[3]).catch((error) => {
    process.stderr.write(String(error))
    process.exit(1)
  })
}
