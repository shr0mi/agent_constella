import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  main: {
    build: { externalizeDeps: true, rollupOptions: { input: { index: resolve('src/main/index.ts'), 'terminal-daemon': resolve('src/main/terminal/daemon.ts') } } },
    plugins: [
      {
        name: 'bundle-upstream-skills',
        writeBundle(options) {
          if (!options.dir)
            throw new Error(
              'The main build needs an output directory for bundled skill resources.',
            )
          const destination = resolve(options.dir, 'bundled-skills')
          rmSync(destination, { recursive: true, force: true })
          cpSync(
            fileURLToPath(
              new URL('./src/main/application/bundled-skills', import.meta.url),
            ),
            destination,
            { recursive: true },
          )
        },
      },
    ],
  },
  preload: {
    build: {
      // Sandboxed preloads cannot require arbitrary installed packages.
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'development-refresh-csp',
        transformIndexHtml: {
          order: 'post',
          handler(html, context) {
            // React Fast Refresh injects an inline preamble only in development.
            // The packaged renderer keeps script-src restricted to self.
            return context.server
              ? html.replace(
                  "script-src 'self'",
                  "script-src 'self' 'unsafe-inline'",
                )
              : html
          },
        },
      },
    ],
  },
})
