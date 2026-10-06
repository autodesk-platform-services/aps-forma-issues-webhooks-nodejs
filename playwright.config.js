import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:3217', browserName: 'chromium' },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3217',
    env: { PORT: '3217', APS_CLIENT_ID: '', APS_CLIENT_SECRET: '', COOKIE_SECURE: 'false', TRUST_PROXY: 'false' },
    reuseExistingServer: false
  }
});