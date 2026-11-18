import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ApplicationError } from './errors'

const quote = (path: string) => `"${path}"`

function onPath(name: string, env = process.env): string | undefined {
  const names =
    process.platform === 'win32'
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name]
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const candidate of names) {
      const path = join(dir, candidate)
      if (existsSync(path)) return path
    }
  return undefined
}

/** Finds an installed editor when the project has no IDE command yet. */
export function detectIde(env = process.env): string | undefined {
  // Keep tests independent of the editors installed on this machine.
  if (env.VITEST && !env.CONSTELLA_TEST_DETECT_IDE) return undefined
  const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const programs = env.ProgramFiles ?? 'C:\\Program Files'
  const fixed =
    process.platform === 'win32'
      ? [
          join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
          join(programs, 'Microsoft VS Code', 'Code.exe'),
          join(local, 'Programs', 'cursor', 'Cursor.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
          ]
        : []
  const found = fixed.find((path) => existsSync(path))
  if (found) return quote(found)
  for (const name of ['code', 'cursor', 'zed']) {
    const path = onPath(name, env)
    if (path) return quote(path)
  }
  return undefined
}

/** The saved IDE command, or a detected editor when none is saved. */
export function effectiveIdeCommand(command: string | null | undefined): string {
  return command?.trim() ? command : (detectIde() ?? '')
}

/**
 * Windows editors often install a `.cmd` launcher (VS Code's `code`), which
 * cannot be spawned without a shell. Prefer the editor's real executable.
 */
function windowsExecutable(executable: string): string | { shell: string } {
  const resolved = /[\\/]/.test(executable) ? executable : onPath(executable)
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return resolved ?? executable
  const bin = dirname(resolved)
  for (const exe of [
    join(bin, '..', 'Code.exe'),
    join(bin, '..', '..', '..', 'Cursor.exe'),
    join(bin, '..', 'Code - Insiders.exe'),
  ])
    if (existsSync(exe)) return exe
  return { shell: resolved }
}

// Parse executable + arguments without running a shell or expanding substitutions.
export function ideArguments(command: string): string[] {
  const words: string[] = []
  let word = ''
  let quote = ''
  let started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && command[i + 1] && /[\s"'\\]/.test(command[i + 1]) && quote !== "'") {
      word += command[++i]
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote)
    throw new ApplicationError(
      'IDE_COMMAND', 'The IDE command has an unclosed quote.',
      'Correct the command in Project settings.',
    )
  if (started) words.push(word)
  if (!words[0])
    throw new ApplicationError(
      'IDE_COMMAND',
      'No code editor found. Add one in Project settings.',
      'Install VS Code or Cursor, or add your editor in Project settings → Commands.',
    )
  return words
}

/**
 * VS Code and Cursor are Electron apps. If they inherit Electron's
 * run-as-node flags from this app, they start headless and exit silently.
 */
function ideEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...new Set([process.env.PATH ?? '', '/usr/local/bin', '/opt/homebrew/bin'])].join(delimiter),
  }
  for (const key of Object.keys(env))
    if (/^(ELECTRON_|VSCODE_|CHROME_)/i.test(key)) delete env[key]
  return env
}

export async function launchIde(
  command: string, path: string, start: typeof spawn = spawn,
): Promise<void> {
  let [executable, ...args] = ideArguments(effectiveIdeCommand(command))
  let shell = false
  if (process.platform === 'win32') {
    const target = windowsExecutable(executable)
    if (typeof target === 'string') executable = target
    else {
      // Last resort for other .cmd launchers: quote everything for cmd.exe and
      // refuse characters cmd.exe would interpret.
      const unsafe = [target.shell, ...args, path].find((part) => /["%^&|<>]/.test(part))
      if (unsafe)
        throw new ApplicationError(
          'IDE_LAUNCH',
          'This IDE launcher cannot safely open that path.',
          'Use the editor’s .exe path as the IDE command in Project settings.',
        )
      shell = true
      executable = quote(target.shell)
      args = args.map(quote)
    }
  }
  await new Promise<void>((resolve, reject) => {
    const child = start(executable, [...args, shell ? quote(path) : path], {
      cwd: path,
      shell,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: ideEnvironment(),
    })
    child.once('error', (error) => reject(new ApplicationError(
      'IDE_LAUNCH',
      `Could not open the IDE: ${error.message}`,
      'Check the IDE command and install its command-line launcher, or use its full executable path.',
    )))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
