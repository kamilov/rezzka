import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { SourceDocument } from '../../shared/source';
import type * as Provider from '../../src/provider';

type HarnessWindow = Window & typeof globalThis & { provider: typeof Provider; providerFixtureExecuted?: boolean };
const fixture = async (file: string, url = 'https://mirror.example/') => ({
  body: await readFile(new URL(`../fixtures/provider/${file}`, import.meta.url), 'utf8'), url,
});
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as HarnessWindow).provider));
});

test('catalog resolves links, keeps partial cards, parses pagination and does not execute source scripts', async ({ page }) => {
  const source = await fixture('catalog.html');
  const result = await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source), source);
  expect(result.items).toHaveLength(2);
  expect(result.items[0]).toMatchObject({ id: '101', title: 'Первый & второй', poster: 'https://mirror.example/posters/101.jpg', kind: 'film', year: '2024', rating: '7.4' });
  expect(result.items[0].ratings).toEqual([{ source: 'Кинопоиск', value: '7.4' }]);
  expect(result.items[1].rating).toBeUndefined();
  expect(result.items[1]).toMatchObject({ id: '202', kind: 'series', poster: '' });
  expect(result.nextPage).toBe(2);
  expect(await page.evaluate(() => (window as HarnessWindow).providerFixtureExecuted)).toBeUndefined();
  const last = await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source, 3), source);
  expect(last.nextPage).toBeUndefined();
});

test('observed catalog and search navigation advance from page two and stop after the last numbered link', async ({ page }) => {
  for (const [file, url, lastPage] of [
    ['catalog-page-2.html', 'https://mirror.example/page/2/?filter=last', 2037],
    ['search-page-2.html', 'https://mirror.example/search/?do=search&subaction=search&q=любовь&page=2', 4],
  ] as const) {
    const source = await fixture(file, url);
    const result = await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source, 2), source);
    expect(result.items).toHaveLength(1);
    expect(result.nextPage).toBe(3);
    const last = await page.evaluate(({ source, lastPage }) => (window as HarnessWindow).provider.parseCatalog(source, lastPage), { source, lastPage });
    expect(last.nextPage).toBeUndefined();
  }
});

test('client forwards the next page with catalog filters or the original search query', async ({ page }) => {
  const catalogSource = await fixture('catalog-page-2.html', 'https://mirror.example/page/2/?filter=popular&genre=2');
  const searchSource = await fixture('search-page-2.html', 'https://mirror.example/search/?do=search&subaction=search&q=любовь&page=2');
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/__bridge', async route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: Record<string, unknown> };
    expect(method).toBe('getSource');
    requests.push(params);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, source: params.operation === 'search' ? searchSource : catalogSource }) });
  });
  const results = await page.evaluate(async () => {
    const provider = (window as HarnessWindow).provider;
    return [
      await provider.loadCatalog({ page: 2, sort: 'popular', type: '2' }),
      await provider.searchTitles('  любовь  ', 2),
    ];
  });
  expect(requests).toEqual([
    { operation: 'catalog', page: 2, sort: 'popular', type: '2' },
    { operation: 'search', page: 2, query: 'любовь' },
  ]);
  expect(results.map(result => result.nextPage)).toEqual([3, 3]);
});

test('known empty search differs from a challenge or incompatible markup', async ({ page }) => {
  expect(await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source), await fixture('empty-search.html'))).toEqual({ items: [] });
  const code = (source: SourceDocument) => page.evaluate(source => {
    try { (window as HarnessWindow).provider.parseCatalog(source); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, source);
  expect(await code(await fixture('challenge.html'))).toBe('challenge');
  expect(await code(await fixture('login.html'))).toBe('authentication');
  expect(await code({ body: '<h1>Временная ошибка</h1>', url: 'https://mirror.example/' })).toBe('markup');
  expect(await code({ body: '<div class="b-content__inline_item">Malformed card</div>', url: 'https://mirror.example/' })).toBe('markup');
});

test('details extracts default inline voice, metadata and series voice flags without evaluating script', async ({ page }) => {
  const movie = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), await fixture('movie.html', 'https://mirror.example/films/drama/101-first.html'));
  expect(movie).toMatchObject({ id: '101', title: 'Первый & второй', description: 'История первого путешествия.', isSeries: false, duration: '95 мин.', year: '2024', selectedVoiceId: '14' });
  expect(movie.voices).toEqual([{ id: '14', label: 'Основная озвучка', isAds: '0', isCamrip: '0', isDirector: '0' }]);
  expect(movie.ratings).toEqual([{ source: 'Кинопоиск', value: '8.3', votes: '678' }, { source: 'IMDb', value: '7.6', votes: '12 345' }, { source: 'HDrezka', value: '9.2', votes: '456' }]);
  expect(await page.evaluate(() => (window as HarnessWindow).providerFixtureExecuted)).toBeUndefined();
  const series = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), await fixture('series.html', 'https://mirror.example/animation/202-second.html'));
  expect(series).toMatchObject({ kind: 'anime', isSeries: true, selectedVoiceId: '9' });
  expect(series.voices[1]).toMatchObject({ id: '9', label: 'Студия Б · HD', premium: true, isDirector: '1' });
  expect(series.episodes).toEqual([{ id: '1', season: '2', title: 'Серия 1' }, { id: '2', season: '2', title: 'Серия 2' }, { id: '1', season: '3', title: 'Новый путь' }]);
});

test('missing or malformed rating does not become a vote count or a recommendation rating', async ({ page }) => {
  const source = await fixture('movie.html', 'https://mirror.example/films/drama/101-first.html');
  source.body = source.body.replace('<span>7.6</span>', '<span>—</span>').replace('<b>8,3</b>', '<b>12345</b>').replace('<span class="num">9.2</span>', '<span class="num">0</span>')
    + '<aside><span class="imdb"><b>9.9</b></span><span class="kp"><span>9.8</span></span></aside>';
  const result = await page.evaluate(source => (window as HarnessWindow).provider.parseDetails(source), source);
  expect(result.ratings).toEqual([]);
  expect(result.rating).toBeUndefined();
});

test('AJAX parses JSON and wrapped JSON, reports source refusal and rejects unsafe media', async ({ page }) => {
  const base = 'https://mirror.example/ajax/get_cdn_series/';
  const encoded = '#h' + Buffer.from('[720p]https://cdn.example/stream.m3u8 or https://cdn.example/stream.mp4').toString('base64');
  const playback = await page.evaluate(source => (window as HarnessWindow).provider.parsePlayback(source), { body: JSON.stringify({ success: true, url: encoded, subtitle: '[Русский]/ru.vtt' }), url: base });
  expect(playback.streams).toEqual([{ quality: '720p', url: 'https://cdn.example/stream.mp4' }]);
  expect(playback.subtitles[0].url).toBe('https://mirror.example/ru.vtt');
  const episodes = await page.evaluate(source => (window as HarnessWindow).provider.parseEpisodes(source), { body: `<html><body>${JSON.stringify({ success: true, episodes: '<ul class="b-simple_episodes__list" id="simple-episodes-list-1"><li class="b-simple_episode__item" data-episode_id="2">Вторая</li></ul>' }).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</body></html>`, url: base });
  expect(episodes).toEqual([{ id: '2', season: '1', title: 'Вторая' }]);
  for (const data of [{ success: false, message: '<b>Недоступно</b>' }, { success: true, url: '[720p]javascript:alert(1)' }]) {
    expect(await page.evaluate(source => {
      try { (window as HarnessWindow).provider.parsePlayback(source); return null; }
      catch (error) { return (error as { code: string }).code; }
    }, { body: JSON.stringify(data), url: base })).toBe('unavailable');
  }
});

test('client uses inline playback only for its voice and forwards selected episode to the service', async ({ page }) => {
  const movieSource = await fixture('movie.html', 'https://mirror.example/films/drama/101-first.html');
  const seriesSource = await fixture('series.html', 'https://mirror.example/series/202-second.html');
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/__bridge', async route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: Record<string, unknown> };
    expect(method).toBe('getSource');
    requests.push(params);
    const source = params.operation === 'details' ? (String(params.url).includes('101-') ? movieSource : seriesSource) : {
      body: JSON.stringify({ success: true, url: '[720p]https://cdn.example/selected.mp4', subtitle: false }), url: 'https://mirror.example/ajax/get_cdn_series/',
    };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, source }) });
  });
  const result = await page.evaluate(async () => {
    const provider = (window as HarnessWindow).provider;
    const movie = await provider.loadDetails({ id: '101', title: 'Первый', url: 'https://mirror.example/films/drama/101-first.html', poster: '', kind: 'film' });
    const embedded = await provider.loadPlayback(movie, movie.voices[0]);
    const series = await provider.loadDetails({ id: '202', title: 'Путь', url: 'https://mirror.example/series/202-second.html', poster: '', kind: 'series' });
    const episodes = await provider.loadEpisodes(series, series.voices[1]);
    const selected = await provider.loadPlayback(series, series.voices[1], episodes[1]);
    return { embedded, selected };
  });
  expect(result.embedded.streams[0].url).toBe('https://cdn.example/101.mp4');
  expect(result.selected.streams[0].url).toBe('https://cdn.example/selected.mp4');
  expect(requests.map(request => request.operation)).toEqual(['details', 'details', 'streams']);
  expect(requests[2]).toMatchObject({ id: '202', voice: { id: '9' }, season: '2', episode: '2' });
});
