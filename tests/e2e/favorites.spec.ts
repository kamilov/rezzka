import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceDocument, SourceRequest } from '../../shared/source';

const origin = 'https://favorites.fixture.example';
type ListRequest = Extract<SourceRequest, { operation: 'favorites' }>;
const range = (start: number, count = 15) => Array.from({ length: count }, (_, index) => start + index);
const titleUrl = (id: number) => `${origin}/films/drama/${id}-fixture.html`;
const cards = (ids: number[]) => ids.map(id => `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="${titleUrl(id)}">Фильм ${id}</a><div>2024, драма</div></div></div>`).join('');
const reply = (route: Route, source: SourceDocument) => route.fulfill({ json: { returnValue: true, source } });
function listing(query: ListRequest, ids: number[], nextPage?: number, count = ids.length): SourceDocument {
  const selected = query.collectionId ?? '11';
  const collections = ['11', '22'].map(id => `<li class="b-favorites_content__cats_list_item" data-cat_id="${id}"><a class="b-favorites_content__cats_list_link ${selected === id ? 'active' : ''}" href="/favorites/${id}/"><span class="name">${id === '11' ? 'Любимые фильмы' : 'Посмотреть позже'}</span><span class="num-holder"><b>${count}</b></span></a></li>`).join('');
  const content = ids.length ? cards(ids) : '<div class="b-info__message">На данной странице ваших закладок нет, вернитесь на предыдущие страницы.</div>';
  return { url: origin + `/favorites/${query.collectionId ? selected + '/' : ''}${query.page > 1 ? 'page/' + query.page + '/' : ''}?filter=added`, body: `<ul>${collections}</ul><div class="b-favorites_content__holder">${content}</div>${nextPage ? `<div class="b-navigation"><a href="/favorites/${selected}/page/${nextPage}/?filter=added">${nextPage}</a></div>` : ''}` };
}
function detail(id: number, selected = true): SourceDocument {
  return { url: titleUrl(id), body: `<div class="b-post__title"><h1>Фильм ${id}</h1></div><div class="b-userset__fav_holder" data-post_id="${id}"></div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div><div id="user-favorites-holder" data-post_id="${id}"><div id="user-favorites-list"><div class="hd-label-row"><label><input type="checkbox" class="user-fav-check" value="11" ${selected ? 'checked' : ''}><b>Любимые фильмы</b></label></div><div class="hd-label-row"><label><input type="checkbox" class="user-fav-check" value="22"><b>Посмотреть позже</b></label></div></div></div>` };
}
async function fixture(page: Page, handler: (route: Route, query: SourceRequest) => Promise<void>, authenticated = true) {
  const requests: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  const local = { favorites: [{ id: '999', url: titleUrl(999), title: 'Только локальный', poster: '', kind: 'film' }], history: [] };
  await page.addInitScript(value => localStorage.setItem('rezzka.library.v1', JSON.stringify(value)), local);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON();
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated, origin } } }); return; }
    if (method !== 'getSource') { await route.fulfill({ json: { returnValue: false, errorText: 'Unexpected method' } }); return; }
    if (params.operation !== 'continue') requests.push(params);
    if (params.operation === 'catalog') { await reply(route, { url: origin + '/', body: cards([100]) }); return; }
    // The home screen and «Моё» also read the account's saved titles; these scenarios are about favorites only.
    if (params.operation === 'continue') { await reply(route, { url: origin + '/continue/', body: '<div id="videosaves-list" class="b-videosaves__list"><p>Вы ещё ничего не сохраняли.</p></div>' }); return; }
    if (params.operation === 'ratings') { await reply(route, { url: origin + '/engine/ajax/quick_content.php', body: `<div class="b-content__bubble_title"><a href="${params.url}">Фильм</a></div><div class="b-content__bubble_rates"></div>` }); return; }
    await handler(route, params);
  });
  await page.goto('/'); await expect(page.getByTestId('title-last-0')).toBeVisible();
  return { requests, errors, external, local };
}
async function enter(page: Page) {
  await page.getByTestId('nav-library').click();
  await page.getByTestId('mine-tab-favorites').click(); await page.mouse.move(1919, 0);
}

test('favorites load account collections, ignore a late collection page and stay outside hidden navigation', async ({ page }) => {
  let pending: { route: Route; query: ListRequest } | undefined;
  const mocked = await fixture(page, async (route, query) => {
    if (query.operation !== 'favorites') throw new Error('Unexpected source operation');
    if (query.collectionId === '11' && query.page === 2) { pending = { route, query }; return; }
    await reply(route, listing(query, range(query.collectionId === '22' ? 200 : 100), query.collectionId === '22' ? undefined : 2));
  });
  await enter(page);
  await expect(page.getByTestId('favorite-100')).toBeVisible();
  await expect(page.getByTestId('favorite-999')).toHaveCount(0);
  await expect(page.getByTestId('favorites-collection-11')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('favorite-113').focus(); await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('favorite-114').focus();
  expect(mocked.requests.filter(query => query.operation === 'favorites' && query.page === 2)).toHaveLength(1);
  await page.getByTestId('favorites-collection-22').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-200')).toBeVisible();
  await reply(pending!.route, listing(pending!.query, range(115)));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('favorite-115')).toHaveCount(0);
  await expect(page.getByTestId('favorites-collection-22')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('nav-catalog').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-200')).toBeHidden();
  await page.getByTestId('nav-catalog').focus(); await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('nav-catalog')).toHaveAttribute('data-focused', 'true');
  expect(mocked.external).toEqual([]); expect(mocked.errors).toEqual([]);
});

test('favorites retry only the failed next page and append unique cards without a manual more button', async ({ page }) => {
  let attempts = 0;
  const mocked = await fixture(page, async (route, query) => {
    if (query.operation !== 'favorites') throw new Error('Unexpected source operation');
    if (query.page === 1) { await reply(route, listing(query, range(100), 2)); return; }
    if (attempts++ === 0) { await route.fulfill({ json: { returnValue: false, errorText: 'Ошибка второй страницы' } }); return; }
    await reply(route, listing(query, [114, ...range(115)]));
  });
  await enter(page); await expect(page.getByTestId('favorite-100')).toBeVisible();
  await page.getByTestId('favorite-113').focus();
  await expect(page.getByRole('alert')).toContainText('Ошибка второй страницы');
  await expect(page.locator('.favorites-screen .poster-button')).toHaveCount(15);
  await page.getByTestId('favorites-retry').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.favorites-screen .poster-button')).toHaveCount(30);
  await expect(page.getByTestId('favorite-115')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByRole('button', { name: /Показать ещё/ })).toHaveCount(0);
  expect(mocked.requests.filter(query => query.operation === 'favorites').map(query => query.page)).toEqual([1, 2, 2]);
  expect(mocked.external).toEqual([]); expect(mocked.errors).toEqual([]);
});

test('removing a title on a later favorites page refreshes loaded pages and restores visible focus', async ({ page }) => {
  let selected = true;
  const mocked = await fixture(page, async (route, query) => {
    if (query.operation === 'favorites') { await reply(route, listing(query, query.page === 1 ? range(100) : selected ? range(115) : range(116, 14), query.page === 1 ? 2 : undefined, selected ? 30 : 29)); return; }
    if (query.operation === 'details') { await reply(route, detail(115, selected)); return; }
    if (query.operation === 'favoriteToggle') { selected = !selected; await reply(route, { url: origin + '/ajax/favorites/', body: '{"success":true}' }); return; }
    throw new Error('Unexpected source operation');
  });
  await enter(page); await expect(page.getByTestId('favorite-100')).toBeVisible();
  await page.getByTestId('favorite-113').focus(); await expect(page.getByTestId('favorite-115')).toBeAttached();
  await page.getByTestId('favorite-115').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.getByTestId('details-favorite').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('favorite-membership-11')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('favorite-membership-11').click();
  await expect(page.getByTestId('favorite-membership-11')).toHaveAttribute('aria-checked', 'false');
  await page.mouse.move(1919, 0);
  await page.getByTestId('favorite-panel-close').focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-115')).toHaveCount(0);
  await expect(page.locator('.favorites-screen .poster-button')).toHaveCount(29);
  await expect(page.locator('[data-focused="true"]')).toHaveCount(1);
  await expect(page.locator('[data-focused="true"]')).toBeVisible();
  await expect(page.getByTestId('favorites-collection-11')).toContainText('29');
  expect(mocked.requests.filter(query => query.operation === 'favoriteToggle')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rezzka.library.v1')!))).toEqual(mocked.local);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('reloading collections after a deleted collection returns to a valid account list and focus', async ({ page }) => {
  const mocked = await fixture(page, async (route, query) => {
    if (query.operation !== 'favorites') throw new Error('Unexpected source operation');
    if (query.collectionId === '22') { await route.fulfill({ json: { returnValue: false, errorText: 'Коллекция удалена на сайте' } }); return; }
    await reply(route, listing(query, range(100)));
  });
  await enter(page); await expect(page.getByTestId('favorite-100')).toBeVisible();
  await page.getByTestId('favorites-collection-22').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Коллекция удалена на сайте');
  await page.getByTestId('favorites-reload').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-100')).toBeVisible();
  await expect(page.getByTestId('favorite-100')).toHaveAttribute('data-focused', 'true');
  expect(mocked.requests.filter(query => query.operation === 'favorites').map(query => query.collectionId)).toEqual([undefined, '22', undefined]);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('changing the catalog type preserves an uncertain creation and never replays its POST', async ({ page }) => {
  const mocked = await fixture(page, async (route, query) => {
    if (query.operation === 'details') { await reply(route, detail(100, false)); return; }
    if (query.operation === 'favoriteCreate') {
      await route.fulfill({ json: { returnValue: false, errorCode: 'source_mutation_unconfirmed', errorText: 'Ответ на создание списка потерян.' } }); return;
    }
    throw new Error('Unexpected source operation');
  });
  const attemptCreation = async () => {
    await page.getByTestId('title-last-0').click();
    await expect(page.getByTestId('details-play')).toBeVisible();
    await page.getByTestId('details-favorite').click();
    await page.getByTestId('favorite-create-open').click();
    await page.getByTestId('favorite-create-name').fill('На выходные');
    await page.getByTestId('favorite-create-submit').click();
    await expect(page.getByTestId('favorite-panel-reload')).toBeVisible();
  };
  await attemptCreation();
  await expect(page.getByRole('alert')).toContainText('Создание списка не подтверждено источником.');
  expect(mocked.requests.filter(query => query.operation === 'favoriteCreate')).toHaveLength(1);
  await page.getByTestId('favorite-panel-close').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('filter-2').click();
  await expect(page.getByTestId('filter-2')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => mocked.requests.filter(query => query.operation === 'catalog' && query.type === '2').length).toBe(2);
  await attemptCreation();
  await expect(page.getByRole('alert')).toContainText('Предыдущее создание этого списка ещё не подтверждено.');
  expect(mocked.requests.filter(query => query.operation === 'favoriteCreate')).toHaveLength(1);
  expect(mocked.requests.at(-1)?.operation).toBe('details');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('signed out favorites do not substitute local entries and login cancellation restores its button', async ({ page }) => {
  const mocked = await fixture(page, async () => { throw new Error('Unexpected source request'); }, false);
  await page.clock.install(); await enter(page); await page.clock.runFor(100);
  await expect(page.getByTestId('favorites-signin')).toBeVisible();
  await expect(page.locator('.favorites-screen .poster-button')).toHaveCount(0);
  await page.getByTestId('favorites-signin').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await page.keyboard.press('Escape'); await page.clock.runFor(100);
  await expect(page.getByTestId('favorites-signin')).toHaveAttribute('data-focused', 'true');
  expect(mocked.requests.every(query => query.operation === 'catalog' || query.operation === 'ratings')).toBe(true);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
