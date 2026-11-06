import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentProvider } from '../../shared/terminal'
import type { ThreadOptions } from './types'

export function cliPath(provider: AgentProvider, env = process.env): string {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const names =
    process.platform === 'win32'
      ? [`${provider}.exe`, `${provider}.cmd`, provider]
      : [provider]
  for (const dir of dirs.filter(Boolean))
    for (const name of names) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  throw new Error(
    `${provider === 'claude' ? 'Claude Code' : 'Codex CLI'} is not installed or is missing from PATH. Install it and sign in using its native CLI, then retry.`,
  )
}

export function cliArguments(
  provider: AgentProvider,
  prompt: string,
  options: ThreadOptions,
  mcp?: { url: string },
  resumeId?: string,
): string[] {
  const args: string[] = []
  if (provider === 'codex') {
    // Keep conversation output in the terminal's normal scrollback buffer.
    args.push('--no-alt-screen')
    if (mcp)
      args.push(
        '-c',
        `mcp_servers.agent_constella.url=${JSON.stringify(mcp.url)}`,
        '-c',
        'mcp_servers.agent_constella.bearer_token_env_var="CONSTELLA_MCP_TOKEN"',
      )
    if (options.model) args.push('--model', options.model)
    if (options.modelReasoningEffort)
      args.push(
        '-c',
        `model_reasoning_effort=${JSON.stringify(options.modelReasoningEffort)}`,
      )
    if (resumeId) args.push('resume', resumeId)
  } else {
    if (mcp)
      args.push(
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            agent_constella: {
              type: 'http',
              url: mcp.url,
              headers: { Authorization: 'Bearer ${CONSTELLA_MCP_TOKEN}' },
            },
          },
        }),
      )
    if (options.model) args.push('--model', options.model)
    if (options.modelReasoningEffort)
      args.push('--effort', options.modelReasoningEffort)
    if (resumeId) args.push('--resume', resumeId)
  }
  // A literal argv element, never shell interpolation or simulated typing at startup.
  args.push('--', prompt)
  return args
}
