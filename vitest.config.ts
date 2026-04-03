import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/renderer/setup.ts'],
    include: ['tests/renderer/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'renderer/src'),
    },
  },
})
