import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://mirror.example';
const richUrl = origin + '/series/drama/501-synthetic.html';
const emptyUrl = origin + '/films/drama/501-synthetic.html';
const partUrl = origin + '/films/drama/701-prequel.html';
type Pair = [season: string, episode: string];
const episodeLists = (pairs: Pair[]) => [...new Set(pairs.map(([season]) => season))].map(season =>
  `<ul class="b-simple_episodes__list" id="simple-episodes-list-${season}">${pairs.filter(pair => pair[0] === season).map(([, episode]) =>
    `<li class="b-simple_episode__item" data-season_id="${season}" data-episode_id="${episode}">Серия ${episode}</li>`).join('')}</ul>`).join('');
// Replaces the single voice and episode of the shared fixture with the given ones.
const withVoices = (html: string, voices: string, pairs: Pair[]) => html.replace(/<div class="b-translator__item[\s\S]*?(?=<script>)/, voices + episodeLists(pairs));
const watched = (season: string, episode: string, voice = '8') => JSON.stringify({ favorites: [], history: [{
  title: { id: '501', url: richUrl, title: 'Синтетический сериал', poster: '', kind: 'series' }, voice: { id: voice, label: 'Студия А' },
  episode: { season, id: episode, title: `Серия ${episode}` }, position: 3, duration: 12, updatedAt: 300,
}] });

interface Options {
  minimal?: boolean;
  details?: (html: string) => string;
  /** Answers a source request itself and returns true, or leaves it to the fixture. */
  intercept?: (route: Route, params: SourceRequest, local: string) => Promise<boolean>;
  open?: boolean;
}
async function fixture(page: Page, options: Options = {}) {
  const requests: SourceRequest[] = [], errors: string[] = [], external: string[] = [];
  const details = (options.details ?? (html => html))(await readFile(new URL('../fixtures/provider/details-extra.html', import.meta.url), 'utf8'));
  let configured = true;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://images.example/people/41.jpg') {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="320"><rect width="200" height="320" fill="#646b76"/><ellipse cx="100" cy="145" rx="65" ry="100" fill="#c8b49a"/></svg>' }); return;
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: configured ? origin : '' } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    expect(method).toBe('getSource'); requests.push(params);
    if (await options.intercept?.(route, params, url.origin)) return;
    const reply = (body: string, at = origin + '/') => route.fulfill({ json: { returnValue: true, source: { url: at, body } } });
    if (params.operation === 'catalog') {
      await reply(`<div class="b-content__inline_item" data-id="501"><div class="b-content__inline_item-link"><a href="${options.minimal ? emptyUrl : richUrl}">Синтетическая карточка</a></div><i class="b-category-bestrating">8.3</i></div>`); return;
    }
    if (params.operation === 'details') {
      await reply(params.url === partUrl ? '<div class="b-post__title"><h1>Предыстория</h1></div><div class="b-post__description_text">Другая часть.</div>'
        : options.minimal ? '<div class="b-post__title"><h1>Без дополнительных сведений</h1></div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>' : details, params.url); return;
    }
    if (params.operation === 'comments') { await reply(JSON.stringify({ comments: '', navigation: '' }), `${origin}/ajax/get_comments/?news_id=${params.id}&cstart=${params.page}`); return; }
    if (params.operation === 'streams') { await reply(JSON.stringify({ success: true, url: `[720p]${url.origin}/demo/sample.mp4`, subtitle: false })); return; }
    await route.fulfill({ json: { returnValue: false, errorText: 'Unexpected source request' } });
  });
  await page.goto('/');
  // The page starts on what was watched here, if anything, otherwise on the first card.
  await expect(page.locator('main [data-focused="true"]')).toHaveCount(1);
  await page.mouse.move(1919, 0);
  await page.getByTestId('title-last-0').focus();
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  if (options.open !== false) {
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
  }
  return { requests, errors, external, disableSource: () => { configured = false; }, count: (operation: string) => requests.filter(request => request.operation === operation).length };
}
const onlyFocus = async (page: Page, id: string) => {
  await expect(page.getByTestId(id)).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('[data-focused="true"]')).toHaveCount(1);
};
const press = async (page: Page, ...keys: string[]) => { for (const key of keys) await page.keyboard.press(key); };

for (const theme of ['dark', 'light'] as const) {
  test(`the card shows what will play, the episodes, people and other parts on one page in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('rezzka.theme', value), theme);
    const mocked = await fixture(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.title-kind')).toContainText('Сериал · 2 сезона');
    await expect(page.getByRole('heading', { name: 'Синтетический сериал', exact: true })).toBeVisible();
    await expect(page.locator('.title-original')).toHaveText('Synthetic Series');
    const facts = page.locator('.title-facts');
    for (const text of ['КП8.3', 'IMDb7.6', 'Россия, Франция', 'Драма, Приключения', '45 мин.', '16+']) await expect(facts).toContainText(text);
    await expect(facts).not.toContainText('World Art');
    await expect(page.locator('.title-description')).toHaveText('Описание сериала.');
    await expect(page.getByTestId('details-status')).toContainText('Начнём с начала: сезон 2, серия 1 · Студия А');
    await expect(page.getByTestId('details-play')).toContainText('Смотреть');
    // One voice leaves nothing to choose.
    await expect(page.getByTestId('details-voice')).toHaveCount(0);
    expect(await page.evaluate(() => 'detailsFixtureExecuted' in window)).toBe(false);

    // Episodes: what can be played, what is announced and what this voice lacks.
    const episodes = page.getByTestId('details-episodes');
    await expect(page.getByTestId('details-season-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('details-episode-2-1')).toContainText('Серия 1');
    await expect(page.getByTestId('details-episode-2-1')).toContainText('Начало');
    await expect(page.getByTestId('details-episode-2-1')).toContainText('Начнём отсюда');
    await expect(page.getByTestId('details-episode-2-1')).toHaveAccessibleName('Сезон 2, серия 1, Начало, просмотрена');
    await expect(page.getByTestId('details-pending-2-2')).toContainText('Продолжение');
    await expect(page.getByTestId('details-pending-2-2')).toContainText('8 ноября 2026 · через 5 дней');
    await expect(episodes).not.toContainText('Служебная строка');
    await press(page, 'ArrowDown');
    await onlyFocus(page, 'details-season-2');
    await press(page, 'ArrowDown');
    await onlyFocus(page, 'details-episode-2-1');
    await page.screenshot({ path: testInfo.outputPath(`card-${theme}.png`), animations: 'disabled' });
    // An episode that is not available cannot take focus: Right stays on the last playable one.
    await press(page, 'ArrowRight');
    await onlyFocus(page, 'details-episode-2-1');
    await press(page, 'ArrowUp');
    await onlyFocus(page, 'details-season-2');
    // A season opens when its tab takes focus.
    await press(page, 'ArrowLeft');
    await onlyFocus(page, 'details-season-1');
    await expect(page.getByTestId('details-season-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('details-pending-1-1')).toContainText('Прошлое');
    await expect(page.getByTestId('details-pending-1-1')).toContainText('Нет в этой озвучке');
    await expect(page.getByTestId('details-episode-2-1')).toHaveCount(0);
    await press(page, 'ArrowRight', 'ArrowDown');
    await onlyFocus(page, 'details-episode-2-1');

    // People.
    await press(page, 'ArrowDown');
    await onlyFocus(page, 'details-person-0');
    const people = page.getByTestId('details-people-content');
    await expect(people.locator('.person-tile')).toHaveCount(3);
    await expect(page.getByTestId('details-person-0')).toHaveAccessibleName('Алексей Смирнов, Режиссёр');
    await expect(page.getByTestId('details-person-1')).toHaveAccessibleName('София Петрова, Актриса');
    await expect(people).not.toContainText('Посторонняя персона');
    const photo = page.getByTestId('details-person-0').locator('img');
    await expect.poll(() => photo.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalHeight)).toBe(320);
    await press(page, 'ArrowRight', 'ArrowRight');
    await onlyFocus(page, 'details-person-2');
    await press(page, 'ArrowRight');
    await onlyFocus(page, 'details-person-2');

    // Other parts: only the ones the source links to can be opened.
    await press(page, 'ArrowDown');
    await onlyFocus(page, 'details-franchise-0');
    await expect(page.getByTestId('details-franchise-0')).toContainText('Предыстория');
    await expect(page.getByTestId('details-franchise-0')).toContainText('КП 8.2');
    await expect(page.getByTestId('details-franchise-1')).toContainText('Вы здесь');
    await expect(page.getByTestId('details-franchise-2')).toContainText('Недоступна на источнике');
    await page.screenshot({ path: testInfo.outputPath(`card-${theme}-rows.png`), animations: 'disabled' });
    expect(mocked.requests.filter(request => ['episodes', 'streams', 'comments'].includes(request.operation))).toEqual([]);
    await press(page, 'Enter');
    await expect(page.getByRole('heading', { name: 'Предыстория', exact: true })).toBeVisible();
    expect(mocked.requests.filter(request => request.operation === 'details').at(-1)).toEqual({ operation: 'details', url: partUrl });
    // The source gave this part no voices, so there is nothing to start and focus rests on favorites.
    await onlyFocus(page, 'details-favorite');
    await expect(page.getByTestId('details-status')).toContainText('Источник не предоставил доступных озвучек.');
    // Back returns to the part the viewer came from, then to the catalog.
    await press(page, 'Escape');
    await expect(page.getByRole('heading', { name: 'Синтетический сериал', exact: true })).toBeVisible();
    await onlyFocus(page, 'details-franchise-0');
    await press(page, 'Escape');
    await onlyFocus(page, 'title-last-0');
    expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
  });
}

test('the full description, facts and ratings open in a sheet that is read with the remote', async ({ page }, testInfo) => {
  const mocked = await fixture(page, { details: html => html.replace('Описание сериала.', 'Подробное описание путешествия героев, их встреч и неожиданных открытий. '.repeat(100)) });
  // On the card a long description is cut to a few lines.
  const brief = page.locator('.title-description');
  expect(await brief.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true);
  expect(await brief.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(200);
  await expect(page.getByTestId('details-season-2')).toBeInViewport({ ratio: 1 });
  await page.getByTestId('details-about').focus();
  await press(page, 'Enter');
  const sheet = page.getByTestId('details-info-sheet');
  await expect(sheet).toBeVisible();
  await onlyFocus(page, 'details-about-content');
  const text = page.getByTestId('details-about-content');
  for (const value of ['Россия, Франция', 'Первая строка Вторая строка', 'World Art', '8.1 из 10 · голосов: 901', '7.6 из 10 · голосов: 12 345']) await expect(text).toContainText(value);
  await expect(text).not.toContainText('Редактировать');
  await page.screenshot({ path: testInfo.outputPath('card-about.png'), animations: 'disabled' });
  // Down scrolls the text to its end; the page behind does not move and takes no focus.
  const body = sheet.locator('.sheet-body'), last = text.locator('dl').last();
  await expect(last).not.toBeInViewport();
  for (let steps = 0; steps < 40 && !await last.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight); steps++) await press(page, 'ArrowDown');
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(500);
  expect(await page.locator('main').evaluate(element => element.scrollTop)).toBe(0);
  await onlyFocus(page, 'details-about-content');
  // Up returns through the text to the close button.
  for (let steps = 0; steps < 40 && await page.getByTestId('details-info-close').getAttribute('data-focused') !== 'true'; steps++) await press(page, 'ArrowUp');
  await onlyFocus(page, 'details-info-close');
  expect(await body.evaluate(element => element.scrollTop)).toBe(0);
  await press(page, 'Escape');
  await expect(sheet).toHaveCount(0);
  await onlyFocus(page, 'details-about');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a voice chosen on the card brings its own episodes, and a missing episode, a failure or a Premium voice is explained', async ({ page }, testInfo) => {
  await page.addInitScript(value => localStorage.setItem('rezzka.library.v1', value), watched('2', '2'));
  const voices = [['8', 'Студия А', 'active'], ['9', 'Студия Б', ''], ['10', 'Студия В', 'b-prem_translator'], ['11', 'Студия Г', '']]
    .map(([id, label, state]) => `<div class="b-translator__item ${state}" data-translator_id="${id}" title="${label}"></div>`).join('');
  let held: Route | undefined;
  const mocked = await fixture(page, {
    details: html => withVoices(html, voices, [['1', '1'], ['1', '2'], ['2', '1'], ['2', '2']]),
    intercept: async (route, params) => {
      if (params.operation !== 'episodes') return false;
      if (params.voice.id === '9') { held = route; return true; }
      await route.fulfill({ json: { returnValue: false, errorText: 'Список серий недоступен.' } }); return true;
    },
  });
  const status = page.getByTestId('details-status');
  await expect(page.getByTestId('details-play')).toContainText('Продолжить');
  await expect(status).toContainText('Вы остановились: сезон 2, серия 2');
  await expect(status).toContainText('Студия А');
  await expect(page.getByTestId('details-episode-2-2')).toContainText('Вы остановились здесь');

  await press(page, 'ArrowRight');
  await onlyFocus(page, 'details-voice');
  await press(page, 'Enter');
  await expect(page.getByTestId('details-voices-sheet')).toBeVisible();
  // The list opens on the current voice, and the page behind it holds no focus.
  await onlyFocus(page, 'details-voice-0');
  await expect(page.getByTestId('details-voice-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('details-voice-2')).toContainText('Нужен Premium');
  await page.screenshot({ path: testInfo.outputPath('card-voices.png'), animations: 'disabled' });
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-voice-1');
  await press(page, 'Enter');
  await expect(page.getByTestId('details-voices-sheet')).toHaveCount(0);
  // Until the new list arrives nothing can be started, and the card says why.
  await expect(status).toContainText('Загружаем серии для озвучки «Студия Б»');
  await expect(page.getByTestId('details-play')).toBeDisabled();
  await expect(page.locator('.episode-tile.is-loading')).toHaveCount(6);
  await expect(page.locator('[data-focused="true"]')).toHaveCount(1);
  await expect(page.locator('[data-focused="true"]')).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await held!.fulfill({ json: { returnValue: true, source: { url: origin + '/ajax/get_cdn_series/', body: JSON.stringify({ success: true, episodes: episodeLists([['1', '1'], ['1', '2']]) }) } } });
  await expect(status).toContainText('В этой озвучке нет сезона 2, серии 2.');
  await expect(status).toContainText('Начнём с: сезон 1, серия 1');
  await expect(status).toContainText('Студия Б');
  await expect(page.getByTestId('details-play')).toContainText('Смотреть');
  await expect(page.getByTestId('details-season-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('details-episode-1-1')).toContainText('Начнём отсюда');
  await expect(page.locator('[data-focused="true"]')).toHaveCount(1);
  await expect(page.locator('[data-focused="true"]')).toBeVisible();

  // A voice that needs Premium is explained instead of being chosen.
  await page.getByTestId('details-voice').focus();
  await press(page, 'Enter');
  await onlyFocus(page, 'details-voice-1');
  await press(page, 'ArrowDown', 'Enter');
  await expect(status).toContainText('Для этой озвучки нужен аккаунт Premium.');
  await expect(status).toContainText('Студия Б');
  await onlyFocus(page, 'details-voice');
  // A voice whose episodes cannot be read leaves the previous one in place.
  await press(page, 'Enter');
  await onlyFocus(page, 'details-voice-1');
  await press(page, 'ArrowDown', 'ArrowDown', 'Enter');
  await expect(status).toContainText('Не удалось загрузить серии для озвучки «Студия Г». Осталась прежняя.');
  await expect(status).toContainText('Студия Б');
  await expect(page.getByTestId('details-episode-1-2')).toBeVisible();

  // An episode starts from its tile with the chosen voice; the player asks for no list of its own.
  await page.getByTestId('details-play').focus();
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-season-1');
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-episode-1-1');
  await press(page, 'ArrowRight');
  await onlyFocus(page, 'details-episode-1-2');
  await press(page, 'Enter');
  await expect(page.getByTestId('player')).toBeVisible();
  await expect.poll(() => mocked.requests.filter(request => request.operation === 'streams')).toEqual([expect.objectContaining({ voice: expect.objectContaining({ id: '9' }), season: '1', episode: '2' })]);
  expect(mocked.requests.filter(request => request.operation === 'episodes').map(request => request.operation === 'episodes' && request.voice.id)).toEqual(['9', '11']);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('long rows keep the focused tile at the start of its row and many seasons stay one strip', async ({ page }, testInfo) => {
  await page.addInitScript(value => localStorage.setItem('rezzka.library.v1', value), watched('25', '1'));
  const people = Array.from({ length: 22 }, (_, index) => `<span class="person-name-item" data-id="${100 + index}" data-photo="https://images.example/people/41.jpg" data-job="Актёр"><span itemprop="name">Актёр ${index + 1}</span></span>`).join('');
  const seasons = Array.from({ length: 30 }, (_, index): Pair[] => [[String(index + 1), '1'], [String(index + 1), '2']]).flat();
  const mocked = await fixture(page, { details: html => withVoices(html.replace('</body>', `<div class="persons-list-holder">${people}</div></body>`), '<div class="b-translator__item active" data-translator_id="8" title="Студия А"></div>', seasons) });
  const main = page.locator('main'), scrollTop = () => main.evaluate(element => element.scrollTop);
  await expect(page.locator('.title-kind')).toContainText('Сериал · 30 сезонов');
  // The season being watched is in sight although focus is on «Продолжить».
  await expect(page.getByTestId('details-season-25')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('details-season-25')).toBeInViewport({ ratio: .99 });
  await expect(page.getByTestId('details-season-1')).not.toBeInViewport();
  const strip = await page.locator('.season-tabs').boundingBox();
  expect(strip!.height).toBeLessThan(100);
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-season-25');
  for (const season of [26, 27, 28, 29, 30]) {
    await press(page, 'ArrowRight');
    await onlyFocus(page, `details-season-${season}`);
    await expect(page.getByTestId(`details-season-${season}`)).toBeInViewport({ ratio: .99 });
    await expect(page.getByTestId(`details-season-${season}`)).toHaveAttribute('aria-pressed', 'true');
  }
  await press(page, 'ArrowRight');
  await onlyFocus(page, 'details-season-30');
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-episode-30-1');
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-person-0');
  await expect(page.locator('.person-tile')).toHaveCount(25);
  const heading = (await page.getByRole('heading', { name: 'Актёры и авторы', exact: true }).boundingBox())!;
  for (let index = 1; index <= 12; index++) {
    await press(page, 'ArrowRight');
    await onlyFocus(page, `details-person-${index}`);
  }
  // The row slides under a steady focus: the tile in focus stands where the row begins.
  const tile = (await page.getByTestId('details-person-12').boundingBox())!;
  expect(Math.abs(tile.x - heading.x)).toBeLessThan(tile.width * .2);
  await expect(page.getByTestId('details-person-12')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('heading', { name: 'Актёры и авторы', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await scrollTop()).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath('card-long-rows.png'), animations: 'disabled' });
  // Up goes back the way the viewer came and ends at the start of the page.
  await press(page, 'ArrowUp');
  await onlyFocus(page, 'details-episode-30-1');
  await press(page, 'ArrowUp');
  await onlyFocus(page, 'details-season-30');
  await press(page, 'ArrowUp');
  await expect(page.locator('.title-actions [data-focused="true"]')).toHaveCount(1);
  expect(await scrollTop()).toBe(0);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('focus waits on the card while it loads and moves to the main action unless the viewer went elsewhere', async ({ page }) => {
  const held: Route[] = [];
  const answer = async () => {
    await expect.poll(() => held.length).toBe(1);
    await held.pop()!.fulfill({ json: { returnValue: true, source: { url: emptyUrl, body: '<div class="b-post__title"><h1>Без дополнительных сведений</h1></div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>' } } });
  };
  const mocked = await fixture(page, { minimal: true, open: false, intercept: async (route, params) => { if (params.operation !== 'details') return false; held.push(route); return true; } });
  await press(page, 'Enter');
  // Until the description arrives the card has one control, and focus waits on it.
  await onlyFocus(page, 'details-favorite');
  await expect(page.getByTestId('details-status')).toContainText('Загружаем описание');
  await expect(page.getByTestId('details-play')).toHaveCount(0);
  await answer();
  await onlyFocus(page, 'details-play');
  await press(page, 'Escape');
  await onlyFocus(page, 'title-last-0');

  await press(page, 'Enter');
  await onlyFocus(page, 'details-favorite');
  await press(page, 'ArrowLeft');
  await onlyFocus(page, 'nav-catalog');
  await answer();
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.waitForTimeout(150);
  await onlyFocus(page, 'nav-catalog');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a title without extra details shows only what it has, and the demo never asks the source', async ({ page }) => {
  const mocked = await fixture(page, { minimal: true });
  await expect(page.locator('.title-kind')).toContainText('Фильм');
  await expect(page.getByTestId('details-status')).toContainText('Озвучка: Студия');
  await expect(page.locator('.title-description')).toHaveCount(0);
  await expect(page.getByTestId('details-episodes')).toHaveCount(0);
  await expect(page.locator('.title-section')).toHaveCount(0);
  // Nothing lies below the actions.
  await press(page, 'ArrowDown');
  await onlyFocus(page, 'details-play');
  await page.getByTestId('details-about').focus();
  await press(page, 'Enter');
  await expect(page.getByTestId('details-about-content')).toContainText('Описание пока не добавлено.');
  await press(page, 'Escape');
  await onlyFocus(page, 'details-about');
  // Comments are read once and stay loaded while the card is open.
  await press(page, 'ArrowRight');
  await onlyFocus(page, 'details-comments');
  await press(page, 'Enter');
  await expect(page.getByTestId('details-discussion-sheet')).toBeVisible();
  await expect(page.getByTestId('comments-panel')).toContainText('Комментариев пока нет.');
  await expect(page.locator('.title-screen [data-focused="true"]')).toHaveCount(0);
  await press(page, 'Escape');
  await expect(page.getByTestId('details-discussion-sheet')).toBeHidden();
  await onlyFocus(page, 'details-comments');
  await press(page, 'Enter');
  await expect(page.getByTestId('comments-panel')).toContainText('Комментариев пока нет.');
  await press(page, 'Escape');
  await onlyFocus(page, 'details-comments');
  expect(mocked.count('comments')).toBe(1);

  mocked.disableSource(); await page.reload();
  await page.getByTestId('demo-start').click(); await page.mouse.move(1919, 0);
  await onlyFocus(page, 'title-last-0');
  await press(page, 'Enter');
  await onlyFocus(page, 'details-play');
  const before = mocked.requests.length;
  await expect(page.getByTestId('details-play')).toContainText('Тестовый ролик');
  await expect(page.getByTestId('details-comments')).toHaveCount(0);
  // In the demo favorites are kept on this device.
  await page.getByTestId('details-favorite').focus();
  await expect(page.getByTestId('details-favorite')).toContainText('В избранное');
  await press(page, 'Enter');
  await expect(page.getByTestId('details-favorite')).toContainText('В избранном');
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('aria-pressed', 'true');
  expect(mocked.requests).toHaveLength(before);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
