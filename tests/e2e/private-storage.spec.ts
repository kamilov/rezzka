import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

test('development static routes cannot expose private session files or raw imports', async ({ request }) => {
  const directory = await mkdtemp(resolve('.local/auth-static-fixture-'));
  const sentinel = 'synthetic-cookie-for-static-denial-test';
  try {
    for (const name of ['source-session.json', 'source-session.json.fixture.tmp', 'kinopoisk-key.json', 'kinopoisk-key.json.fixture.tmp', 'settings.json']) {
      const file = resolve(directory, name);
      await writeFile(file, JSON.stringify({ synthetic: sentinel }), { mode: 0o600 });
      for (const path of ['/' + relative(process.cwd(), file), '/@fs' + file]) {
        for (const suffix of ['', '?raw', '?import']) {
          const response = await request.get(path + suffix);
          expect(response.status()).toBe(403);
          expect(await response.text()).not.toContain(sentinel);
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
