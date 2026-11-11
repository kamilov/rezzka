import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceDocument, SourceRequest } from '../../shared/source';

const origin = 'https://pagination.fixture.example';
type CatalogRequest = Extract<SourceRequest, { operation: 'catalog' }>;
type SearchRequest = Extract<SourceRequest, { operation: 'search' }>;
const range = (start: number, count = 8) => Array.from({ length: count }, (_, index) => start + index);
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const reply = (route: Route, source: SourceDocument) => route.fulfill({ json: { returnValue: true, source } });
const failure = (route: Route, errorText: string) => route.fulfill({ json: { returnValue: false, errorText } });

function sourceUrl(request: CatalogRequest | SearchRequest, page = request.page) {
  if (request.operation === 'search') {
    const params = new URLSearchParams({ do: 'search', subaction: 'search', q: request.query, page: String(page) });
    return `${origin}/search/?${params}`;
  }
  const params = new URLSearchParams({ filter: request.sort });
  if (request.type !== '0') params.set('genre', request.type);
  return `${origin}${page === 1 ? '/' : `/page/${page}/`}?${params}`;
}

function document(request: CatalogRequest | SearchRequest, ids: number[], nextPage?: number): SourceDocument {
  const prefix = request.operation === 'catalog' ? `Тип ${request.type} ${request.sort}` : request.query;
  const cards = ids.map(id => `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="/series/drama/${id}-fixture.html">${escape(prefix)} ${id}</a><div>2024, Россия, драма</div></div></div>`).join('');
  // Real provider markup is parsed in the browser; no pre-parsed page objects.
  const navigation = nextPage === undefined ? '' : `<div class="b-navigation"><span>${request.page}</span><a href="${escape(sourceUrl(request, nextPage))}">${nextPage}</a><a class="b-navigation__next i-sprt" href="${escape(sourceUrl(request, nextPage))}">→</a></div>`;
  return { url: sourceUrl(request), body: `<div class="b-content__inline_items">${cards}</div>${navigation}` };
}

async function mockSource(page: Page, handler: (route: Route, query: SourceRequest) => Promise<void>) {
  const requests: SourceRequest[] = [], external: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.origin); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const body = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (body.method === 'getSettings') {
      await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return;
    }
    if (body.method === 'getSourceSession') {
      await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return;
    }
    if (body.method !== 'getSource') { await failure(route, 'Unexpected bridge method in pagination fixture'); return; }
    requests.push(body.params);
    await handler(route, body.params);
  });
  return { requests, external, errors };
}

test('catalog appends unique pages once, preserves filters and finishes at the final page', async ({ page }) => {
  let pending: { route: Route; query: CatalogRequest } | undefined;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation !== 'catalog') { await failure(route, 'Unexpected source operation'); return; }
    const start = query.sort === 'last' ? 100 : 200;
    if (query.page === 1) { await reply(route, document(query, range(start), query.type === '2' ? 2 : undefined)); return; }
    if (query.sort === 'last' && query.page === 2) { pending = { route, query }; return; }
    await reply(route, document(query, query.page === 2 ? [start + 7, ...range(start + 8)] : [start + 15, start + 16, start + 17]));
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toContainText('Тип 0');
  await page.getByTestId('filter-2').click();
  await expect(page.getByTestId('title-last-0')).toContainText('Тип 2 last');
  await expect(page.getByTestId('title-popular-0')).toContainText('Тип 2 popular');
  // Park the pointer outside the moving rows while exercising remote focus.
  await page.mouse.move(1919, 0);

  await page.getByTestId('title-last-6').focus();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.locator('[data-testid^="title-last-"]')).toHaveCount(8);
  await expect(page.getByRole('button', { name: /Показать ещё/ })).toHaveCount(0);
  await page.getByTestId('title-last-7').focus();
  await expect(page.getByTestId('title-last-7')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('title-last-6').focus();
  await expect(page.getByTestId('title-last-6')).toHaveAttribute('data-focused', 'true');
  expect(mocked.requests.filter(request => request.operation === 'catalog' && request.sort === 'last' && request.page === 2)).toHaveLength(1);
  await reply(pending!.route, document(pending!.query, [107, ...range(108)], 3));
  await expect(page.locator('[data-testid^="title-last-"]')).toHaveCount(16);
  await expect(page.getByTestId('title-last-8')).toContainText('Тип 2 last 108');

  await expect(page.getByTestId('title-last-6')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('title-last-14').focus();
  await expect(page.locator('[data-testid^="title-last-"]')).toHaveCount(18);
  await expect(page.getByTestId('title-last-14')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('title-last-0').locator('..').locator('.load-more-trigger')).toHaveCount(0);

  await page.getByTestId('title-popular-6').focus();
  await expect(page.locator('[data-testid^="title-popular-"]')).toHaveCount(16);
  await expect(page.getByTestId('title-popular-6')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('title-popular-0').locator('..').locator('.load-more-trigger')).toHaveCount(0);
  const later = mocked.requests.filter(request => request.operation === 'catalog' && request.page > 1);
  expect(later).toEqual([
    { operation: 'catalog', sort: 'last', type: '2', page: 2 },
    { operation: 'catalog', sort: 'last', type: '2', page: 3 },
    { operation: 'catalog', sort: 'popular', type: '2', page: 2 },
  ]);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('catalog page failure retains existing cards and retries the failed page with useful focus', async ({ page }) => {
  let attempts = 0;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation !== 'catalog') { await failure(route, 'Unexpected source operation'); return; }
    if (query.sort === 'popular') { await reply(route, document(query, range(200))); return; }
    if (query.page === 1) { await reply(route, document(query, range(100), 2)); return; }
    if (attempts++ === 0) { await failure(route, 'Не удалось загрузить вторую страницу.'); return; }
    await reply(route, document(query, [107, ...range(108)]));
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.getByTestId('title-last-6').focus();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить вторую страницу.');
  await expect(page.locator('[data-testid^="title-last-"]')).toHaveCount(8);
  await expect(page.locator('[data-testid^="title-popular-"]')).toHaveCount(8);
  await page.getByTestId('catalog-retry-last').focus();
  await expect(page.getByTestId('catalog-retry-last')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid^="title-last-"]')).toHaveCount(16);
  await expect(page.getByTestId('title-last-8')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('catalog-retry-last')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Показать ещё/ })).toHaveCount(0);
  expect(mocked.requests.filter((request): request is CatalogRequest => request.operation === 'catalog' && request.sort === 'last').map(request => request.page)).toEqual([1, 2, 2]);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('search pagination ignores an old query response and retries page two without discarding page one', async ({ page }) => {
  let stale: { route: Route; query: SearchRequest } | undefined, attempts = 0;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation === 'catalog') { await reply(route, document(query, range(100))); return; }
    if (query.operation !== 'search') { await failure(route, 'Unexpected source operation'); return; }
    const start = query.query === 'старый' ? 300 : 400;
    if (query.page === 1) { await reply(route, document(query, range(start), 2)); return; }
    if (query.query === 'старый') { stale = { route, query }; return; }
    if (attempts++ === 0) { await failure(route, 'Повторите загрузку результатов.'); return; }
    await reply(route, document(query, [407, ...range(408)]));
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-search').click();
  await page.mouse.move(1919, 0);
  const input = page.getByTestId('search-query');
  await input.fill('старый');
  await expect(page.getByTestId('search-result-0')).toContainText('старый 300');
  await page.getByTestId('search-result-6').focus();
  await expect.poll(() => Boolean(stale)).toBe(true);
  await expect(page.locator('[data-testid^="search-result-"]')).toHaveCount(8);
  await input.fill('новый');
  await expect(page.getByTestId('search-result-0')).toContainText('новый 400');
  await page.getByTestId('search-result-6').focus();
  await expect(page.getByRole('alert')).toContainText('Повторите загрузку результатов.');
  await expect(page.locator('[data-testid^="search-result-"]')).toHaveCount(8);

  const staleResponse = page.waitForResponse(response => response.url().endsWith('/__bridge') && response.request().postDataJSON()?.params?.query === 'старый' && response.request().postDataJSON()?.params?.page === 2);
  await reply(stale!.route, document(stale!.query, range(308), 3));
  await (await staleResponse).finished();
  // Flush the fulfilled fetch continuation and React commit, without a timed sleep.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(input).toHaveValue('новый');
  await expect(page.getByTestId('search-result-0')).toContainText('новый 400');
  await expect(page.getByRole('alert')).toContainText('Повторите загрузку результатов.');
  await expect(page.locator('[data-testid^="search-result-"]')).toHaveCount(8);

  await page.getByTestId('search-retry').focus();
  await expect(page.getByTestId('search-retry')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid^="search-result-"]')).toHaveCount(16);
  await expect(page.getByTestId('search-result-8')).toContainText('новый 408');
  await expect(page.getByTestId('search-result-8')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByRole('button', { name: /Показать ещё/ })).toHaveCount(0);
  await expect(page.getByTestId('search-retry')).toHaveCount(0);
  expect(mocked.requests.filter((request): request is SearchRequest => request.operation === 'search' && request.query === 'новый').map(request => request.page)).toEqual([1, 2, 2]);
  expect(mocked.requests.filter((request): request is SearchRequest => request.operation === 'search' && request.query === 'старый').map(request => request.page)).toEqual([1, 2]);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('scroll loading waits for an offscreen row and then follows horizontal scrolling without focus', async ({ page }) => {
  // A short window keeps the second row beyond the prefetch margin of the first screen.
  await page.setViewportSize({ width: 1920, height: 220 });
  let pending: { route: Route; query: CatalogRequest } | undefined;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation !== 'catalog') { await failure(route, 'Unexpected source operation'); return; }
    if (query.sort === 'last') { await reply(route, document(query, range(100))); return; }
    if (query.page === 1) { await reply(route, document(query, range(200, 4), 2)); return; }
    if (query.page === 2) { pending = { route, query }; return; }
    await reply(route, document(query, range(212)));
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('title-popular-3')).toBeAttached();
  const popularRow = page.getByTestId('title-popular-0').locator('..');
  const position = await popularRow.evaluate(row => ({
    triggerTop: row.querySelector('.load-more-trigger')!.getBoundingClientRect().top,
    viewportBottom: window.document.querySelector('.main-content')!.getBoundingClientRect().bottom,
  }));
  // The short page's end fits horizontally, but the entire row is still below
  // the main viewport and its 240 px prefetch margin.
  expect(position.triggerTop).toBeGreaterThan(position.viewportBottom + 240);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(pending).toBeUndefined();
  expect(mocked.requests.filter(request => request.operation === 'catalog' && request.sort === 'popular')).toHaveLength(1);

  await popularRow.evaluate(row => row.scrollIntoView({ block: 'start' }));
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.locator('[data-testid^="title-popular-"]')).toHaveCount(4);
  await reply(pending!.route, document(pending!.query, range(204), 3));
  await expect(page.locator('[data-testid^="title-popular-"]')).toHaveCount(12);
  expect(await popularRow.evaluate(row => row.scrollWidth > row.clientWidth)).toBe(true);

  // Native scroll only: neither focus nor pointer movement requests this page.
  await popularRow.evaluate(row => { row.scrollLeft = row.scrollWidth; });
  await expect(page.locator('[data-testid^="title-popular-"]')).toHaveCount(20);
  await expect(popularRow.locator('.load-more-trigger')).toHaveCount(0);
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  expect(mocked.requests.filter((request): request is CatalogRequest => request.operation === 'catalog' && request.sort === 'popular').map(request => request.page)).toEqual([1, 2, 3]);
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});

test('a delayed automatic page load does not move focus away from another section', async ({ page }) => {
  let pending: { route: Route; query: CatalogRequest } | undefined;
  const mocked = await mockSource(page, async (route, query) => {
    if (query.operation !== 'catalog') { await failure(route, 'Unexpected source operation'); return; }
    if (query.page === 2) { pending = { route, query }; return; }
    await reply(route, document(query, range(query.sort === 'last' ? 100 : 200), query.sort === 'last' ? 2 : undefined));
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('title-last-6').focus();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('nav-library').click();
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('mine-screen')).toBeVisible();
  await page.clock.install();
  const response = page.waitForResponse(item => item.url().endsWith('/__bridge') && item.request().postDataJSON()?.params?.page === 2);
  await reply(pending!.route, document(pending!.query, range(108)));
  await (await response).finished();
  // Advance the delayed focus work after the response, without a wall-clock sleep.
  await page.clock.runFor(100);
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('mine-screen')).toBeVisible();
  expect(mocked.external).toEqual([]);
  expect(mocked.errors).toEqual([]);
});
