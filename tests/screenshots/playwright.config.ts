import {defineConfig} from '@playwright/test';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import base from '../../playwright.config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Screenshots for the README. They are taken separately from the browser tests:
// npm run screenshots writes them to docs/screenshots.
export default defineConfig({
  ...base,
  // A port of its own, so a running development server does not get in the way.
  use: {...base.use, baseURL: 'http://127.0.0.1:5174'},
  testDir: '.',
  testMatch: 'readme.spec.ts',
  outputDir: resolve(root, '.local/screenshots-results'),
  timeout: 90_000,
  expect: {timeout: 20_000},
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    cwd: root,
    reuseExistingServer: false,
    env: {REZZKA_DATA_DIR: resolve(root, '.local/screenshots-data')},
    timeout: 30_000,
  },
});
