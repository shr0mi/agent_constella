import headless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

export function createTerminalScreen(cols: number, rows: number) {
  const screen = new headless.Terminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
  })
  const addon = new SerializeAddon()
  screen.loadAddon(addon)

  // SerializeAddon restores mouse tracking but omits the encoding. Track it
  // through the parser so split escape sequences and mode resets also work.
  let mouseEncoding = 0
  for (const final of ['h', 'l']) {
    screen.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      for (const mode of params) {
        if (mode === 1006 || mode === 1016)
          mouseEncoding = final === 'h' ? mode : 0
      }
      return false
    })
  }
  screen.parser.registerEscHandler({ final: 'c' }, () => {
    mouseEncoding = 0
    return false
  })

  return {
    screen,
    serialize: () =>
      addon.serialize() + (mouseEncoding ? `\x1b[?${mouseEncoding}h` : ''),
  }
}
