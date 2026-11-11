import { expect, test, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

test('visible posters share compact rating requests and stop queued work when leaving the catalog', async ({ page }) => {
  const origin = 'https://ratings.fixture.example';
  const pending: Array<{ route: Route; id: string }> = [];
  const requests: string[] = [];
  const catalog = Array.from({ length: 16 }, (_, index) => {
    const id = String(index + 101);
    return `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="${origin}/films/${id}-film.html">Фильм ${id}</a></div></div>`;
  }).join('');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    expect(method).toBe('getSource');
    if (params.operation === 'ratings') { requests.push(params.id); pending.push({ route, id: params.id }); return; }
    expect(params.operation).toBe('catalog');
    await route.fulfill({ json: { returnValue: true, source: { body: catalog, url: origin + '/' } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await expect.poll(() => pending.length).toBe(2);
  expect(new Set(requests).size).toBe(2);
  const first = pending.shift()!;
  await first.route.fulfill({ json: { returnValue: true, source: { url: origin + '/engine/ajax/quick_content.php', body: `<div class="b-content__bubble_title"><a href="${origin}/films/${first.id}-film.html">Фильм</a></div><div class="b-content__bubble_rates"><span class="imdb"><b>7.9</b><i>12345</i></span></div>` } } });
  await expect(page.getByTestId(`title-last-${Number(first.id) - 101}`).locator('.poster-rating')).toHaveAttribute('aria-label', 'IMDb: 7.9');
  await expect.poll(() => pending.length).toBe(2);
  expect(requests.filter(id => id === first.id)).toHaveLength(1);
  // The remaining queue belongs to posters that are now removed from the screen.
  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('title-last-0')).toHaveCount(0);
  const count = requests.length;
  for (const { route, id } of pending.splice(0)) await route.fulfill({ json: { returnValue: true, source: { url: origin + '/engine/ajax/quick_content.php', body: `<div class="b-content__bubble_title"><a href="${origin}/films/${id}-film.html">Фильм</a></div>` } } });
  await page.getByTestId('nav-catalog').click();
  await expect(page.getByTestId(`title-last-${Number(first.id) - 101}`).locator('.poster-rating')).toHaveAttribute('aria-label', 'IMDb: 7.9');
  expect(requests.filter(id => id === first.id)).toHaveLength(1);
  expect(count).toBeLessThan(16);
});

test('rating failures and empty results are cached while previous sessions cannot replace fresh badges', async ({ page }) => {
  const origin = 'https://rating-sessions.fixture.example';
  const requests: string[] = [];
  let oldResponse: Route | undefined;
  let generation = 0;
  const catalog = ['201', '202', '203'].map(id => `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="${origin}/films/${id}-film.html">Фильм ${id}</a></div></div>`).join('');
  const response = (id: string, value?: string) => ({ returnValue: true, source: {
    url: origin + '/engine/ajax/quick_content.php',
    body: `<div class="b-content__bubble_title"><a href="${origin}/films/${id}-film.html">Фильм ${id}</a></div><div class="b-content__bubble_rates">${value ? `<span class="imdb"><b>${value}</b></span>` : ''}</div>`,
  } });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    expect(method).toBe('getSource');
    if (params.operation === 'ratings') {
      requests.push(`${generation}:${params.id}`);
      if (params.id === '201' && generation === 0) { oldResponse = route; return; }
      if (params.id === '202') { await route.abort('failed'); return; }
      await route.fulfill({ json: response(params.id, params.id === '201' ? '8.4' : undefined) }); return;
    }
    expect(params.operation).toBe('catalog');
    await route.fulfill({ json: { returnValue: true, source: { body: catalog, url: origin + '/' } } });
  });
  const settleIntersections = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const reopenCatalog = async () => {
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('title-last-0')).toHaveCount(0);
    await page.getByTestId('nav-catalog').click();
    await expect(page.getByTestId('title-last-0')).toBeVisible();
    await settleIntersections();
  };
  await page.goto('/');
  await expect.poll(() => requests.length).toBe(3);
  await reopenCatalog();
  expect([...requests].sort()).toEqual(['0:201', '0:202', '0:203']);
  await expect(page.locator('.poster-rating')).toHaveCount(0);

  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('title-last-0')).toHaveCount(0);
  generation = 1;
  await page.evaluate(async () => {
    const providerPath = '/src/provider.ts';
    const provider = await import(/* @vite-ignore */ providerPath);
    provider.resetProviderSession();
  });
  await page.getByTestId('nav-catalog').click();
  await expect(page.getByTestId('title-last-0').locator('.poster-rating')).toHaveAttribute('aria-label', 'IMDb: 8.4');
  await expect.poll(() => requests.length).toBe(6);
  await oldResponse!.fulfill({ json: response('201', '2.1') });
  await settleIntersections();
  await expect(page.getByTestId('title-last-0').locator('.poster-rating')).toHaveAttribute('aria-label', 'IMDb: 8.4');
  await expect(page.locator('[aria-label="IMDb: 2.1"]')).toHaveCount(0);
  await reopenCatalog();
  await expect(page.getByTestId('title-last-0').locator('.poster-rating')).toHaveAttribute('aria-label', 'IMDb: 8.4');
  expect([...requests].sort()).toEqual(['0:201', '0:202', '0:203', '1:201', '1:202', '1:203']);
  await expect(page.getByTestId('title-last-1').locator('.poster-rating')).toHaveCount(0);
  await expect(page.getByTestId('title-last-2').locator('.poster-rating')).toHaveCount(0);
});
