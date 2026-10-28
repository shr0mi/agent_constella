import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import { ApplicationError } from './errors'

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
      'Set an IDE command in Project settings first.',
      'Use code, zed, or a quoted executable path with optional arguments. The workspace path is appended automatically.',
    )
  return words
}

export async function launchIde(
  command: string, path: string, start: typeof spawn = spawn,
): Promise<void> {
  const [executable, ...args] = ideArguments(command)
  await new Promise<void>((resolve, reject) => {
    const child = start(executable, [...args, path], {
      cwd: path,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PATH: [...new Set([process.env.PATH ?? '', '/usr/local/bin', '/opt/homebrew/bin'])].join(delimiter) },
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
