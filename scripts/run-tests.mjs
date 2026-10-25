import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

// Use Electron's Node runtime so database tests load the same native SQLite
// binary as the desktop app, without rebuilding it back and forth for host Node.
const require = createRequire(import.meta.url)
const vitest = join(
  dirname(require.resolve('vitest/package.json')),
  'vitest.mjs',
)
const result = spawnSync(
  require('electron'),
  [vitest, 'run', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
)
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
