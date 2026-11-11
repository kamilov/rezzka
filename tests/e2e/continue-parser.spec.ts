import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as ContinueProvider from '../../src/provider-continue';
import type { SourceDocument } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & { continueProvider: typeof ContinueProvider; continueFixtureExecuted?: boolean };
const fixture = async (file: string): Promise<SourceDocument> => ({
  body: await readFile(new URL(`../fixtures/provider/${file}`, import.meta.url), 'utf8'),
  url: 'https://mirror.example/continue/',
});

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.evaluate(async () => {
    const modulePath = '/src/provider-continue.ts';
    (window as HarnessWindow).continueProvider = await import(/* @vite-ignore */ modulePath) as typeof ContinueProvider;
  });
});

test('account continue list keeps the first saved title and normalizes safe entries without executing scripts', async ({ page }) => {
  const items = await page.evaluate(source => (window as HarnessWindow).continueProvider.parseContinue(source), await fixture('continue.html'));
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual({
    saveId: '901', dateLabel: 'Сегодня, 12:00', info: 'Сезон 2, серия 3 Студия А', watched: false,
    title: { id: '301', url: 'https://mirror.example/series/fiction/301-route.html', title: 'Дальний путь', kind: 'series', poster: 'https://mirror.example/posters/301.jpg', year: '2024', meta: '2024' },
  });
  expect(items[1]).toMatchObject({ saveId: '902', watched: true, title: { id: '302', url: 'https://mirror.example/films/drama/302-first.html', title: 'Первый & второй', kind: 'film', year: '2023' } });
  // The link the source puts beside the entry is not part of what was watched and says nothing about news.
  expect(items[0]).not.toHaveProperty('update');
  expect(items[0]).not.toHaveProperty('position');
  expect(await page.evaluate(() => (window as HarnessWindow).continueFixtureExecuted)).toBeUndefined();
});

test('only a series with a later released episode than the saved one is marked and comes first', async ({ page }) => {
  const ordered = await page.evaluate(() => {
    const item = (saveId: string, info: string, kind: 'film' | 'series' | 'cartoon' = 'series', folder = 'series') => ({
      saveId, info, dateLabel: '', watched: false,
      title: { id: saveId, url: `https://mirror.example/${folder}/${saveId}-name.html`, title: `Запись ${saveId}`, poster: '', kind },
    });
    const released = (id: string, season: string, episode: string, tracked = false, folder = 'series') => ({ id, url: `https://mirror.example/${folder}/${id}-name.html`, title: `Запись ${id}`, season, episode, tracked });
    return (window as HarnessWindow).continueProvider.orderContinue(
      [item('1', 'Сезон 1, серия 4 Студия'), item('2', '2 сезон 5 серия Студия'), item('3', 'Сезон 1, серия 2 Студия'), item('4', 'Студия без номера'), item('5', 'Сезон 3, серия 1'),
        item('6', 'Основная озвучка', 'film', 'films'), item('7', 'Сезон 1, серия 1', 'cartoon', 'animation'), item('8', 'Сезон 1, серия 1')],
      [released('1', '1 сезон', '4 серия'), released('2', '2 сезон', '6 серия'), released('2', '2 сезон', '7 серия'), released('4', '1 сезон', '1 серия', true), released('5', '2 сезон', '9 серия'),
        released('6', '1 сезон', '1 серия', true, 'films'), released('7', '1 сезон', '2 серия', false, 'animation'), released('9', '1 сезон', '1 серия', true)],
    ).map(entry => [entry.saveId, entry.fresh ?? '']);
  });
  // 2: a later episode was released, the latest of the two listed. 7: a series in the animation section counts as a series.
  // 1 has already reached the released episode and 5 is ahead of it. 3 and 8 have no release listed.
  // 4 has no saved episode to compare, and 6 is a film: the account's tracking flag alone marks neither.
  expect(ordered).toEqual([['2', 'Сезон 2, серия 7'], ['7', 'Сезон 1, серия 2'], ['1', ''], ['3', ''], ['4', ''], ['5', ''], ['6', ''], ['8', '']]);
});

test('saving what is watched sends only the title, voice and episode and reports a refusal', async ({ page }) => {
  const requests: unknown[] = [];
  let success = true;
  await page.route('**/__bridge', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { returnValue: true, source: { body: JSON.stringify({ success }), url: 'https://mirror.example/ajax/send_save/?t=1' } } });
  });
  const save = (episode: boolean) => page.evaluate(async withEpisode => {
    try {
      await (window as HarnessWindow).continueProvider.saveContinue({ id: '301', url: 'https://mirror.example/series/fiction/301-route.html' }, { id: '8', label: 'Студия А' }, withEpisode ? { id: '4', season: '2', title: 'Серия 4' } : undefined);
      return 'saved';
    } catch (error) { return (error as { code?: string }).code ?? 'error'; }
  }, episode);
  expect(await save(true)).toBe('saved');
  expect(await save(false)).toBe('saved');
  success = false;
  expect(await save(true)).toBe('unavailable');
  expect(requests.slice(0, 2)).toEqual([
    { method: 'getSource', params: { operation: 'continueSave', id: '301', url: 'https://mirror.example/series/fiction/301-route.html', voice: { id: '8', label: 'Студия А' }, season: '2', episode: '4' } },
    { method: 'getSource', params: { operation: 'continueSave', id: '301', url: 'https://mirror.example/series/fiction/301-route.html', voice: { id: '8', label: 'Студия А' } } },
  ]);
});

test('a list without its table heading still preserves the first title', async ({ page }) => {
  const source = await fixture('continue.html');
  source.body = source.body.replace(/<div class="b-videosaves__list_item"><div class="th date">.*?<\/div><\/div>/, '');
  const items = await page.evaluate(source => (window as HarnessWindow).continueProvider.parseContinue(source), source);
  expect(items.map(item => item.saveId)).toEqual(['901', '902']);
});

test('empty account history differs from login, challenge and malformed responses', async ({ page }) => {
  expect(await page.evaluate(source => (window as HarnessWindow).continueProvider.parseContinue(source), await fixture('continue-empty.html'))).toEqual([]);
  const code = (source: SourceDocument) => page.evaluate(source => {
    try { (window as HarnessWindow).continueProvider.parseContinue(source); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, source);
  expect(await code(await fixture('continue-login.html'))).toBe('authentication');
  expect(await code(await fixture('login.html'))).toBe('authentication');
  expect(await code(await fixture('challenge.html'))).toBe('challenge');
  for (const body of [
    '<h1>Сервис временно недоступен</h1>',
    '<div id="videosaves-list"><div class="b-videosaves__list_item"><div class="th title">Название</div></div></div>',
    '<div id="videosaves-list"><div id="videosave-1" class="b-videosaves__list_item">Некорректная запись</div><p>Нет сохранений</p></div>',
  ]) expect(await code({ body, url: 'https://mirror.example/continue/' })).toBe('markup');
});

test('client requests the account continue operation through the existing source session', async ({ page }) => {
  const source = await fixture('continue.html');
  const requests: unknown[] = [];
  await page.route('**/__bridge', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { returnValue: true, source } });
  });
  const items = await page.evaluate(() => (window as HarnessWindow).continueProvider.loadContinue());
  expect(requests).toEqual([{ method: 'getSource', params: { operation: 'continue' } }]);
  expect(items.map(item => item.saveId)).toEqual(['901', '902']);
});
