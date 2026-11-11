import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest, TitleSummary, Voice } from '../../shared/source';

const accountOrigin = 'https://history.fixture.example';
const accountTitle: TitleSummary = { id: '701', url: accountOrigin + '/series/fiction/701-history.html', title: 'История путешествия', poster: '', kind: 'series' };
const preferredVoice: Voice = { id: '8', label: 'Первая студия', isAds: '0', isCamrip: '0', isDirector: '0' };
const accountVoice: Voice = { id: '9', label: 'Вторая студия', isAds: '0', isCamrip: '0', isDirector: '0' };
const localOnlyTitle = { ...accountTitle, id: '709', url: accountOrigin + '/series/fiction/709-local.html', title: 'Только на устройстве' };
const accountSurvivor = '<div class="b-videosaves__list_item" id="videosave-92"><div class="title"><a href="/films/drama/703-remote.html" data-cover_url="">Просмотрено на сайте</a></div><div class="date">Вчера</div><div class="info">Фильм</div></div>';
const accountRows = `<div id="videosaves-list" class="b-videosaves__list"><div class="b-videosaves__list_item" id="videosave-91"><div class="title"><a href="/series/fiction/701-history.html" data-cover_url="">История путешествия</a></div><div class="date">Сегодня</div><div class="info">Вторая студия · Сезон 2 · Серия 2</div></div>${accountSurvivor}</div>`;
const accountEmpty = '<div id="videosaves-list" class="b-videosaves__list"><p>Вы ещё ничего не сохраняли.</p></div>';
const accountEpisodes = '<ul class="b-simple_episodes__list" id="simple-episodes-list-1"><li class="b-simple_episode__item" data-season_id="1" data-episode_id="1">Серия 1</li><li class="b-simple_episode__item" data-season_id="1" data-episode_id="2">Серия 2</li></ul><ul class="b-simple_episodes__list" id="simple-episodes-list-2"><li class="b-simple_episode__item" data-season_id="2" data-episode_id="1">Серия 1</li><li class="b-simple_episode__item active" data-season_id="2" data-episode_id="2">Серия 2</li></ul>';
const accountCatalog = `<div class="b-content__inline_item" data-id="701"><div class="b-content__inline_item-link"><a href="${accountTitle.url}">${accountTitle.title}</a></div></div>`;
const accountDetails = `<meta property="og:type" content="video.tv_show"><div class="b-post__title"><h1>${accountTitle.title}</h1></div><div class="b-userset__fav_holder" data-post_id="701"></div><div class="b-translator__item" data-translator_id="8" title="Первая студия"></div><div class="b-translator__item active" data-translator_id="9" title="Вторая студия"></div>${accountEpisodes}`;

async function mockAccount(page: Page, options: { authenticated?: boolean; onContinue?: (route: Route) => Promise<void> } = {}) {
  const requests: SourceRequest[] = [], external: string[] = [], errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') {
      await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: accountOrigin, preferredVoice: preferredVoice.id } } } });
      return;
    }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: options.authenticated ?? true, origin: accountOrigin, username: 'fixture-account' } } }); return; }
    expect(method).toBe('getSource');
    requests.push(params);
    if (params.operation === 'continue' && options.onContinue) { await options.onContinue(route); return; }
    const browseFilters = params.operation === 'browse' ? `<select class="select-category"><option value="/${params.type}/best/">Все жанры</option><option value="/${params.type}/best/drama/">Драма</option></select><select class="select-year"><option value="0">Все годы</option><option value="2026">2026</option></select>` : '';
    const body = params.operation === 'continueSave' ? JSON.stringify({ success: true }) : params.operation === 'continue' ? accountRows : params.operation === 'details' ? accountDetails : params.operation === 'episodes'
      ? JSON.stringify({ success: true, episodes: accountEpisodes }) : params.operation === 'streams'
        ? JSON.stringify({ success: true, url: `[720p]${url.origin}/demo/sample.mp4`, subtitle: false }) : browseFilters + accountCatalog;
    await route.fulfill({ json: { returnValue: true, source: { body, url: params.operation === 'details' ? accountTitle.url : accountOrigin + (params.operation === 'continue' ? '/continue/' : '/') } } });
  });
  return { requests, external, errors };
}
// Back first hides the player's controls when they are shown, then closes the player.
async function leavePlayer(page: Page) {
  for (let presses = 0; presses < 3 && await page.getByTestId('player').count(); presses++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await expect(page.getByTestId('player')).toHaveCount(0);
}

test('an account entry that is further along decides the voice and episode, and this device supplies the position', async ({ page }) => {
  const history = [
    { title: localOnlyTitle, voice: preferredVoice, episode: { season: '1', id: '1', title: 'Серия 1' }, position: 3, duration: 12, updatedAt: 300 },
    { title: accountTitle, voice: preferredVoice, episode: { season: '1', id: '2', title: 'Серия 2' }, position: 8, duration: 12, updatedAt: 200 },
    { title: accountTitle, voice: accountVoice, episode: { season: '2', id: '2', title: 'Серия 2' }, position: 4, duration: 12, updatedAt: 100 },
  ];
  await page.addInitScript(history => {
    localStorage.setItem('rezzka.library.v1', JSON.stringify({ favorites: [], history }));
    const state = window as unknown as { historySeeks: number[] }; state.historySeeks = [];
    document.addEventListener('seeking', event => { if (event.target instanceof HTMLVideoElement) state.historySeeks.push(event.target.currentTime); }, true);
  }, history);
  // Reads of the list are answered at once until `hold` is set; then they wait, like a slow source.
  let hold = false;
  const held: Route[] = [];
  const mocked = await mockAccount(page, { onContinue: async route => {
    if (hold) { held.push(route); return; }
    await route.fulfill({ json: { returnValue: true, source: { body: accountRows, url: accountOrigin + '/continue/' } } });
  } });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  // The home row is the account's list: a title watched only on this device is not mixed into it.
  await expect(page.getByTestId('continue-91')).toContainText(accountTitle.title);
  await expect(page.getByTestId('home-continue').getByText(localOnlyTitle.title)).toHaveCount(0);
  await page.getByTestId('nav-library').click();
  await page.mouse.move(1919, 0);
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('history-91')).toContainText('Серия 2');
  await expect(page.getByTestId('history-92')).toContainText('Просмотрено на сайте');
  await expect(page.getByTestId('screen-library').getByText(localOnlyTitle.title)).toHaveCount(0);
  await page.getByTestId('history-91').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('details-play')).toBeEnabled();
  // The device last watched season 1 with the preferred voice; the account holds season 2 with another one.
  await expect(page.getByTestId('details-status')).toContainText('Вы остановились: сезон 2, серия 2');
  await expect(page.getByTestId('details-status')).toContainText('Вторая студия');
  await expect(page.getByTestId('details-episode-2-2')).toContainText('Вы остановились здесь');
  expect(mocked.requests.filter(request => ['episodes', 'streams'].includes(request.operation))).toEqual([]);
  await page.getByTestId('details-play').click();
  await expect(page.getByTestId('player')).toBeVisible();
  await expect.poll(() => mocked.requests.find(request => request.operation === 'streams')).toMatchObject({ operation: 'streams', id: '701', voice: { id: '9' }, season: '2', episode: '2' });
  await expect(page.locator('.player-context')).toContainText('Сезон 2, серия 2');
  await expect(page.getByTestId('player-voice')).toContainText('Вторая студия');
  // Playing tells the account which episode is being watched.
  await expect.poll(() => mocked.requests.filter(request => request.operation === 'continueSave')).toEqual([expect.objectContaining({ id: '701', voice: expect.objectContaining({ id: '9' }), season: '2', episode: '2' })]);
  // A seeking event proves restoration; simply waiting until currentTime >= 4
  // would also pass after four seconds of incorrectly starting from zero.
  await expect.poll(() => page.evaluate(() => (window as unknown as { historySeeks: number[] }).historySeeks.some(position => Math.abs(position - 4) < .1))).toBe(true);
  hold = true;
  await leavePlayer(page);
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-library')).toBeVisible();
  // The list is read again; until the answer comes focus returns to the card the title was opened from.
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(page.getByTestId('history-91')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('history-92')).toContainText('Просмотрено на сайте');
  for (const route of held) await route.fulfill({ json: { returnValue: true, source: { body: `<div class="b-videosaves__list">${accountSurvivor}</div>`, url: accountOrigin + '/continue/' } } });
  await expect(page.getByTestId('history-91')).toHaveCount(0);
  await expect(page.getByTestId('history-92')).toHaveAttribute('data-focused', 'true');
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('account history appears on a fresh device and reloads from the source', async ({ page }) => {
  const mocked = await mockAccount(page);
  for (let visit = 0; visit < 2; visit++) {
    if (visit === 0) await page.goto('/'); else await page.reload();
    await expect(page.getByTestId('title-last-0')).toBeVisible();
    await expect(page.getByTestId('continue-91')).toContainText(accountTitle.title);
    await page.getByTestId('nav-library').click();
    await expect(page.getByTestId('history-91')).toContainText(accountTitle.title);
    await expect(page.getByTestId('history-92')).toContainText('Просмотрено на сайте');
    expect(await page.evaluate(() => localStorage.getItem('rezzka.library.v1'))).toBeNull();
  }
  // Each visit reads the list for the home row and again when «Моё» opens.
  expect(mocked.requests.filter(request => request.operation === 'continue')).toHaveLength(4);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('account history asks for login instead of presenting local playback as account history', async ({ page }) => {
  await page.addInitScript(title => localStorage.setItem('rezzka.library.v1', JSON.stringify({ favorites: [], history: [{ title, voice: { id: '8', label: 'Студия' }, position: 3, duration: 12, updatedAt: 300 }] })), localOnlyTitle);
  const mocked = await mockAccount(page, { authenticated: false });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-library').click();
  await page.clock.runFor(100);
  await expect(page.getByTestId('history-signin')).toBeVisible();
  await expect(page.getByTestId('mine-screen').getByText(localOnlyTitle.title)).toHaveCount(0);
  await page.mouse.move(1919, 0);
  for (const cancelWith of ['remote', 'button']) {
    await page.getByTestId('history-signin').focus();
    await expect(page.getByTestId('history-signin')).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-auth')).toBeVisible();
    await page.clock.runFor(100);
    if (cancelWith === 'remote') await page.keyboard.press('Escape');
    else await page.getByTestId('auth-cancel').click();
    await page.clock.runFor(100);
    await expect(page.getByTestId('screen-library')).toBeVisible();
    await expect(page.getByTestId('history-signin')).toHaveAttribute('data-focused', 'true');
  }
  expect(mocked.requests.filter(request => request.operation === 'continue')).toEqual([]);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('account history can retry a failure and show an explicitly empty source list', async ({ page }) => {
  await page.clock.install();
  let failing = true;
  const mocked = await mockAccount(page, { onContinue: async route => {
    if (failing) { await route.fulfill({ json: { returnValue: false, errorText: 'История временно недоступна.' } }); return; }
    await route.fulfill({ json: { returnValue: true, source: { body: accountEmpty, url: accountOrigin + '/continue/' } } });
  } });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  // A failed read only leaves the row out of the home screen; the catalog stays usable.
  await expect(page.getByTestId('home-continue')).toHaveCount(0);
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('nav-library').click();
  // Finish navigation's deferred focus before pressing the retry control.
  await page.clock.runFor(100);
  await expect(page.getByRole('alert')).toContainText('История временно недоступна.');
  await page.mouse.move(1919, 0);
  await page.getByTestId('history-retry').focus();
  await expect(page.getByTestId('history-retry')).toHaveAttribute('data-focused', 'true');
  failing = false;
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('history-retry')).toHaveCount(0);
  await expect(page.getByText('Вы пока ничего не смотрели')).toBeVisible();
  await expect(page.getByTestId('screen-library').locator('[data-testid^="history-"]')).toHaveCount(0);
  // The home row, the opening of «Моё» and the retry.
  expect(mocked.requests.filter(request => request.operation === 'continue')).toHaveLength(3);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('hidden sections stay outside remote navigation and the player keeps focus to itself', async ({ page }) => {
  const mocked = await mockAccount(page);
  await page.clock.install();
  const settleFocus = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const focusIsVisible = async () => {
    const focused = page.locator('[data-focused="true"]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toBeVisible();
    expect(await focused.evaluate(element => element.getClientRects().length)).toBeGreaterThan(0);
  };
  const navigate = async (id: string) => {
    await page.getByTestId(id).focus();
    await expect(page.getByTestId(id)).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Enter');
    // Finish the navigation's delayed initial focus before the next remote action.
    await page.clock.runFor(100);
  };
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.mouse.move(1919, 0);
  await navigate('nav-browse');
  await expect(page.getByTestId('browse-title-0')).toBeVisible();
  await page.getByTestId('browse-type-films').focus();
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('browse-type-series')).toHaveAttribute('data-focused', 'true');
  await navigate('nav-library');
  await expect(page.getByTestId('history-91')).toBeVisible();
  await navigate('nav-catalog');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await expect(page.getByTestId('browse-type-films')).toBeHidden();
  await expect(page.getByTestId('history-91')).toBeHidden();
  // Opening a section puts focus into its content; from there every move lands on something visible.
  await expect(page.getByTestId('continue-91')).toHaveAttribute('data-focused', 'true');
  for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key); await settleFocus(); await focusIsVisible();
  }

  await navigate('nav-search');
  await page.getByTestId('search-query').focus();
  await page.getByTestId('search-query').fill('проверка');
  await expect(page.getByTestId('search-query')).toHaveValue('проверка');
  await navigate('nav-library');
  await expect(page.getByTestId('history-91')).toBeVisible();
  await navigate('history-91');
  await expect(page.getByTestId('details-play')).toBeEnabled();
  await navigate('details-play');
  await expect.poll(() => page.getByTestId('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(.1);
  await page.getByTestId('player-toggle').focus();
  await expect(page.getByTestId('player-toggle')).toHaveAttribute('data-focused', 'true');
  for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown']) {
    await page.keyboard.press(key); await settleFocus(); await focusIsVisible();
    await expect(page.getByTestId('player').locator('[data-focused="true"]')).toHaveCount(1);
    await expect(page.locator('.app-shell [data-focused="true"]')).toHaveCount(0);
  }
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('a delayed title keeps remote focus and ignores its response after leaving', async ({ page }) => {
  const origin = 'https://delayed.fixture.example';
  const titleUrl = origin + '/films/drama/702-delayed.html';
  const catalog = `<div class="b-content__inline_item" data-id="702"><div class="b-content__inline_item-link"><a href="${titleUrl}">Отложенная карточка</a></div></div>`;
  let pending: Route | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') {
      await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } });
      return;
    }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (params.operation === 'details') { pending = route; return; }
    await route.fulfill({ json: { returnValue: true, source: { body: catalog, url: origin + '/' } } });
  });
  await page.goto('/');
  await page.getByTestId('title-last-0').click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  // Until the description arrives the card has one control, and focus waits on it.
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('details-status')).toContainText('Загружаем описание');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-catalog')).toBeVisible();
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');

  const received = page.waitForResponse((response) => response.url().endsWith('/__bridge') && response.request().postDataJSON().params?.operation === 'details');
  const body = '<meta property="og:type" content="video.movie"><div class="b-post__title"><h1>Устаревший ответ</h1></div><div class="b-userset__fav_holder" data-post_id="702"></div><div class="b-translator__item active" data-translator_id="8" title="Озвучка"></div>';
  await pending!.fulfill({ json: { returnValue: true, source: { body, url: titleUrl } } });
  await received;
  // A stale completion used to schedule focusSoon; let that 40 ms timer expire.
  await page.waitForTimeout(100);
  await expect(page.getByTestId('screen-catalog')).toBeVisible();
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('screen-details')).toHaveCount(0);
  expect(errors).toEqual([]);
});
