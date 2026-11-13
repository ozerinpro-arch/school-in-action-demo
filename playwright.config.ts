import { defineConfig } from '@playwright/test'

const baseURL = new URL(process.env.DEMO_BASE_URL || 'http://127.0.0.1:5188')
if (baseURL.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseURL.hostname)) {
  throw new Error('Run the browser tests against a local demo instance.')
}

export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: baseURL.origin,
    browserName: 'chromium',
    channel: process.env.DEMO_CHROME_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
})
