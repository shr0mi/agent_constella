import { afterEach, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { createTerminalScreen } from '../src/main/terminal/screen'
import { detectTerminalAttention, TerminalAttentionMonitor } from '../src/main/terminal/attention'
import type { TerminalRead } from '../src/shared/terminal'

const screens: Terminal[] = []
afterEach(() => screens.splice(0).forEach((screen) => screen.dispose()))
async function render(text: string, rows = 30) {
  const { screen } = createTerminalScreen(100, rows)
  screens.push(screen)
  await new Promise<void>((resolve) => screen.write(text, resolve))
  return screen
}

it.each([
  ['Codex command', 'Would you like to run the following command?\r\n$ npm test\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel', 'permission'],
  ['Claude tool', 'Bash command\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don\'t ask again for npm test\r\n  3. No\r\nEsc to cancel', 'permission'],
  ['workspace trust', 'Do you trust the files in this folder?\r\n❯ 1. Yes, I trust this folder\r\n  2. No, exit\r\nEnter to confirm', 'permission'],
  ['result confirmation', 'Accept these changes?\r\n❯ 1. Accept\r\n  2. Reject\r\nEnter to confirm', 'confirmation'],
  ['yes/no', 'Continue? [Y/n]', 'confirmation'],
  ['clarifying question', 'Which environment should I use?\r\n  1. Development\r\n  2. Production\r\nEnter to submit · Esc to cancel', 'input'],
  ['login', 'Press Enter to continue', 'input'],
] as const)('detects %s prompts on the live screen', async (_name, prompt, attention) => {
  expect(detectTerminalAttention(await render(prompt))).toBe(attention)
})

it.each([
  'Working on permission handling…\r\n• Updating files (esc to interrupt)',
  'Example: Do you want to proceed?\r\nThis is documentation of a prompt.',
  'No permissions required.\r\nTests passed.',
  'Continuing shortly · esc to cancel',
  '› Implement approval and confirmation prompts',
  '',
])('does not turn output or silence into attention: %s', async (text) => {
  expect(detectTerminalAttention(await render(text))).toBeUndefined()
})

it('ignores old prompts in scrollback and clears after work resumes', async () => {
  const screen = await render('Do you want to proceed?\r\n1. Yes\r\n2. No\r\nEnter to confirm', 8)
  expect(detectTerminalAttention(screen)).toBe('confirmation')
  await new Promise<void>((resolve) => screen.write('\r\nRunning command\r\nOutput\r\nDone\r\n› Next instruction', resolve))
  expect(detectTerminalAttention(screen)).toBeUndefined()
  await new Promise<void>((resolve) => screen.write('\r\nprogress\r\n'.repeat(20), resolve))
  expect(screen.buffer.active.baseY).toBeGreaterThan(0)
  expect(detectTerminalAttention(screen)).toBeUndefined()
})

it('reconstructs split ANSI output, handles redraws/resizes and clears on handoff', async () => {
  const monitor = new TerminalAttentionMonitor()
  const value: TerminalRead = {
    session: { id: 'test', provider: 'codex', title: 'test', cwd: '/tmp', state: 'running', generation: 1, completedGeneration: 0, summary: '', createdAt: '', cols: 100, rows: 30 },
    data: '\x1b[2J\x1b[HWould you like to run the following command?\r\n\x1b[3',
    cursor: 1, reset: true,
  }
  try {
    expect(await monitor.read(value)).toBeUndefined()
    expect(await monitor.read({ ...value, reset: false, data: '3m1. Yes, proceed\r\n2. No\r\nEnter to confirm\x1b[0m' })).toBe('permission')
    expect(await monitor.read({ ...value, reset: false, data: '' })).toBe('permission')
    expect(await monitor.read({ ...value, reset: false, data: '\x1b[2J\x1b[HRunning tests…', session: { ...value.session, cols: 80, rows: 24 } })).toBeUndefined()
    expect(await monitor.read({ ...value, data: 'Accept changes? [y/n]' })).toBe('confirmation')
    expect(await monitor.read({ ...value, data: '', reset: false, session: { ...value.session, state: 'ready' } })).toBeUndefined()
  } finally {
    monitor.dispose()
  }
})
