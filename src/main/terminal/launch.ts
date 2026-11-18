import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
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

/**
 * How to start a provider CLI. On Windows, npm installs CLIs as `.cmd`
 * wrapper scripts. Starting a wrapper goes through cmd.exe, which mangles
 * quoted arguments (such as Claude's JSON MCP config) and cuts multi-line
 * prompts, and newer Node versions refuse to execFile it at all. When the
 * wrapper is a standard npm shim, run its JavaScript entry with node.exe
 * directly instead, exactly as the shim would, minus cmd.exe.
 */
export function cliLaunch(
  provider: AgentProvider,
  env = process.env,
): { executable: string; prefixArgs: string[]; viaShell: boolean } {
  const path = cliPath(provider, env)
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(path))
    return { executable: path, prefixArgs: [], viaShell: false }
  try {
    const shim = readFileSync(path, 'utf8')
    // The shim names its target after %dp0%; skip its own node.exe probe.
    const match = [
      ...shim.matchAll(/"%(?:~)?dp0%\\?([^"%]+?\.(?:c?js|mjs|exe))"/gi),
    ].find((candidate) => !/(^|\\)node\.exe$/i.test(candidate[1]))
    if (match && /\.exe$/i.test(match[1])) {
      // Newer packages ship a native binary; run it directly.
      const binary = resolve(dirname(path), match[1])
      if (existsSync(binary))
        return { executable: binary, prefixArgs: [], viaShell: false }
    }
    if (match && !/\.exe$/i.test(match[1])) {
      const script = resolve(dirname(path), match[1])
      const node = [
        join(dirname(path), 'node.exe'),
        ...(env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, 'node.exe')),
      ].find((candidate) => existsSync(candidate))
      if (node && existsSync(script))
        return { executable: node, prefixArgs: [script], viaShell: false }
    }
  } catch {
    /* Fall back to the wrapper itself. */
  }
  return { executable: path, prefixArgs: [], viaShell: true }
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
