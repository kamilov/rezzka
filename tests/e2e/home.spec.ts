import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://home.fixture.example';
const films = [['601', 'Первый фильм'], ['602', 'Второй фильм'], ['603', 'Третий фильм'], ['604', 'Четвёртый фильм']];
const cards = films.map(([id, name]) => `<div class="b-content__inline_item" data-id="${id}"><i class="b-category-bestrating">8.${Number(id) % 10}</i><div class="b-content__inline_item-link"><a href="/films/drama/${id}-film.html">${name}</a><div>2026, Драма</div></div></div>`).join('');
// What the source lists as freshly released: the next episode of one saved series.
const updates = '<div class="b-seriesupdate__block"><div class="b-seriesupdate__block_date">Сегодня</div><ul class="b-seriesupdate__block_list">'
  + '<li class="b-seriesupdate__block_list_item"><div class="cell cell-1"><a class="b-seriesupdate__block_list_link" href="/series/fiction/301-route.html">Дальний путь</a> <span class="season">(2 сезон)</span></div><span class="cell cell-2">4 серия <i>(Студия А)</i></span></li>'
  + '<li class="b-seriesupdate__block_list_item"><div class="cell cell-1"><a class="b-seriesupdate__block_list_link" href="/series/drama/302-quiet.html">Тихий сериал</a> <span class="season">(1 сезон)</span></div><span class="cell cell-2">5 серия</span></li></ul></div>';
const saved = (id: string, href: string, name: string, info: string) => `<div id="videosave-${id}" class="b-videosaves__list_item"><div class="td date">Сегодня</div><div class="td title"><a href="${href}" data-cover_url="">${name}</a></div><div class="td info">${info}</div></div>`;
// The account lists entries by the time they were watched; none of the series with something new is first.
const account = '<div id="videosaves-list" class="b-videosaves__list">'
  + saved('91', '/films/drama/401-old.html', 'Старый фильм', 'Основная озвучка<span class="info-holder"><a href="/films/drama/401-old.html">Новая серия</a></span>')
  + saved('92', '/series/drama/302-quiet.html', 'Тихий сериал', 'Сезон 1, серия 5 <b>Студия</b>')
  + saved('93', '/series/fiction/301-route.html', 'Дальний путь', 'Сезон 2, серия 3 <b>Студия А</b>')
  + saved('94', '/series/drama/303-marked.html', 'Сериал без выхода', 'Сезон 1, серия 1 <b>Студия</b><span class="info-holder"><a href="/series/drama/303-marked.html">Новая серия</a></span>')
  + '</div>';
const brief = (id: string, name: string, text: string) => `<div class="b-content__bubble_title"><a href="/films/drama/${id}-film.html">${name}</a></div><div class="b-content__bubble_rates"><span class="imdb">IMDb: <b>7.6</b></span></div><div class="b-content__bubble_text">${text}</div>`;

async function fixture(page: Page, options: { authenticated?: boolean; intercept?: (route: Route, params: SourceRequest) => Promise<boolean> } = {}) {
  const requests: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: options.authenticated ?? false, origin, username: 'fixture-account' } } }); return; }
    expect(method).toBe('getSource'); requests.push(params);
    if (await options.intercept?.(route, params)) return;
    const reply = (body: string, at = origin + '/') => route.fulfill({ json: { returnValue: true, source: { url: at, body } } });
    if (params.operation === 'catalog') { await reply(cards + (params.sort === 'last' && params.page === 1 ? updates : '')); return; }
    if (params.operation === 'continue') { await reply(account, origin + '/continue/'); return; }
    if (params.operation === 'search') { await reply(cards); return; }
    if (params.operation === 'ratings') { await reply(brief(params.id, films.find(([id]) => id === params.id)?.[1] ?? '', `Краткое описание: ${params.id}.`), origin + '/engine/ajax/quick_content.php'); return; }
    if (params.operation === 'details') { await reply('<div class="b-post__title"><h1>Карточка</h1></div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>', params.url); return; }
    await route.fulfill({ json: { returnValue: false, errorText: 'Unexpected source request' } });
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.mouse.move(1919, 0);
  return { requests, errors, external, of: (operation: string) => requests.filter(request => request.operation === operation) };
}
const order = (page: Page, scope: string, prefix: string) => page.getByTestId(scope).locator(`[data-testid^="${prefix}"]`).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')));

test('only series with a released later episode come first and are marked, on the home row and in «Моё»', async ({ page }, testInfo) => {
  const mocked = await fixture(page, { authenticated: true });
  // First what has something new, in the account's order, then the rest in the account's order.
  await expect.poll(() => order(page, 'home-continue', 'continue-')).toEqual(['continue-93', 'continue-91', 'continue-92', 'continue-94']);
  await expect(page.getByTestId('continue-93')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('continue-93').locator('.card-badge')).toHaveText('Новая серия');
  // The words «Новая серия» beside a film or a series in the source's own list mark nothing: only a released episode does.
  for (const id of ['continue-91', 'continue-92', 'continue-94']) await expect(page.getByTestId(id).locator('.card-badge')).toHaveCount(0);
  // The released episode is named where the source's list of updates gives it.
  await expect(page.getByTestId('continue-93')).toHaveAccessibleName(/Дальний путь.*вышла новая серия: Сезон 2, серия 4/);
  await expect(page.getByTestId('spotlight-title')).toHaveText('Дальний путь');
  await expect(page.getByTestId('spotlight')).toContainText('новое: сезон 2, серия 4');
  // The episode the viewer has already reached is not news.
  await expect(page.getByTestId('continue-92')).toHaveAccessibleName(/Тихий сериал$/);
  await page.screenshot({ path: testInfo.outputPath('home-updates.png'), animations: 'disabled' });

  await page.getByTestId('nav-library').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => order(page, 'mine-screen', 'history-')).toEqual(['history-93', 'history-91', 'history-92', 'history-94']);
  await expect(page.getByTestId('history-93').locator('.card-badge')).toHaveText('Новая серия');
  await expect(page.getByTestId('history-93')).toContainText('Новое: сезон 2, серия 4');
  for (const id of ['history-91', 'history-92', 'history-94']) await expect(page.getByTestId(id).locator('.card-badge')).toHaveCount(0);
  await expect(page.getByTestId('history-92').locator('.card-badge')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('mine-updates.png'), animations: 'disabled' });
  // The list of updates comes with the first page of the catalog: nothing extra is asked for it.
  expect(mocked.of('catalog')).toHaveLength(2);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('the title under focus is described at the top once focus rests on it', async ({ page }, testInfo) => {
  let held: Route | undefined;
  const mocked = await fixture(page, { intercept: async (route, params) => { if (params.operation !== 'ratings' || params.id !== '603') return false; held = route; return true; } });
  const title = page.getByTestId('spotlight-title'), description = page.getByTestId('spotlight-description');
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await expect(title).toHaveText('Первый фильм');
  await expect(description).toHaveText('Краткое описание: 601.');
  await expect(page.getByTestId('spotlight')).toContainText('IMDb7.6');
  const row = (await page.getByTestId('title-last-0').boundingBox())!;
  await page.screenshot({ path: testInfo.outputPath('home-spotlight.png'), animations: 'disabled' });
  // Passing over a card asks nothing about it; the text of the previous card does not stay under a new name.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('title-last-2')).toHaveAttribute('data-focused', 'true');
  await expect(title).toHaveText('Третий фильм');
  await expect(description).toHaveText('');
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(description).toHaveText('');
  await held!.fulfill({ json: { returnValue: true, source: { url: origin + '/engine/ajax/quick_content.php', body: brief('603', 'Третий фильм', 'Краткое описание: 603.') } } });
  await expect(description).toHaveText('Краткое описание: 603.');
  expect(mocked.of('ratings').map(request => request.operation === 'ratings' && request.id)).toEqual(['601', '603']);
  // The description has its own place: rows below do not move when it arrives.
  expect((await page.getByTestId('title-last-2').boundingBox())!.y).toBeCloseTo(row.y, 0);
  // Returning to a card already described asks nothing again.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(description).toHaveText('Краткое описание: 601.');
  expect(mocked.of('ratings')).toHaveLength(2);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('queries that led to a title are offered again on the empty search page until history is cleared', async ({ page }) => {
  const mocked = await fixture(page);
  const open = async () => { await page.getByTestId('nav-search').focus(); await page.keyboard.press('Enter'); await expect(page.getByTestId('search-query')).toBeVisible(); };
  const find = async (text: string, visit: boolean) => {
    await page.getByTestId('search-query').fill(text);
    await expect(page.getByTestId('search-result-0')).toBeVisible();
    if (!visit) return;
    await page.getByTestId('search-result-0').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('search-result-0')).toHaveAttribute('data-focused', 'true');
  };
  await open();
  await expect(page.locator('.search-recent')).toHaveCount(0);
  await find('дальний путь', true);
  // A query that was only typed is not kept.
  await find('случайный набор', false);
  await find('северный ветер', true);
  await page.getByTestId('search-query').fill('');
  await expect(page.getByRole('heading', { name: 'Недавние запросы' })).toBeVisible();
  await expect(page.locator('.search-recent button')).toHaveText(['северный ветер', 'дальний путь']);

  await page.reload();
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.mouse.move(1919, 0);
  await open();
  await expect(page.locator('.search-recent button')).toHaveText(['северный ветер', 'дальний путь']);
  const before = mocked.of('search').length;
  await page.getByTestId('search-recent-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search-query')).toHaveValue('дальний путь');
  await expect(page.getByTestId('search-result-0')).toBeVisible();
  await expect(page.locator('.search-recent')).toHaveCount(0);
  expect(mocked.of('search').slice(before)).toEqual([expect.objectContaining({ operation: 'search', query: 'дальний путь' })]);

  // Clearing the history asks first and also forgets the queries.
  await page.getByTestId('nav-settings').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('settings-tab-playback').focus();
  await page.getByTestId('settings-clear-history').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-confirm-clear')).toBeVisible();
  // The question opens on «Отмена»: a stray OK must not delete anything.
  await expect(page.getByTestId('settings-confirm-clear-cancel')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-confirm-clear')).toHaveCount(0);
  await expect(page.getByTestId('settings-clear-history')).toHaveAttribute('data-focused', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rezzka.search.v1') ?? '[]'))).toHaveLength(2);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-confirm-clear-cancel')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('settings-confirm-clear-ok')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-confirm-clear')).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('История просмотра очищена.');
  await expect(page.getByTestId('settings-clear-history')).toHaveAttribute('data-focused', 'true');
  await open();
  await page.getByTestId('search-query').fill('');
  await expect(page.locator('.search-recent')).toHaveCount(0);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
