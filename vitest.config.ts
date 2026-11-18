import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Git and process start-up is much slower on Windows; many integration
    // tests take ~5s there, right at Vitest's default limit.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000,
  },
})
