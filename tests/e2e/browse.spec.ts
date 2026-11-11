import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { BrowseType, SourceDocument, SourceRequest } from '../../shared/source';

const origin = 'https://browse.fixture.example';
type BrowseRequest = Extract<SourceRequest, { operation: 'browse' }>;
const range = (first: number, count = 15) => Array.from({ length: count }, (_, index) => first + index);
const reply = (route: Route, source: SourceDocument) => route.fulfill({ json: { returnValue: true, source } });
const failure = (route: Route, errorText: string) => route.fulfill({ json: { returnValue: false, errorText } });
const options = (type: BrowseType) => `<li class="b-topnav__item"><a class="b-topnav__item-link" href="/${type}/">${type}</a><select class="select-category"><option value="/${type}/best/">любого жанра</option><option value="/${type}/best/${type === 'films' ? 'drama' : 'thriller'}/">${type === 'films' ? 'Драмы' : 'Триллеры'}</option><option value="https://foreign.invalid/${type}/best/unsafe/">Чужой жанр</option></select><select class="select-year"><option value="0">за все время</option><option value="2027">2027</option><option value="2024">2024</option><option value="../../">Некорректный год</option></select></li>`;
const navigation = ['films', 'series', 'cartoons', 'animation'].map(type => options(type as BrowseType)).join('');
const browseUrl = (query: BrowseRequest, page = query.page) => `${origin}/${query.type}/best/${query.genre ? query.genre + '/' : ''}${query.year ? query.year + '/' : ''}${page > 1 ? 'page/' + page + '/' : ''}`;
const cards = (ids: number[], prefix: string) => ids.map(id => `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="/films/drama/${id}-fixture.html">${prefix} ${id}</a><div>2024, Россия, драма</div></div></div>`).join('');
function browseDocument(query: BrowseRequest, ids = range(600), nextPage?: number): SourceDocument {
  const body = navigation + (ids.length ? `<div class="b-content__inline_items">${cards(ids, `${query.type} ${query.genre || 'all'} ${query.year || 'all'}`)}</div>` : '<div class="b-info__message">Ничего не найдено</div>');
  return { url: browseUrl(query), body: body + (nextPage ? `<div class="b-navigation"><a href="${browseUrl(query, nextPage)}">${nextPage}</a></div>` : '') };
}
async function fixture(page: Page, handler?: (route: Route, query: BrowseRequest) => Promise<boolean>, mirror = origin) {
  const requests: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const request = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (request.method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: mirror } } } }); return; }
    if (request.method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (request.method !== 'getSource') { await failure(route, 'Unexpected bridge method'); return; }
    const query = request.params; requests.push(query);
    if (query.operation === 'browse') {
      if (await handler?.(route, query)) return;
      await reply(route, browseDocument(query)); return;
    }
    if (query.operation === 'details') { await reply(route, { url: query.url, body: '<div class="b-post__title"><h1>Описание из каталога</h1></div><div class="b-post__description_text">Проверка возврата в каталог.</div>' }); return; }
    if (query.operation === 'catalog') { await reply(route, { url: origin + '/', body: `<div class="b-content__inline_items">${cards([500], 'Главная')}</div>` }); return; }
    await failure(route, 'Unexpected source operation');
  });
  await page.goto('/');
  return { requests, errors, external };
}

test('dedicated catalog uses source filters and keeps its selection and focus after details', async ({ page }) => {
  const mocked = await fixture(page);
  await expect(page.getByTestId('title-last-0')).toContainText('Главная');
  expect(mocked.requests.filter(query => query.operation === 'browse')).toHaveLength(0);
  await page.getByTestId('nav-browse').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('films all all');
  await page.getByTestId('browse-genre').click();
  await expect(page.getByTestId('browse-genre-option-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByRole('button', { name: 'Чужой жанр', exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('browse-filter-dialog').locator('[data-focused="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browse-filter-dialog')).toHaveCount(0);
  await expect(page.getByTestId('browse-genre')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('nav-browse')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('browse-genre').click();
  await page.getByTestId('browse-genre-option-1').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('films drama all');
  await page.getByTestId('browse-year').click();
  await expect(page.getByRole('button', { name: 'Некорректный год', exact: true })).toHaveCount(0);
  await page.getByTestId('browse-year-option-2').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('films drama 2024');
  const count = mocked.requests.filter(query => query.operation === 'browse').length;
  await page.getByTestId('browse-title-7').click();
  await expect(page.getByTestId('details-favorite')).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browse-title-7')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('browse-genre')).toContainText('Драмы');
  await expect(page.getByTestId('browse-year')).toContainText('2024');
  expect(mocked.requests.filter(query => query.operation === 'browse')).toHaveLength(count);
  await page.getByTestId('browse-type-series').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('series all all');
  expect(mocked.requests.filter(query => query.operation === 'browse').at(-1)).toEqual({ operation: 'browse', type: 'series', genre: '', year: '', page: 1 });
  await page.getByTestId('browse-genre').click();
  await expect(page.getByTestId('browse-genre-option-1')).toContainText('Триллеры');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('catalog pagination retries its failed page once, appends unique titles and keeps the filters', async ({ page }) => {
  let pending: { route: Route; query: BrowseRequest } | undefined, attempts = 0;
  const mocked = await fixture(page, async (route, query) => {
    if (query.page === 1) { await reply(route, browseDocument(query, range(600), query.year ? 2 : undefined)); return true; }
    if (attempts++ === 0) { pending = { route, query }; return true; }
    await reply(route, browseDocument(query, [614, ...range(615)])); return true;
  });
  await page.getByTestId('nav-browse').click();
  await expect(page.getByTestId('browse-title-0')).toBeVisible();
  await page.getByTestId('browse-year').click();
  await page.getByTestId('browse-year-option-2').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('2024');
  await page.mouse.move(1919, 0);
  await page.getByTestId('browse-title-13').focus();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('browse-title-14').focus();
  expect(mocked.requests.filter(query => query.operation === 'browse' && query.page === 2)).toHaveLength(1);
  await failure(pending!.route, 'Тестовая ошибка второй страницы.');
  await expect(page.getByRole('alert')).toContainText('Тестовая ошибка второй страницы.');
  await expect(page.locator('[data-testid^="browse-title-"]')).toHaveCount(15);
  await page.getByTestId('browse-retry').focus();
  await expect(page.getByTestId('browse-retry')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid^="browse-title-"]')).toHaveCount(30);
  await expect(page.getByTestId('browse-title-15')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('browse-retry')).toHaveCount(0);
  await expect(page.getByTestId('browse-screen').locator('.load-more-trigger')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Показать ещё/ })).toHaveCount(0);
  expect(mocked.requests.filter(query => query.operation === 'browse' && query.page === 2)).toEqual([
    { operation: 'browse', type: 'films', genre: '', year: '2024', page: 2 },
    { operation: 'browse', type: 'films', genre: '', year: '2024', page: 2 },
  ]);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('late filter response cannot replace a newer type or its empty state', async ({ page }) => {
  let pending: { route: Route; query: BrowseRequest } | undefined;
  const mocked = await fixture(page, async (route, query) => {
    if (query.genre === 'drama') { pending = { route, query }; return true; }
    if (query.type === 'series') { await reply(route, browseDocument(query, [])); return true; }
    return false;
  });
  await page.getByTestId('nav-browse').click();
  await expect(page.getByTestId('browse-title-0')).toBeVisible();
  await page.getByTestId('browse-genre').click();
  await page.getByTestId('browse-genre-option-1').click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('browse-type-series').click();
  await expect(page.getByTestId('browse-screen')).toContainText('Для этих фильтров ничего не найдено.');
  const stale = page.waitForResponse(response => response.url().endsWith('/__bridge') && response.request().postDataJSON()?.params?.genre === 'drama');
  await reply(pending!.route, browseDocument(pending!.query));
  await (await stale).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('browse-type-series')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid^="browse-title-"]')).toHaveCount(0);
  await expect(page.getByTestId('browse-screen')).toContainText('Для этих фильтров ничего не найдено.');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('finishing a retry does not steal focus after the viewer moves away', async ({ page }) => {
  let pending: { route: Route; query: BrowseRequest } | undefined, attempts = 0;
  const mocked = await fixture(page, async (route, query) => {
    if (query.page === 1) { await reply(route, browseDocument(query, range(600), 2)); return true; }
    if (attempts++ === 0) { await failure(route, 'Ошибка загрузки страницы.'); return true; }
    pending = { route, query }; return true;
  });
  await page.getByTestId('nav-browse').click();
  await expect(page.getByTestId('browse-title-0')).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.getByTestId('browse-title-13').focus();
  await expect(page.getByTestId('browse-retry')).toBeVisible();
  await page.getByTestId('browse-retry').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('browse-type-films').focus();
  await reply(pending!.route, browseDocument(pending!.query, range(615)));
  await expect(page.locator('[data-testid^="browse-title-"]')).toHaveCount(30);
  // The component restores focus after 40 ms; verify beyond that scheduled callback.
  await page.waitForTimeout(80);
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('demo catalog makes no provider requests', async ({ page }) => {
  const mocked = await fixture(page, undefined, '');
  await page.getByTestId('demo-start').click();
  await page.getByTestId('nav-browse').click();
  await expect(page.getByTestId('browse-screen')).toContainText('Каталог источника с жанрами и годами откроется после выхода из деморежима.');
  expect(mocked.requests).toEqual([]);
  expect(mocked.errors).toEqual([]);
});
