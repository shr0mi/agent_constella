import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { ideArguments, launchIde } from '../src/main/application/ide-launcher'

it('passes quoted executable paths, arguments, and workspace paths literally without a shell', async () => {
  expect(ideArguments('"/Applications/My IDE/bin/code" --new-window')).toEqual(['/Applications/My IDE/bin/code', '--new-window'])
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const start = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child })
  const path = "/tmp/task's $(do-not-execute)"
  await launchIde('code --new-window', path, start as unknown as typeof spawn)
  // On Windows, a `code.cmd` launcher on PATH is swapped for the editor's real executable.
  const executable = process.platform === 'win32' ? expect.stringMatching(/(^code$|code(\.exe)?$)/i) : 'code'
  expect(start).toHaveBeenCalledWith(executable, ['--new-window', path], expect.objectContaining({ cwd: path, shell: false }))
  expect(child.unref).toHaveBeenCalledOnce()
  expect(() => ideArguments('"unterminated')).toThrow('unclosed quote')
  expect(() => ideArguments('')).toThrow('Project settings')
})

it('reports a missing IDE launcher with an actionable settings error', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const start = vi.fn(() => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child })
  await expect(launchIde('missing-editor', '/tmp', start as unknown as typeof spawn)).rejects.toMatchObject({ code: 'IDE_LAUNCH', hint: expect.stringContaining('full executable path') })
})
