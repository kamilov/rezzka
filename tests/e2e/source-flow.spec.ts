import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceDocument, SourceRequest } from '../../shared/source';

const origin = 'https://fixture.example';
const titleUrl = `${origin}/series/fiction/301-route.html`;
const titleName = 'Путь через источник';
const catalog = (name = titleName, id = '301') => `<div class="b-content__inline_items"><div class="b-content__inline_item" data-id="${id}"><span class="cat series"><i class="entity">Сериал</i></span><div class="b-content__inline_item-link"><a href="/series/fiction/${id}-route.html">${name}</a><div>2024, Россия, фантастика</div></div><i class="b-category-bestrating">8.3</i></div></div>`;
const episodes = `<ul class="b-simple_episodes__list" id="simple-episodes-list-1"><li class="b-simple_episode__item active" data-season_id="1" data-episode_id="1">Серия 1</li><li class="b-simple_episode__item" data-episode_id="2">Серия 2</li></ul><ul class="b-simple_episodes__list" id="simple-episodes-list-2"><li class="b-simple_episode__item" data-episode_id="1">Серия 1</li><li class="b-simple_episode__item" data-episode_id="2">Серия 2</li></ul>`;
const savedOnSource = `<div class="b-videosaves__list"><div class="b-videosaves__list_item" id="videosave-91"><div class="title"><a href="${titleUrl}" data-cover_url="">${titleName}</a></div><div class="date">Сегодня</div><div class="info">Первая студия · Сезон 1 · Серия 1</div></div></div>`;
const details = `<meta property="og:type" content="video.tv_show"><div class="b-post__title"><h1>${titleName}</h1></div><div class="b-post__description_text">Синтетическая карточка для проверки приложения.</div><div class="b-userset__fav_holder" data-post_id="301"></div><div class="b-translator__item active" data-translator_id="1" title="Первая студия" data-ads="0" data-camrip="0" data-director="0"></div><div class="b-translator__item" data-translator_id="2" title="Вторая студия" data-ads="0" data-camrip="0" data-director="0"></div>${episodes}`;
// The account's page marks the voice and episode it has saved; the fixture follows what the app records.
const savedDetails = (voice: string, season: string, episode: string) => details.replace(/ active"/g, '"')
  .replace(`class="b-translator__item" data-translator_id="${voice}"`, `class="b-translator__item active" data-translator_id="${voice}"`)
  .replace(/<ul class="b-simple_episodes__list"[\s\S]*$/, [1, 2].map(list => `<ul class="b-simple_episodes__list" id="simple-episodes-list-${list}">${[1, 2].map(item => `<li class="b-simple_episode__item${String(list) === season && String(item) === episode ? ' active' : ''}" data-season_id="${list}" data-episode_id="${item}">Серия ${item}</li>`).join('')}</ul>`).join(''));
const reply = (route: Route, source: SourceDocument) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, source }) });
const failure = (route: Route, message: string) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: false, errorText: message }) });

async function mockSource(page: Page, handler?: (route: Route, query: SourceRequest) => Promise<boolean>) {
  const requests: SourceRequest[] = [], external: string[] = [];
  let favoriteSelected = false;
  const saved = { voice: '1', season: '1', episode: '1' };
  const membership = () => `<div id="user-favorites-holder" data-post_id="301"><div id="user-favorites-list"><div class="hd-label-row"><input class="user-fav-check" type="checkbox" value="7" ${favoriteSelected ? 'checked' : ''}><label>Смотреть позже<small>(<b>${favoriteSelected ? 1 : 0}</b>)</small></label></div></div></div>`;
  // Every remote resource is blocked, including accidentally introduced poster/CDN loads.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { external.push(url.origin); await route.abort('blockedbyclient'); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const body = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (body.method === 'getSettings') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } }) });
      return;
    }
    if (body.method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: true, origin, username: 'fixture-account' } } }); return; }
    if (body.method !== 'getSource') { await failure(route, 'Unexpected bridge request in source fixture'); return; }
    const query = body.params;
    requests.push(query);
    if (await handler?.(route, query)) return;
    let source: SourceDocument;
    switch (query.operation) {
      case 'catalog': source = { body: catalog(), url: origin + '/' }; break;
      case 'browse': source = { body: catalog(), url: origin + `/${query.type}/best/` }; break;
      case 'continue': source = { body: savedOnSource, url: origin + '/continue/' }; break;
      case 'search': source = { body: catalog(), url: origin + '/search/' }; break;
      case 'details': source = { body: savedDetails(saved.voice, saved.season, saved.episode) + '<table class="b-post__info"><tr><td>Рейтинги:</td><td><span class="imdb"><span>7.6</span><i>123</i></span></td></tr></table>' + catalog('Другой путь', '302') + membership(), url: titleUrl }; break;
      case 'favorites': source = { body: `<div class="b-favorites_content__cats_list_item" data-cat_id="7"><a class="b-favorites_content__cats_list_link active" href="/favorites/7/"><span class="name">Смотреть позже</span><span class="num-holder"><b>${favoriteSelected ? 1 : 0}</b></span></a></div><div class="b-favorites_content__holder">${favoriteSelected ? catalog() : '<div class="b-info__message">В этом разделе ничего нет</div>'}</div>`, url: origin + '/favorites/7/' }; break;
      case 'favoriteToggle': favoriteSelected = !favoriteSelected; source = { body: JSON.stringify({ success: true }), url: origin + '/ajax/favorites/' }; break;
      case 'favoriteCreate': throw new Error('Unexpected collection creation in playback fixture');
      case 'comments': throw new Error('Unexpected comments request before its tab opens');
      case 'person': throw new Error('Unexpected person request before opening a person');
      case 'ratings': source = { body: '<div class="b-content__bubble_title"><a href="' + titleUrl + '">' + titleName + '</a></div><div class="b-content__bubble_rates"><span class="imdb"><b>7.6</b></span></div>', url: origin + '/engine/ajax/quick_content.php' }; break;
      case 'episodes': source = { body: JSON.stringify({ success: true, episodes }), url: origin + '/ajax/get_cdn_series/' }; break;
      case 'streams': source = { body: JSON.stringify({ success: true, url: `[720p]${url.origin}/demo/sample.mp4`, subtitle: false }), url: origin + '/ajax/get_cdn_series/' }; break;
      case 'continueSave': Object.assign(saved, { voice: query.voice.id, season: query.season ?? '0', episode: query.episode ?? '0' }); source = { body: JSON.stringify({ success: true }), url: origin + '/ajax/send_save/?t=1' }; break;
      case 'thumbnails': source = { body: 'WEBVTT\n', url: query.url }; break;
    }
    await reply(route, source);
  });
  return { requests, external };
}

test('a title is chosen on its card, played, recorded in the account and resumed where this device stopped', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const mocked = await mockSource(page);
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toContainText(titleName);
  await expect(page.getByTestId('title-last-0').locator('.poster-rating')).toHaveAttribute('aria-label', 'Кинопоиск: 8.3');
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('details-play')).toBeEnabled();
  await expect(page.locator('.title-facts')).toContainText('КП8.3');
  await expect(page.locator('.title-facts')).toContainText('IMDb7.6');
  await expect(page.getByRole('heading', { name: 'Возможно, вас заинтересует', exact: true })).toBeVisible();
  await page.getByTestId('details-favorite').click();
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('favorite-membership-7').click();
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('favorite-panel-close').click();
  expect(mocked.requests.filter(request => request.operation === 'favoriteToggle')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rezzka.library.v1') || '{}').favorites ?? [])).toEqual([]);
  // The card shows the episodes that came with it and asks the source for nothing more until something is chosen.
  await expect(page.getByRole('heading', { name: 'Серии', exact: true })).toBeVisible();
  await expect(page.getByTestId('details-episode-1-1')).toContainText('Начнём отсюда');
  await expect(page.getByTestId('details-status')).toContainText('сезон 1, серия 1');
  expect(mocked.requests.filter(request => request.operation === 'episodes' || request.operation === 'streams' || request.operation === 'continueSave')).toEqual([]);
  // Another voice brings its own list of episodes; another episode starts straight from its tile.
  await page.getByTestId('details-voice').click();
  await page.getByTestId('details-voice-1').click();
  await expect(page.getByTestId('details-status')).toContainText('Вторая студия');
  expect(mocked.requests.filter(request => request.operation === 'episodes' && request.voice.id === '2')).toHaveLength(1);
  await page.getByTestId('details-season-2').click();
  await page.getByTestId('details-episode-2-2').click();
  const video = page.getByTestId('video');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.2);
  await expect(page.locator('.player-context')).toContainText('Сезон 2, серия 2');
  await expect(page.getByTestId('player-voice')).toContainText('Вторая студия');
  expect(mocked.requests.filter(request => request.operation === 'streams')).toEqual([expect.objectContaining({ operation: 'streams', id: '301', voice: expect.objectContaining({ id: '2' }), season: '2', episode: '2' })]);
  // The player needs no second read of the episodes the card already has.
  expect(mocked.requests.filter(request => request.operation === 'episodes')).toHaveLength(1);
  await expect.poll(() => mocked.requests.filter(request => request.operation === 'continueSave')).toEqual([{ operation: 'continueSave', id: '301', url: titleUrl, voice: expect.objectContaining({ id: '2' }), season: '2', episode: '2' }]);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  const stopped = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
  // Back first hides the controls when they are shown and then leaves the player; they hide on their own after a pause in input.
  for (let presses = 0; presses < 3 && await page.getByTestId('player').count(); presses++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await expect(page.getByTestId('player')).toHaveCount(0);
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.getByTestId('nav-library').click();
  await expect(page.getByTestId('history-91')).toContainText(titleName);
  await page.getByTestId('mine-tab-favorites').click();
  await expect(page.getByTestId('favorite-301')).toContainText(titleName);
  await page.reload();
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  // The account now holds the episode recorded from this device, so the title resumes it at the local position.
  await expect(page.getByTestId('continue-91')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('details-play')).toHaveText('Продолжить');
  await expect(page.getByTestId('details-status')).toContainText('Вы остановились: сезон 2, серия 2');
  await expect(page.getByTestId('details-status')).toContainText('Вторая студия');
  await expect(page.getByTestId('details-episode-2-2')).toContainText('Вы остановились здесь');
  await page.getByTestId('details-play').click();
  await expect(page.getByTestId('player')).toBeVisible();
  await expect(page.locator('.player-context')).toContainText('Сезон 2, серия 2');
  await expect.poll(() => page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(stopped - 0.5);
  expect(mocked.requests.filter(request => request.operation === 'streams').at(-1)).toMatchObject({ voice: { id: '2' }, season: '2', episode: '2' });
  expect(failures).toEqual([]);
  expect(mocked.external).toEqual([]);
});

test('late search cannot replace the current query and a failed search can be retried', async ({ page }) => {
  let stale: Route | undefined, retries = 0;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation !== 'search') return false;
    if (query.query === 'старый') { stale = route; return true; }
    if (query.query === 'ошибка' && retries++ === 0) { await failure(route, 'Тестовая ошибка поиска.'); return true; }
    await reply(route, { body: catalog(query.query === 'новый' ? 'Новый результат' : 'После повтора', '302'), url: origin + '/search/' });
    return true;
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-search').click();
  const query = page.getByTestId('search-query');
  await query.fill('старый');
  await expect.poll(() => Boolean(stale)).toBe(true);
  await query.fill('новый');
  await expect(page.getByTestId('search-result-0')).toContainText('Новый результат');
  const staleResponse = page.waitForResponse(response => response.url().endsWith('/__bridge') && response.request().postDataJSON()?.params?.query === 'старый');
  await reply(stale!, { body: catalog('Устаревший результат', '303'), url: origin + '/search/' });
  await (await staleResponse).finished();
  // Let the late fetch continuation and its React commit run before checking.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('search-result-0')).toContainText('Новый результат');
  await expect(query).toHaveValue('новый');
  await query.fill('ошибка');
  await expect(page.getByRole('alert')).toContainText('Тестовая ошибка поиска.');
  await page.getByTestId('search-retry').click();
  await expect(page.getByTestId('search-result-0')).toContainText('После повтора');
  await expect(page.getByTestId('search-retry')).toHaveCount(0);
  expect(mocked.external).toEqual([]);
});

test('a failed catalog row has a working retry without losing the other row', async ({ page }) => {
  let attempts = 0;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation === 'catalog' && query.sort === 'last' && attempts++ === 0) {
      await failure(route, 'Тестовая ошибка каталога.'); return true;
    }
    return false;
  });
  await page.goto('/');
  await expect(page.getByTestId('catalog-retry-last')).toBeVisible();
  await expect(page.getByTestId('title-popular-0')).toContainText(titleName);
  await page.getByTestId('catalog-retry-last').click();
  await expect(page.getByTestId('title-last-0')).toContainText(titleName);
  await expect(page.getByTestId('catalog-retry-last')).toHaveCount(0);
  expect(mocked.external).toEqual([]);
});
