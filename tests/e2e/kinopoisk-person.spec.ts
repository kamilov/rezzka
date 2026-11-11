import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { KinopoiskPersonQuery, KinopoiskResult } from '../../shared/kinopoisk';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://mirror.example';
const titleUrl = origin + '/films/drama/501-source-film.html';
const personUrl = origin + '/person/410-alexey/';
const firstFilmUrl = origin + '/films/drama/501-first.html';
const wrappedFilmUrl = '/help/' + Buffer.from(encodeURIComponent('https://www.kinopoisk.ru/film/326/')).toString('base64') + '/';
const movie = (name: string, extra = '') => `<div class="b-post__title"><h1>${name}</h1></div><div class="b-userset__fav_holder" data-post_id="501"></div><div class="b-post__description_text">Описание основного источника.</div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>${extra}`;
const parent = movie('Фильм источника', `<table class="b-post__info"><tr><td>Рейтинг:</td><td><span class="kp"><a href="${wrappedFilmUrl}">Кинопоиск</a><span>8.3</span><i>(999)</i></span></td></tr></table><div class="persons-list-holder"><span class="person-name-item" data-id="41" data-pid="501" data-job="Режиссёр"><a href="/person/410-alexey/"><span itemprop="name">Алексей Смирнов</span></a></span></div>`);
const catalog = `<div class="b-content__inline_item" data-id="501"><i class="b-category-bestrating">8.3</i><div class="b-content__inline_item-link"><a href="${titleUrl}">Фильм источника</a></div></div>`;
const matched = (long = false): KinopoiskResult => ({
  status: 'matched', person: {
    id: '66539', name: 'Имя в Кинопоиске', originalName: 'Alexey Smirnov', profileUrl: 'https://www.kinopoisk.ru/name/66539/',
    facts: [{ label: '<b>Награды</b>', value: '<strong>2</strong>' }, { label: 'Дата рождения', value: '1 февраля 1980' }],
    trivia: [
      '<b>Учился в театральной школе.</b><br>Первая роль — в студенческом спектакле.<script>window.kinopoiskFixtureExecuted=true;</script>',
      '<iframe src="https://outside.example/frame"></iframe><img src="https://outside.example/image.jpg" onerror="window.kinopoiskFixtureExecuted=true"><a href="javascript:alert(1)">Любимая книга</a>',
      ...(long ? Array.from({ length: 30 }, (_, index) => `Факт ${index + 1}: Подробности работы в театре, съёмок и творческого пути. Встречи с коллегами помогали находить новые образы и идеи для следующих проектов.`) : []),
      'Последний факт: продолжает работать в театре.',
    ],
  },
});

async function fixture(page: Page, options: { result?: KinopoiskResult; failures?: number; deferAttempt?: number } = {}) {
  const queries: KinopoiskPersonQuery[] = [], sourceReads: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  const person = (await readFile(new URL('../fixtures/provider/person.html', import.meta.url), 'utf8'))
    .replace(/(<div class="b-content__inline_item"[^>]*>)/g, '$1<i class="b-category-bestrating">8.3</i>');
  let failures = options.failures ?? 0, pending: Route | undefined;
  const reply = (route: Route) => route.fulfill({ json: { returnValue: true, kinopoisk: options.result ?? matched() } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === 'image' && ['images.example', 'mirror.example'].includes(url.hostname)) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#737a83"/><ellipse cx="100" cy="130" rx="58" ry="85" fill="#d1c0a8"/></svg>' }); return;
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON();
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (method === 'getKinopoiskPerson') {
      queries.push(params as KinopoiskPersonQuery);
      if (queries.length === options.deferAttempt) { pending = route; return; }
      if (failures-- > 0) { await route.fulfill({ json: { returnValue: false, errorCode: 'kinopoisk_unauthorized', errorText: 'Ключ Кинопоиска не принят. Проверьте настройки.' } }); return; }
      await reply(route); return;
    }
    expect(method).toBe('getSource');
    const query = params as SourceRequest; sourceReads.push(query);
    let body: string, documentUrl: string;
    if (query.operation === 'catalog' || query.operation === 'search') { body = catalog; documentUrl = origin + '/'; }
    else if (query.operation === 'details') { body = query.url === titleUrl ? parent : movie('Первый фильм'); documentUrl = query.url; }
    else if (query.operation === 'person') { expect(query.url).toBe(personUrl); body = person; documentUrl = query.url; }
    else if (query.operation === 'ratings') { body = '<div class="b-content__bubble_rates"><span class="imdb"><b>7.6</b></span></div>'; documentUrl = origin + '/engine/ajax/quick_content.php'; }
    else throw new Error(`Unexpected source operation: ${query.operation}`);
    await route.fulfill({ json: { returnValue: true, source: { url: documentUrl, body } } });
  });
  await page.goto('/'); await page.getByTestId('title-last-0').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
  expect(queries).toHaveLength(0);
  await page.getByTestId('details-person-0').focus();
  await expect(page.getByTestId('details-person-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('person-1-back')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('person-1-title-0-0')).toBeAttached();
  await expect.poll(() => queries.length).toBe(1);
  return {
    queries, sourceReads, errors, external,
    release: async () => { expect(pending).toBeDefined(); await reply(pending!); pending = undefined; },
  };
}

for (const theme of ['dark', 'light'] as const) {
  test(`Kinopoisk supplements source people with safe readable facts and preserves filmography in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('rezzka.theme', value), theme);
    const mocked = await fixture(page, { result: matched(true) });
    expect(mocked.queries).toEqual([{ name: 'Алексей Смирнов', originalName: 'Alexey Smirnov', filmId: '326', profession: 'Режиссёр', birthDate: '1980-02-01' }]);
    const screen = page.getByTestId('person-1-screen'), toggle = page.getByTestId('person-1-kinopoisk-toggle'), content = page.getByTestId('person-1-kinopoisk-content');
    await expect(screen.getByRole('heading', { name: 'Алексей Смирнов', exact: true })).toBeVisible();
    await expect(screen.locator('.poster-button')).toHaveCount(3);
    await expect(content).toHaveCount(0);
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(content).toHaveAttribute('data-focused', 'true');
    await expect(content).toContainText('Награды2');
    await expect(content).toContainText('Учился в театральной школе. Первая роль — в студенческом спектакле.');
    await expect(content).toContainText('Любимая книга');
    await expect(content).not.toContainText('kinopoiskFixtureExecuted');
    await expect(content.locator('script, style, iframe, img, a, object, video')).toHaveCount(0);
    expect(await page.evaluate(() => 'kinopoiskFixtureExecuted' in window)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`kinopoisk-person-${theme}.png`) });

    const main = page.locator('main'), start = await main.evaluate(element => element.scrollTop);
    const last = content.locator('.person-trivia li').last();
    await expect(last).not.toBeInViewport();
    await page.keyboard.press('ArrowDown');
    expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(start);
    for (let step = 0; step < 20; step++) {
      const visible = await last.evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      if (visible) break;
      await page.keyboard.press('ArrowDown');
      await expect(content).toHaveAttribute('data-focused', 'true');
    }
    await expect(last).toBeInViewport({ ratio: 1 });
    expect(await content.evaluate(element => element.scrollTop)).toBe(0);
    for (let step = 0; step < 20 && await toggle.getAttribute('data-focused') !== 'true'; step++) await page.keyboard.press('ArrowUp');
    await expect(toggle).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Enter'); await expect(content).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('person-1-title-0-0').focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
    expect(mocked.sourceReads.filter(request => request.operation === 'details').at(-1)).toEqual({ operation: 'details', url: firstFilmUrl });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('person-1-title-0-0')).toHaveAttribute('data-focused', 'true');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(mocked.queries).toHaveLength(1);
    expect(mocked.sourceReads.filter(request => request.operation === 'person')).toHaveLength(1);
    expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
  });
}

test('quickly closing the metadata panel cancels its pending focus transfer', async ({ page }) => {
  await fixture(page);
  const toggle = page.getByTestId('person-1-kinopoisk-toggle');
  await expect(toggle).toBeVisible();
  await page.clock.install(); await toggle.focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.clock.runFor(100);
  await expect(page.getByTestId('person-1-kinopoisk-content')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('data-focused', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

for (const status of ['disabled', 'unmatched', 'ambiguous'] as const) {
  test(`Kinopoisk ${status} keeps the source profile and playable films available`, async ({ page }) => {
    const mocked = await fixture(page, { result: { status } });
    const screen = page.getByTestId('person-1-screen');
    await expect(screen).toContainText('Москва, Россия');
    await expect(screen.locator('.poster-button')).toHaveCount(3);
    await expect(page.getByTestId('person-1-kinopoisk-toggle')).toHaveCount(0);
    if (status === 'disabled') await expect(page.getByTestId('person-1-kinopoisk')).toHaveCount(0);
    else await expect(page.getByTestId('person-1-kinopoisk')).toContainText('Не удалось однозначно сопоставить персону');
    await expect(screen.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('person-1-back')).toHaveAttribute('data-focused', 'true');
    expect(mocked.queries).toHaveLength(1);
    expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
  });
}

test('Kinopoisk errors stay separate from source login and retry restores focus to the metadata control', async ({ page }) => {
  const mocked = await fixture(page, { failures: 1 });
  await expect(page.getByTestId('person-1-kinopoisk').getByRole('alert')).toContainText('Ключ Кинопоиска не принят');
  await expect(page.getByTestId('screen-access')).toHaveCount(0);
  await expect(page.getByTestId('person-1-screen').locator('.poster-button')).toHaveCount(3);
  await page.getByTestId('person-1-kinopoisk-retry').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('person-1-kinopoisk-toggle')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('person-1-kinopoisk').getByRole('alert')).toHaveCount(0);
  expect(mocked.queries).toHaveLength(2); expect(mocked.queries[1]).toEqual(mocked.queries[0]);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a late Kinopoisk retry cannot replace another page or move focus out of its input', async ({ page }) => {
  const mocked = await fixture(page, { failures: 1, deferAttempt: 2 });
  await page.getByTestId('person-1-kinopoisk-retry').focus(); await page.keyboard.press('Enter');
  await expect.poll(() => mocked.queries.length).toBe(2);
  await page.clock.install();
  await page.getByTestId('nav-search').click(); await page.mouse.move(1919, 0); await page.clock.runFor(100);
  const query = page.getByTestId('search-query'); await query.fill('Новый поиск'); await expect(query).toBeFocused();
  await mocked.release(); await page.clock.runFor(200);
  await expect(page.getByTestId('screen-search')).toBeVisible();
  await expect(query).toBeFocused(); await expect(query).toHaveValue('Новый поиск');
  await expect(page.getByTestId('person-1-screen')).toHaveCount(0);
  expect(mocked.queries).toHaveLength(2);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
