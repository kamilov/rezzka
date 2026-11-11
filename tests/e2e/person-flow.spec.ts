import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://mirror.example';
const parentUrl = origin + '/series/drama/501-synthetic.html';
const firstUrl = origin + '/films/drama/501-first.html';
const thirdUrl = origin + '/films/drama/503-third.html';
const alexeyUrl = origin + '/person/410-alexey/';
const sofiaUrl = origin + '/person/420-sofia/';
const reply = (route: Route, url: string, body: string) => route.fulfill({ json: { returnValue: true, source: { url, body } } });
const film = (title: string, id: string, people = '') => `<div class="b-post__title"><h1>${title}</h1></div><div class="b-userset__fav_holder" data-post_id="${id}"></div><div class="b-post__description_text">Описание фильма.</div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>${people}`;
const sofiaCard = '<div class="persons-list-holder"><span class="person-name-item" data-id="420" data-job="Актриса"><a href="/person/420-sofia/"><span itemprop="name">София Петрова</span></a></span></div>';
const catalog = (url: string, name: string, id = '501') => `<div class="b-content__inline_item" data-id="${id}"><i class="b-category-bestrating">8.3</i><div class="b-content__inline_item-link"><a href="${url}">${name}</a></div></div>`;

async function fixture(page: Page, options: { failFirst?: boolean; emptySofia?: boolean; deferAlexey?: boolean } = {}) {
  const requests: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  const parent = (await readFile(new URL('../fixtures/provider/details-extra.html', import.meta.url), 'utf8'))
    .replaceAll('/person/410-alexey.html', '/person/410-alexey/').replaceAll('/person/420-sofia.html', '/person/420-sofia/');
  const alexey = (await readFile(new URL('../fixtures/provider/person.html', import.meta.url), 'utf8'))
    .replace(/(<div class="b-content__inline_item"[^>]*>)/g, '$1<i class="b-category-bestrating">8.3</i>');
  const sofia = '<div class="b-post__title"><h1><span class="t1" itemprop="name">София Петрова</span><span class="t2">Sofia Petrova</span></h1></div>'
    + (options.emptySofia ? '' : `<div class="b-person__career"><h2>Актриса</h2>${catalog(thirdUrl, 'Третий фильм', '503')}</div>`);
  let failures = options.failFirst ? 1 : 0, pending: Route | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === 'image' && ['images.example', 'mirror.example'].includes(url.hostname)) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#737a83"/><ellipse cx="100" cy="130" rx="58" ry="85" fill="#d1c0a8"/><path d="M0 0h200v12H0zM0 288h200v12H0z" fill="#e6c27f"/></svg>' }); return;
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (method === 'getKinopoiskPerson') { await route.fulfill({ json: { returnValue: true, kinopoisk: { status: 'disabled' } } }); return; }
    expect(method).toBe('getSource'); requests.push(params);
    if (params.operation === 'catalog' || params.operation === 'search') { await reply(route, origin + '/', catalog(parentUrl, 'Синтетический сериал')); return; }
    if (params.operation === 'details') {
      const body = params.url === parentUrl ? parent : params.url === firstUrl ? film('Первый фильм', '501', sofiaCard) : film('Третий фильм', '503');
      await reply(route, params.url, body); return;
    }
    if (params.operation === 'person') {
      expect([alexeyUrl, sofiaUrl]).toContain(params.url);
      if (params.url === alexeyUrl && options.deferAlexey) { pending = route; return; }
      if (params.url === alexeyUrl && failures-- > 0) { await route.fulfill({ json: { returnValue: false, errorText: 'Страница персоны временно недоступна.' } }); return; }
      await reply(route, params.url, params.url === alexeyUrl ? alexey : sofia); return;
    }
    if (params.operation === 'ratings') {
      await reply(route, origin + '/engine/ajax/quick_content.php', '<div class="b-content__bubble_rates"><span class="imdb"><b>7.6</b></span></div>'); return;
    }
    throw new Error(`Unexpected source operation: ${params.operation}`);
  });
  await page.goto('/');
  await page.getByTestId('title-last-0').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
  return {
    requests, errors, external,
    personReads: (url: string) => requests.filter(request => request.operation === 'person' && request.url === url).length,
    release: async () => { expect(pending).toBeDefined(); await reply(pending!, alexeyUrl, alexey); },
  };
}

async function enterPeople(page: Page) {
  await page.getByTestId('details-person-0').focus();
  await expect(page.getByTestId('details-person-0')).toHaveAttribute('data-focused', 'true');
}

for (const theme of ['dark', 'light'] as const) {
  test(`person filmography and nested film visits preserve remote focus in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('rezzka.theme', value), theme);
    const mocked = await fixture(page);
    await enterPeople(page); await page.keyboard.press('Enter');
    await expect(page.getByTestId('person-1-back')).toHaveAttribute('data-focused', 'true');
    const alexey = page.getByTestId('person-1-screen');
    await expect(alexey.getByRole('heading', { name: 'Алексей Смирнов', exact: true })).toBeVisible();
    await expect(alexey).toContainText('Alexey Smirnov');
    await expect(alexey).toContainText('Москва, Россия');
    await expect(alexey).toContainText('1 февраля, 1980');
    await expect(alexey.getByRole('heading', { name: 'Актёр', exact: true })).toBeVisible();
    await expect(alexey.getByRole('heading', { name: 'Режиссёр', exact: true })).toBeAttached();
    await expect(alexey.locator('.poster-button')).toHaveCount(3);
    await expect(alexey).not.toContainText('Редактировать');
    await expect(alexey).not.toContainText('Посторонняя рекомендация');
    expect(await page.evaluate(() => 'personFixtureExecuted' in window)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`person-${theme}.png`) });

    await page.getByTestId('person-1-title-0-0').focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
    await expect(page.getByRole('heading', { name: 'Первый фильм', exact: true })).toBeVisible();
    await enterPeople(page); await page.keyboard.press('Enter');
    await expect(page.getByTestId('person-2-back')).toHaveAttribute('data-focused', 'true');
    await expect(page.getByTestId('person-2-screen')).toContainText('Sofia Petrova');
    await expect(page.getByTestId('person-1-screen')).toBeHidden();
    await page.getByTestId('person-2-title-0-0').focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
    await expect(page.getByRole('heading', { name: 'Третий фильм', exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('person-2-title-0-0')).toHaveAttribute('data-focused', 'true');
    expect(mocked.personReads(sofiaUrl)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('details-person-0')).toHaveAttribute('data-focused', 'true');
    await expect(page.getByRole('heading', { name: 'Первый фильм', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('person-1-title-0-0')).toHaveAttribute('data-focused', 'true');
    expect(mocked.personReads(alexeyUrl)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('details-person-0')).toHaveAttribute('data-focused', 'true');
    await expect(page.getByRole('heading', { name: 'Синтетический сериал', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
    expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
  });
}

test('person clicks support a failed request, retry and an explicitly empty filmography', async ({ page }) => {
  const mocked = await fixture(page, { failFirst: true, emptySofia: true });
  await enterPeople(page); await page.getByTestId('details-person-0').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('person-1-screen').getByRole('alert')).toContainText('Страница персоны временно недоступна.');
  await expect(page.getByTestId('person-1-screen')).not.toContainText('Источник пока не добавил фильмы');
  await page.getByTestId('person-1-retry').click(); await page.mouse.move(1919, 0);
  await expect(page.getByTestId('person-1-title-0-0')).toHaveAttribute('data-focused', 'true');
  expect(mocked.personReads(alexeyUrl)).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-person-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  const sofia = page.getByTestId('person-2-screen');
  await expect(sofia).toContainText('Источник пока не добавил фильмы с участием этой персоны.');
  await expect(sofia.getByRole('alert')).toHaveCount(0);
  await expect(sofia.locator('.poster-button')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-person-1')).toHaveAttribute('data-focused', 'true');
  expect(mocked.personReads(sofiaUrl)).toBe(1);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a late person response after leaving cannot replace the current page or steal its focus', async ({ page }) => {
  const mocked = await fixture(page, { deferAlexey: true });
  await enterPeople(page); await page.keyboard.press('Enter');
  await expect(page.getByTestId('person-1-back')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('person-1-screen').getByRole('status')).toContainText('Загружаем сведения');
  await page.clock.install();
  await page.getByTestId('nav-search').click(); await page.mouse.move(1919, 0); await page.clock.runFor(100);
  const query = page.getByTestId('search-query'); await query.fill('Будущий запрос');
  await expect(query).toBeFocused();
  await mocked.release(); await page.clock.runFor(200);
  await expect(page.getByTestId('screen-search')).toBeVisible();
  await expect(query).toBeFocused(); await expect(query).toHaveValue('Будущий запрос');
  await expect(page.getByTestId('person-1-screen')).toHaveCount(0);
  expect(mocked.personReads(alexeyUrl)).toBe(1);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
