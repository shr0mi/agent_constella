import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { build: { externalizeDeps: true } },
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
