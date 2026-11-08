import headless from '@xterm/headless'
import type { Terminal } from '@xterm/headless'
import type { TerminalAttention, TerminalRead } from '../../shared/terminal'

// Inspect the live screen, never scrollback or raw ANSI chunks. A question in
// command output is not enough: the CLI must also show interactive controls.
export function detectTerminalAttention(screen: Terminal): TerminalAttention | undefined {
  const buffer = screen.buffer.active
  const lines = Array.from({ length: screen.rows }, (_, index) =>
    buffer.getLine(buffer.baseY + index)?.translateToString(true).trim() ?? '',
  ).filter(Boolean).slice(-24)
  const text = lines.join('\n')
  const tail = lines.slice(-3).join('\n')
  const submitControls = /(?:press\s+)?enter\s+to\s+(?:confirm|select|submit|continue|accept)|press any key to continue|\[(?:y\/n|yes\/no)\]|\((?:y\/n|yes\/no)\)/i
  const controls = /esc(?:ape)?\s+to\s+(?:cancel|go back|deny)|(?:tab|arrow keys|↑|↓).*?(?:select|navigate)/i
  const options = lines.filter((line) =>
    /^[\s│┃>❯›●○*]*(?:\d+[.)]\s*)?(?:yes\b|no\b|allow\b|approve\b|accept\b|deny\b|reject\b|cancel\b)/i.test(line),
  )
  const question = /\?\s*$/m.test(text) || /(?:permission|approval) required/i.test(text)
  const choicesAtEnd = options.length >= 2 && lines.slice(-2).some((line) => options.includes(line))
  if (!submitControls.test(tail) && !(controls.test(tail) && (question || options.length >= 2)) && !(question && choicesAtEnd)) return
  // Busy indicators below an earlier prompt mean the CLI has resumed.
  if (/esc to interrupt|ctrl\+c to interrupt|continuing (?:shortly|automatically)/i.test(tail)) return
  if (/permission|approval|allow|approve|trust|would you like to run|do you want to (?:run|execute)|(?:don't|do not) ask again|yes,?\s+proceed/i.test(text))
    return 'permission'
  if (/would you like|do you want|accept|confirm|proceed|\byes\b.*\bno\b|[\[(](?:y\/n|yes\/no)[\])]/is.test(text))
    return 'confirmation'
  return 'input'
}

// The detached daemon can outlive app upgrades. Reconstruct its screen from
// existing read snapshots/deltas so attention also works for those sessions.
export class TerminalAttentionMonitor {
  private screen?: Terminal
  async read(value: TerminalRead): Promise<TerminalAttention | undefined> {
    const { cols, rows } = value.session
    if (!this.screen || value.reset) {
      this.screen?.dispose()
      this.screen = new headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
    } else if (this.screen.cols !== cols || this.screen.rows !== rows) {
      this.screen.resize(cols, rows)
    }
    if (value.data)
      await new Promise<void>((resolve) => this.screen!.write(value.data, resolve))
    return value.session.state === 'running' ? detectTerminalAttention(this.screen) : undefined
  }
  dispose() {
    this.screen?.dispose()
  }
}
