/** Opt-in real-app README capture; deliberately excluded from the normal .spec matrix. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig({
  ...base,
  testMatch: 'readme.capture.ts',
  timeout: 600_000,
  outputDir: '/private/tmp/plumelens-readme-capture-results',
})
