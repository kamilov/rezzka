import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';

const syntheticKey = '00000000-1111-2222-3333-444444444444';
type BridgeRequest = { method: string; params: Record<string, unknown> };

async function fixture(page: Page, options: { configured?: boolean; statusFailures?: number; saveFailures?: number; deferSave?: boolean } = {}) {
  const requests: BridgeRequest[] = [], errors: string[] = [], external: string[] = [];
  let configured = options.configured ?? false, revision = 0;
  let statusFailures = options.statusFailures ?? 0, saveFailures = options.saveFailures ?? 0;
  let pending: { route: Route; apiKey: string } | undefined;
  const statusReply = (route: Route) => route.fulfill({ json: { returnValue: true, kinopoiskStatus: { configured, revision } } });
  const apply = async (route: Route, apiKey: string) => {
    configured = Boolean(apiKey); revision++;
    await statusReply(route);
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const body = route.request().postDataJSON() as BridgeRequest;
    requests.push(body);
    switch (body.method) {
      case 'getSettings': await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: defaultSettings } } }); return;
      case 'saveSettings': await route.fulfill({ json: { returnValue: true, settings: { revision: 2, values: body.params.values } } }); return;
      case 'getKinopoiskStatus':
        if (statusFailures-- > 0) { await route.fulfill({ json: { returnValue: false, errorCode: 'storage_error', errorText: 'Не удалось прочитать настройки Кинопоиска.' } }); return; }
        await statusReply(route); return;
      case 'setKinopoiskKey': {
        expect(Object.keys(body.params)).toEqual(['apiKey']);
        const apiKey = body.params.apiKey as string;
        if (saveFailures-- > 0) { await route.fulfill({ json: { returnValue: false, errorCode: 'kinopoisk_unauthorized', errorText: 'Ключ Кинопоиска не принят. Проверьте ключ.' } }); return; }
        if (options.deferSave && apiKey) { pending = { route, apiKey }; return; }
        await apply(route, apiKey); return;
      }
      default: throw new Error(`Unexpected settings fixture method: ${body.method}`);
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('configure-source')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('nav-settings').focus(); await page.keyboard.press('Enter'); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('settings-section-source')).toBeVisible();
  await expect(page.getByTestId('settings-mirror').locator('..')).toHaveClass(/is-focused/);
  return {
    requests, errors, external,
    kpReads: () => requests.filter(request => request.method === 'getKinopoiskStatus'),
    writes: () => requests.filter(request => request.method === 'setKinopoiskKey'),
    release: async () => { expect(pending).toBeDefined(); const request = pending!; pending = undefined; await apply(request.route, request.apiKey); },
  };
}

async function openKinopoisk(page: Page) {
  await page.getByTestId('settings-tab-kinopoisk').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('settings-section-kinopoisk')).toBeVisible();
}

test('Kinopoisk keys load lazily, save separately, are never read back and can be removed', async ({ page }, testInfo) => {
  const mocked = await fixture(page, { deferSave: true });
  expect(mocked.kpReads()).toHaveLength(0);
  await openKinopoisk(page);
  const key = page.getByTestId('kinopoisk-key');
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ не задан');
  await expect(key).toHaveAttribute('type', 'password'); await expect(key).toHaveValue('');
  await expect(page.getByTestId('settings-save')).toHaveCount(0); await expect(page.getByTestId('settings-reload')).toHaveCount(0);
  await expect(page.getByTestId('kinopoisk-save')).toBeDisabled();
  await expect(page.getByTestId('kinopoisk-remove')).toBeDisabled();
  await key.fill(syntheticKey); await page.getByTestId('kinopoisk-save').click(); await page.mouse.move(1919, 0);
  await expect(key).toBeDisabled(); await expect(key).toHaveValue('');
  await expect(page.getByTestId('kinopoisk-save')).toBeDisabled(); await expect(page.getByTestId('kinopoisk-remove')).toBeDisabled();
  expect(mocked.writes()).toEqual([{ method: 'setKinopoiskKey', params: { apiKey: syntheticKey } }]);
  await mocked.release();
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ проверен и сохранён');
  await expect(page.getByTestId('kinopoisk-remove')).toBeEnabled();
  await expect(key).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('kinopoisk-settings.png') });

  // Any other setting is saved the moment it changes and carries nothing about the key.
  await page.getByTestId('settings-tab-playback').click(); await page.mouse.move(1919, 0);
  await page.getByTestId('settings-subtitles').click(); await page.mouse.move(1919, 0);
  await expect(page.locator('.save-status')).toContainText('Сохранено');
  await openKinopoisk(page);
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ сохранён на этом устройстве');
  await expect(key).toHaveValue('');
  expect(mocked.kpReads()).toHaveLength(2);
  expect(mocked.requests.filter(request => request.method === 'saveSettings')).toEqual([
    { method: 'saveSettings', params: { expectedRevision: 1, values: { ...defaultSettings, subtitles: true } } },
  ]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(syntheticKey);
  await page.getByTestId('kinopoisk-remove').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ удалён');
  await expect(page.getByTestId('kinopoisk-remove')).toBeDisabled(); await expect(key).toHaveValue('');
  expect(mocked.writes().at(-1)).toEqual({ method: 'setKinopoiskKey', params: { apiKey: '' } });
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a rejected replacement clears its input and leaves the saved key available for removal', async ({ page }) => {
  const mocked = await fixture(page, { configured: true, saveFailures: 1 });
  await openKinopoisk(page);
  const key = page.getByTestId('kinopoisk-key');
  await expect(page.getByTestId('kinopoisk-remove')).toBeEnabled();
  await key.fill('synthetic-invalid-key'); await page.getByTestId('kinopoisk-save').click(); await page.mouse.move(1919, 0);
  await expect(page.getByRole('alert')).toContainText('Ключ Кинопоиска не принят');
  await expect(key).toHaveValue(''); await expect(page.getByTestId('kinopoisk-remove')).toBeEnabled();
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ сохранён на этом устройстве');
  await key.fill(syntheticKey); await page.getByTestId('kinopoisk-save').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ проверен и сохранён');
  await expect(key).toHaveValue(''); expect(mocked.writes()).toHaveLength(2);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a failed status read stays distinct from disabled integration and can be retried', async ({ page }) => {
  const mocked = await fixture(page, { statusFailures: 1 });
  await openKinopoisk(page);
  await expect(page.getByRole('alert')).toContainText('Не удалось прочитать настройки Кинопоиска');
  await expect(page.getByTestId('kinopoisk-status')).not.toContainText('Ключ не задан');
  await expect(page.getByTestId('kinopoisk-save')).toBeDisabled();
  await page.getByTestId('kinopoisk-retry').click(); await page.mouse.move(1919, 0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ не задан');
  expect(mocked.kpReads()).toHaveLength(2); expect(mocked.writes()).toHaveLength(0);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('leaving the key section clears a draft and a late save cannot steal focus', async ({ page }) => {
  const mocked = await fixture(page, { deferSave: true });
  await openKinopoisk(page);
  const key = page.getByTestId('kinopoisk-key');
  await key.fill('synthetic-unsaved-key');
  await page.getByTestId('settings-tab-interface').click(); await openKinopoisk(page);
  await expect(key).toHaveValue('');
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ не задан');
  await key.fill(syntheticKey); await page.getByTestId('kinopoisk-save').click();
  await expect(key).toBeDisabled();
  await page.clock.install();
  await page.getByTestId('settings-tab-interface').click(); await page.mouse.move(1919, 0);
  await page.getByTestId('settings-theme-light').focus(); await page.clock.runFor(100);
  await mocked.release(); await page.clock.runFor(100);
  await expect(page.getByTestId('settings-theme-light')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('settings-section-kinopoisk')).toHaveCount(0);
  await openKinopoisk(page);
  await expect(page.getByTestId('kinopoisk-status')).toContainText('Ключ сохранён на этом устройстве');
  await expect(key).toHaveValue(''); expect(mocked.writes()).toHaveLength(1);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
