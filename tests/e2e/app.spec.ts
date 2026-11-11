import {test, expect} from '@playwright/test';
import {defaultSettings} from '../../shared/settings';

test.beforeEach(async ({page}) => {
  // The Playwright server has its own data directory. Keep each UI scenario
  // independent while still exercising the real settings bridge and LAN setup.
  const headers = {Origin: 'http://127.0.0.1:5173'};
  const current = await (await page.request.post('/__bridge', {headers, data: {method: 'getSettings', params: {}}})).json();
  expect(current.returnValue).toBe(true);
  const reset = await (await page.request.post('/__bridge', {headers, data: {method: 'saveSettings', params: {expectedRevision: current.settings.revision, values: defaultSettings}}})).json();
  expect(reset.returnValue).toBe(true);
  await page.route('**/__bridge', async route => {
    if (route.request().postDataJSON().method === 'getSource') {
      await route.fulfill({contentType: 'application/json', body: JSON.stringify({returnValue: false, errorText: 'Источник отключён в тесте интерфейса.'})});
    } else await route.continue();
  });
});

test('remote navigation opens a title, plays local video and restores focus', async ({page}) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.locator('.welcome-footnote')).toContainText('Источник не настроен');
  await expect(page.getByTestId('configure-source')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('demo-start')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('title-last-1')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-details')).toBeVisible();
  await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player')).toBeVisible();
  const video = page.getByTestId('video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(page.getByTestId('player-back-10')).toHaveCount(0);
  await expect(page.getByTestId('player-forward-10')).toHaveCount(0);
  await expect(page.getByTestId('player-toggle')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('player-timeline')).toHaveAttribute('data-focused', 'true');
  const start = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  const end = await video.evaluate((element: HTMLVideoElement) => Math.min(element.duration, element.currentTime + 10));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.seek-hint')).toContainText('Назад — отмена');
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(start, 1);
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs(await video.evaluate((element: HTMLVideoElement) => element.currentTime) - end)).toBeLessThan(0.1);
  await expect(page.locator('.seek-hint')).toHaveCount(0);
  await expect(page.getByTestId('player-timeline')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.seek-hint')).toContainText('Назад — отмена');
  await page.keyboard.press('Escape');
  await expect(page.locator('.seek-hint')).toHaveCount(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(end, 1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-timeline')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.seek-hint')).toContainText('Назад — отмена');
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs(await video.evaluate((element: HTMLVideoElement) => element.currentTime) - Math.max(0, end - 10))).toBeLessThan(0.1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-details')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title-last-1')).toHaveAttribute('data-focused', 'true');
  expect(failures).toEqual([]);
  await page.screenshot({path: '.local/catalog-review.png', fullPage: true});
});

test('TV settings persist and a paired browser edits the same values', async ({page, browser}) => {
  await page.goto('/');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-network')).toBeEnabled();
  // Nothing is typed yet, so there is no address to save.
  await expect(page.getByTestId('settings-save')).toBeDisabled();
  const mirror = page.getByTestId('settings-mirror');
  const field = mirror.locator('..');
  await expect(field).toHaveClass(/is-focused/);
  await page.mouse.move(1, 1);
  const layout = () => mirror.evaluate((input) => {
    const container = input.closest('.main-content')!;
    // Layout boxes, not painted ones: a focused control is drawn slightly larger without moving its neighbours.
    const bounds = (element: Element) => {
      const node = element as HTMLElement;
      let x = 0, y = 0;
      for (let current: HTMLElement | null = node; current && current !== container; current = current.offsetParent as HTMLElement | null) { x += current.offsetLeft; y += current.offsetTop; }
      return { x, y, width: node.offsetWidth, height: node.offsetHeight };
    };
    return {
      field: bounds(input.closest('label')!),
      input: bounds(input),
      nextControl: bounds(document.querySelector('[data-testid="settings-network"]')!),
    };
  });
  await page.getByTestId('settings-network').hover();
  await expect(field).not.toHaveClass(/is-focused/);
  const restingLayout = await layout();
  await mirror.hover();
  await expect(field).toHaveClass(/is-focused/);
  await expect(field).toBeFocused();
  await expect(field.locator('small')).toHaveText('OK — редактировать');
  expect(await layout()).toEqual(restingLayout);
  await page.keyboard.press('Enter');
  await expect(mirror).toBeFocused();
  await expect(field.locator('small')).toHaveText('OK — закончить ввод');
  expect(await layout()).toEqual(restingLayout);
  await mirror.press('Enter');
  await expect(mirror).not.toBeFocused();
  await expect(field).toBeFocused();
  await expect(field.locator('small')).toHaveText('OK — редактировать');
  expect(await layout()).toEqual(restingLayout);
  await page.getByTestId('settings-network').hover();
  await expect(field).not.toHaveClass(/is-focused/);
  expect(await layout()).toEqual(restingLayout);
  // A switch takes effect at once, without a save button.
  await page.getByTestId('settings-tab-playback').click();
  await page.getByTestId('settings-subtitles').click();
  await expect(page.locator('.save-status')).toHaveText('Сохранено.');
  await expect(page.getByTestId('settings-subtitles')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('settings-voice')).toContainText('Как в прошлый раз');
  // The typed address is saved by its own button.
  await page.getByTestId('settings-tab-source').click();
  await mirror.fill('https://example.com');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('screen-access')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Источник отключён в тесте интерфейса.');
  await page.reload();
  await page.getByTestId('gate-settings').click();
  await page.getByTestId('settings-tab-playback').click();
  await expect(page.getByTestId('settings-subtitles')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-tab-source').click();
  await page.getByTestId('settings-network').click();
  await expect(page.getByTestId('network-pin')).toHaveText(/^\d{4}$/);
  const pin = await page.getByTestId('network-pin').innerText();
  const urls = await page.locator('.network-addresses code').allTextContents();
  const url = urls.find(value => value.includes('127.0.0.1')) ?? urls[0];
  expect(url).toBeTruthy();
  const remoteContext = await browser.newContext();
  try {
    const remote = await remoteContext.newPage();
    await remote.goto(url);
    await remote.getByLabel('PIN с телевизора').fill(pin);
    await remote.getByRole('button', {name: 'Подключиться', exact: true}).click();
    await expect(remote.getByLabel('Субтитры')).toBeChecked();
    await expect(remote.getByLabel('Включать следующую серию автоматически')).toBeChecked();
    await remote.getByLabel('Включать следующую серию автоматически').uncheck();
    await remote.getByLabel('Предпочтительная озвучка').fill('Из браузера');
    await remote.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await expect(remote.getByRole('status')).toHaveText('Настройки сохранены на телевизоре.');
    await page.getByTestId('network-close').click();
    await expect(page.getByTestId('network-modal')).toHaveCount(0);
    await page.getByTestId('settings-tab-playback').click();
    await expect(page.getByTestId('settings-voice')).toContainText('Из браузера');
    await expect(page.getByTestId('settings-autonext')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => {
      try { await fetch(url, {signal: AbortSignal.timeout(1000)}); return false; } catch { return true; }
    }).toBe(true);
  } finally { await remoteContext.close(); }
  await page.screenshot({path: '.local/settings-review.png', fullPage: true});
});

test('search keeps the query and returns focus to its result', async ({page}) => {
  await page.goto('/');
  await page.getByTestId('demo-start').click();
  await page.getByTestId('nav-search').click();
  await page.getByTestId('search-query').fill('Sintel');
  await page.getByTestId('search-query').press('Enter');
  await expect(page.locator('.poster-button')).toHaveCount(1);
  await page.getByTestId('search-result-0').click();
  await expect(page.getByTestId('details-play')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-query')).toHaveValue('Sintel');
  await expect(page.getByTestId('search-result-0')).toHaveAttribute('data-focused', 'true');
});

test('theme changes immediately and survives reload', async ({page}) => {
  await page.goto('/');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-tab-interface').click();
  await page.getByTestId('settings-theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-tab-interface').click();
  await page.getByTestId('settings-theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
