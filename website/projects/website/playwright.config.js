// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'off', // we take manual screenshots
    video: 'off',
  },
  projects: [
    {
      name: 'mobile-cafe',
      use: {
        ...devices['iPhone 14'],
        deviceScaleFactor: 2,
      },
    },
  ],
});
