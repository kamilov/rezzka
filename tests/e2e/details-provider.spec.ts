import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Provider from '../../src/provider';
import type { SourceDocument, SourceRequest } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & { provider: typeof Provider; detailsFixtureExecuted?: boolean };
const fixture = async (file = 'details-extra.html'): Promise<SourceDocument> => ({
  body: await readFile(new URL(`../fixtures/provider/${file}`, import.meta.url), 'utf8'), url: 'https://mirror.example/series/drama/501-synthetic.html',
});
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as HarnessWindow).provider));
});

test('details contain source facts and named people with safe photos and canonical links', async ({ page }) => {
  const details = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), await fixture());
  expect(details.facts).toEqual([
    { label: 'Дата выхода', value: '1 мая 2025 года' }, { label: 'Страна', value: 'Россия, Франция' },
    { label: 'Жанр', value: 'Драма, Приключения' }, { label: 'Возраст', value: '16+' },
    { label: 'Время', value: '45 мин.' }, { label: 'Слоган', value: 'Первая строка Вторая строка' },
  ]);
  expect(details.people).toEqual([
    { id: '41', name: 'Алексей Смирнов', job: 'Режиссёр', photo: 'https://images.example/people/41.jpg', url: 'https://mirror.example/person/410-alexey.html' },
    { id: '42', name: 'София Петрова', job: 'Актриса', url: 'https://mirror.example/person/420-sofia.html' },
    { id: '43', name: 'Максим Волков', job: 'Актёр' },
  ]);
  expect(details).toMatchObject({ id: '501', originalTitle: 'Synthetic Series', duration: '45 мин.', selectedVoiceId: '8', selectedEpisode: { id: '1', season: '2' } });
  expect(details.voices).toHaveLength(1); expect(details.episodes).toHaveLength(1);
  expect(await page.evaluate(() => (window as HarnessWindow).detailsFixtureExecuted)).toBeUndefined();
});

test('schedule includes all hidden seasons and episodes while excluding show-more and admin rows', async ({ page }) => {
  const details = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), await fixture());
  expect(details.schedule).toEqual([
    { title: '2 сезон', season: '2', episodes: [
      { episode: '1 серия', number: '1', title: 'Начало', date: '1 ноября 2026', relative: '✓', watched: true },
      { episode: '2 серия', number: '2', title: 'Продолжение', date: '8 ноября 2026', relative: 'через 5 дней' },
    ] },
    { title: '1 сезон', season: '1', episodes: [{ episode: '1 серия', number: '1', title: 'Прошлое', date: '2 мая 2025', relative: '✓', watched: false }] },
  ]);
});

test('franchise preserves current and unavailable parts but exposes only safe source links', async ({ page }) => {
  const details = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), await fixture());
  expect(details.franchise).toEqual([
    { title: 'Предыстория', id: '701', url: 'https://mirror.example/films/drama/701-prequel.html', year: '2022', rating: '8.2' },
    { title: 'Синтетический сериал', year: '2025' }, { title: 'Будущая часть', year: '2027' }, { title: 'Внешняя ссылка', year: '2023' },
  ]);
});

test('World Art and vote counts are scoped to title ratings and never substitute for a missing score', async ({ page }) => {
  const source = await fixture();
  const ratings = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source).ratings, source);
  expect(ratings).toEqual([
    { source: 'Кинопоиск', value: '8.3', votes: '678' }, { source: 'IMDb', value: '7.6', votes: '12 345' },
    { source: 'World Art', value: '8.1', votes: '901' }, { source: 'HDrezka', value: '9.2', votes: '456' },
  ]);
  source.body = source.body.replace('<span>8.1</span><i>(901)</i>', '<span>—</span><i><span>5</span></i>')
    .replace('<span>7.6</span><i>(12 345)</i>', '<span>7.6</span><i>Недоступно</i>')
    .replace('<span>456</span> голосов', '<span>0</span> голосов');
  expect(await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source).ratings, source)).toEqual([
    { source: 'Кинопоиск', value: '8.3', votes: '678' }, { source: 'IMDb', value: '7.6' }, { source: 'HDrezka', value: '9.2', votes: '0' },
  ]);
});

test('missing or partial optional data does not invent people, schedules, parts, or comment totals', async ({ page }) => {
  const source = await fixture('series.html');
  source.body += '<div class="persons-list-holder"><span class="person-name-item" data-id="99"></span></div>' +
    '<div class="b-post__schedule"><div class="b-post__schedule_block"><div class="b-post__schedule_list"><table><tr><td>Неполная строка</td></tr></table></div></div></div>' +
    '<div class="b-post__partcontent_item"><div class="year">2026</div></div><div id="comments-list"><div>Один загруженный комментарий</div></div>';
  const details = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), source);
  expect(details.facts).toEqual([]); expect(details.people).toEqual([]); expect(details.schedule).toEqual([]); expect(details.franchise).toEqual([]);
  expect(details.commentCount).toBeUndefined();
  expect(details.voices).toHaveLength(2); expect(details.episodes).toHaveLength(3);
});

test('loading all extra information uses the existing detail read without person or schedule requests', async ({ page }) => {
  const source = await fixture(), requests: SourceRequest[] = [];
  await page.route('**/__bridge', route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    expect(method).toBe('getSource'); requests.push(params);
    return route.fulfill({ json: { returnValue: true, source } });
  });
  const details = await page.evaluate(url => (window as HarnessWindow).provider.loadDetails({ id: '501', url, title: 'Синтетический сериал', kind: 'series', poster: '' }), source.url);
  expect(details.people).toHaveLength(3); expect(details.schedule).toHaveLength(2); expect(details.franchise).toHaveLength(4);
  expect(requests).toEqual([{ operation: 'details', url: source.url }]);
});
