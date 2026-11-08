import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AgentOptions } from '../terminal/types'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ManagerScope } from '../../shared/manager'
import {
  ManagerTools,
  managerInstructions,
  managerToolSchemas,
  type ManagerToolName,
} from '../application/manager-tools'
import { applicationFailure } from '../application/errors'

type Grant = {
  scope: ManagerScope
  role: 'manager' | 'worker'
  onDone?: (summary: string) => Promise<void>
}
const readTools = new Set<ManagerToolName>([
  'workspace_get_context',
  'graph_get',
  'agent_profiles_list',
  'skills_list',
])
const descriptions: Record<ManagerToolName, string> = {
  workspace_get_context:
    'Read current project brief, repository guidance, board/tasks, graph revision, selected node, catalogs, models and recent execution summaries. Call before planning or editing.',
  project_update:
    'Save selected project settings: name, description (project brief), instructions, devCommand (development/run command), testCommand, defaultModel and defaultEffort. Board project manager only. Fetch workspace_get_context first and pass project.revision as expectedRevision. Omitted fields stay unchanged; empty strings clear text/commands and null clears defaults. Saving commands does not run them. Project directory cannot be changed. Changes support history and Undo.',
  todo_create:
    'Create a To Do task and its graph. Optionally supply a complete graph with UUID node/edge IDs. Atomic and idempotent by commandId.',
  todo_update:
    'Edit task title, description or acceptance criteria using its current expectedRevision. Omitted fields stay unchanged.',
  todo_archive:
    'Archive a task reversibly, stopping its active execution first, or restore it with archived=false. Requires current task revision.',
  graph_get:
    'Fetch the complete saved graph, live revision and validation issues before editing.',
  graph_apply_changes:
    'Atomically add, replace or remove nodes and edges. update_node supplies the entire node, including position, type and data. remove_node removes incident edges. Check current graph revision; use existing profile/skill/model IDs. A stale or invalid batch saves nothing.',
  agent_profiles_list:
    'List existing active global and project agent profiles available for assignment.',
  skills_list:
    'List existing active global and project skills available for assignment.',
  change_history:
    'Read the latest saved task and graph changes, including before/after values and Undo state.',
  change_undo:
    'Undo one saved metadata change if no newer edit conflicts with it. Code and execution are not rolled back or resumed.',
}

export class LocalMcpServer {
  private http?: Server
  private url?: string
  private grants = new Map<string, Grant>()
  private connections = new Set<McpServer>()
  constructor(private readonly tools: ManagerTools) {}
  async start() {
    this.http = createServer((request, response) => {
      void (async () => {
        const host = request.headers.host
        if (host !== new URL(this.url!).host || request.headers.origin) {
          response.writeHead(403).end('Local app clients only')
          return
        }
        if (request.url !== '/mcp') {
          response.writeHead(404).end()
          return
        }
        const token = request.headers.authorization?.replace(/^Bearer /, '')
        const grant = token ? this.grants.get(token) : undefined
        if (!grant) {
          response.writeHead(401).end('Invalid or expired app session')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        const server = new McpServer(
          { name: 'agent_constella', version: '0.1.0' },
          {
            instructions:
              grant.role === 'manager'
                ? managerInstructions
                : 'Read-only project context for this worker task. Do not execute or approve other nodes. Propose metadata changes for the human/manager. When the assignment is complete, call agent_report_done as your final tool with a useful summary, then stop editing.',
          },
        )
        this.connections.add(server)
        for (const name of Object.keys(
          managerToolSchemas,
        ) as ManagerToolName[]) {
          if (grant.role === 'worker' && !readTools.has(name)) continue
          if (grant.scope.taskId && name === 'project_update') continue
          server.registerTool(
            name,
            {
              description: descriptions[name],
              inputSchema: managerToolSchemas[name],
              annotations: {
                readOnlyHint: readTools.has(name) || name === 'change_history',
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
            async (input: unknown) => {
              try {
                const authorize = () => {
                  if (this.grants.get(token!) !== grant)
                    throw new Error(
                      'The app session has expired. No edit was applied.',
                    )
                }
                const value = await this.tools.call(
                  grant.scope,
                  name,
                  input,
                  authorize,
                )
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify(value) },
                  ],
                }
              } catch (error) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(applicationFailure(error)),
                    },
                  ],
                }
              }
            },
          )
        }
        if (grant.role === 'worker' && grant.onDone)
          server.registerTool(
            'agent_report_done',
            {
              description:
                'Hand this assignment back to AgentConstella for checks and acceptance. Call as your LAST tool only when all requested work is complete. Provide a useful summary for downstream agents. Do not edit files after handing work back. This does not approve human reviews or integrate code.',
              inputSchema: z
                .object({ summary: z.string().trim().min(1).max(32000) })
                .strict(),
            },
            async ({ summary }) => {
              if (this.grants.get(token!) !== grant)
                throw new Error('This assignment credential expired.')
              await grant.onDone!(summary)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Result handed back for checks and acceptance. Stop editing and wait for the next assignment.',
                  },
                ],
              }
            },
          )
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        response.on('close', () => {
          this.connections.delete(server)
          void server.close().catch(() => {})
        })
        await server.connect(transport)
        await transport.handleRequest(request, response)
      })().catch(() => {
        if (!response.headersSent)
          response.writeHead(500).end('MCP request failed')
        else response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.http.address()
    if (!address || typeof address === 'string')
      throw new Error('Local MCP listener did not bind')
    this.url = `http://127.0.0.1:${address.port}/mcp`
  }
  issue(
    raw: ManagerScope,
    role: Grant['role'] = 'manager',
    onDone?: Grant['onDone'],
  ) {
    if (!this.url) throw new Error('Local MCP server is not running')
    const scope = this.tools.scope(raw),
      token = randomBytes(32).toString('hex')
    this.grants.set(token, { scope, role, onDone })
    const options: AgentOptions = {
      mcp: { url: this.url, token },
    }
    return {
      options,
      release: () => {
        this.grants.delete(token)
      },
    }
  }
  async shutdown() {
    this.grants.clear()
    await Promise.allSettled(
      [...this.connections].map((server) => server.close()),
    )
    if (this.http) {
      this.http.closeAllConnections()
      await new Promise<void>((resolve) => this.http!.close(() => resolve()))
    }
  }
}
