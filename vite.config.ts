/**
 * Standalone Vite config for Playwright E2E (renderer only, no Electron).
 *
 * `electron.vite.config.ts` is the primary config used by electron-vite for
 * bundling main/preload/renderer together. This file is a thin copy of the
 * renderer section so Playwright can spin up just the web app.
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'renderer/src'),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
