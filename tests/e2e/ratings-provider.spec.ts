import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Ratings from '../../src/provider-ratings';
import type * as Provider from '../../src/provider';
import type { SourceDocument, SourceRequest, TitleSummary } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & {
  ratings: typeof Ratings; provider: typeof Provider; ratingsFixtureExecuted?: boolean;
  pendingRatings?: Promise<unknown>; authEvents?: number;
};
const origin = 'https://mirror.example';
const title: TitleSummary = { id: '701', url: origin + '/films/drama/701-first.html', title: 'Первый фильм', kind: 'film', poster: '' };
const fixture = async (name = 'ratings.html'): Promise<SourceDocument> => ({
  body: await readFile(new URL(`../fixtures/provider/${name}`, import.meta.url), 'utf8'), url: origin + '/engine/ajax/quick_content.php',
});
const reply = (route: Route, source: SourceDocument) => route.fulfill({ json: { returnValue: true, source } });
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as HarnessWindow).provider));
  await page.evaluate(async () => {
    const modulePath = '/src/provider-ratings.ts';
    (window as HarnessWindow).ratings = await import(/* @vite-ignore */ modulePath) as typeof Ratings;
  });
});

test('compact ratings use only the identified title rating group and never execute source scripts', async ({ page }) => {
  const source = await fixture();
  const result = await page.evaluate(({ source, title }) => (window as HarnessWindow).ratings.parseCardRatings(source, title), { source, title });
  expect(result).toEqual([{ source: 'Кинопоиск', value: '8.3' }, { source: 'IMDb', value: '7.6' }]);
  expect(await page.evaluate(() => (window as HarnessWindow).ratingsFixtureExecuted)).toBeUndefined();
  const fragment = source.body.match(/<body>([\s\S]*)<\/body>/)![1];
  const wrapped = { ...source, body: `<div class="b-content__bubble"><div class="b-content__bubble_content">${fragment}</div></div>` };
  expect(await page.evaluate(({ source, title }) => (window as HarnessWindow).ratings.parseCardRatings(source, title), { source: wrapped, title })).toEqual(result);
});

test('valid unrated cards stay empty and votes, zero, excessive or malformed values never become ratings', async ({ page }) => {
  const source = await fixture();
  const bodies = [
    '<div class="b-content__bubble_title"><a href="/films/drama/701-first.html">Первый фильм</a></div><div class="b-content__bubble_text">Описание</div>',
    source.body.replace('<b>7.6</b>', '<b>12345</b>').replace('<b>8,3</b>', '<b>0</b>'),
    source.body.replace('<b>7.6</b>', '<i><b>7</b></i>').replace('<b>8,3</b>', '<span>8.3</span>'),
    source.body.replace('<b>7.6</b>', '<b>10.1</b>').replace('<b>8,3</b>', '<b>8.3 / 10</b>'),
    source.body.replace('<b>7.6</b>', '<b>—</b>').replace('<b>8,3</b>', '<b>8.3</b><b>9</b>'),
  ];
  for (const body of bodies) {
    expect(await page.evaluate(({ source, title }) => (window as HarnessWindow).ratings.parseCardRatings(source, title), { source: { ...source, body }, title })).toEqual([]);
  }
  expect(await page.evaluate(({ source, title }) => (window as HarnessWindow).ratings.parseCardRatings(source, title), {
    source: { ...source, body: source.body.replace('<b>7.6</b>', '<b>10.000</b>').replace('<b>8,3</b>', '<b>0.125</b>') }, title,
  })).toEqual([{ source: 'Кинопоиск', value: '0.125' }, { source: 'IMDb', value: '10.000' }]);
});

test('invalid, wrong-title and cross-mirror fragments fail instead of returning a false empty result', async ({ page }) => {
  const source = await fixture();
  const cases: SourceDocument[] = [
    { ...source, body: '<p>Временная ошибка</p>' },
    { ...source, body: source.body.replace('/701-first.html', '/702-other.html') },
    { ...source, body: source.body.replace('href="/films/', 'href="https://other.example/films/') },
    { ...source, body: source.body.replace('/701-first.html', '/701-first.html?action=delete') },
    { ...source, body: source.body.replace('href="/films/drama/701-first.html"', 'href="javascript:alert(1)"') },
    { ...source, url: 'https://other.example/engine/ajax/quick_content.php' },
    { ...source, url: origin + '/ajax/favorites/' },
    { ...source, url: source.url + '?id=701' },
    { ...source, url: source.url + '#fragment' },
  ];
  for (const source of cases) {
    expect(await page.evaluate(({ source, title }) => {
      try { (window as HarnessWindow).ratings.parseCardRatings(source, title); return 'no-error'; }
      catch (error) { return (error as { code: string }).code; }
    }, { source, title })).toBe('markup');
  }
  for (const [name, code] of [['login.html', 'authentication'], ['challenge.html', 'challenge']]) {
    expect(await page.evaluate(({ source, title }) => {
      try { (window as HarnessWindow).ratings.parseCardRatings(source, title); return 'no-error'; }
      catch (error) { return (error as { code: string }).code; }
    }, { source: await fixture(name), title })).toBe(code);
  }
});

test('loader forwards only canonical title identity and rejects unsafe identities before requesting', async ({ page }) => {
  const source = await fixture(), requests: SourceRequest[] = [];
  await page.route('**/__bridge', route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    expect(method).toBe('getSource'); requests.push(params); return reply(route, source);
  });
  expect(await page.evaluate(title => (window as HarnessWindow).ratings.loadCardRatings(title), title)).toHaveLength(2);
  const invalid = [
    { ...title, id: '702' }, { ...title, id: '1234567890123' }, { ...title, url: title.url + '?action=remove' },
    { ...title, url: title.url + '#fragment' }, { ...title, url: 'javascript:alert(1)' },
    { ...title, url: title.url.replace('https://', 'https://name:secret@') },
  ];
  for (const title of invalid) expect(await page.evaluate(async title => {
    try { await (window as HarnessWindow).ratings.loadCardRatings(title); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, title)).toBe('markup');
  expect(requests).toEqual([{ operation: 'ratings', url: title.url, id: title.id }]);
});

test('changing provider generation discards a pending compact response', async ({ page }) => {
  let pending: Route | undefined;
  await page.route('**/__bridge', route => { pending = route; });
  await page.evaluate(title => {
    const state = window as HarnessWindow;
    state.pendingRatings = state.ratings.loadCardRatings(title).then(() => 'success', error => error.name);
  }, title);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(() => (window as HarnessWindow).provider.resetProviderSession());
  await reply(pending!, await fixture());
  expect(await page.evaluate(() => (window as HarnessWindow).pendingRatings)).toBe('Error');
});

test('login response reaches the common authentication gate', async ({ page }) => {
  const source = await fixture('login.html');
  await page.route('**/__bridge', route => reply(route, source));
  await page.evaluate(() => {
    const state = window as HarnessWindow;
    state.authEvents = 0; state.provider.subscribeToSourceAuth(() => { state.authEvents!++; });
  });
  expect(await page.evaluate(async title => {
    try { await (window as HarnessWindow).ratings.loadCardRatings(title); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, title)).toBe('authentication');
  expect(await page.evaluate(() => (window as HarnessWindow).authEvents)).toBe(1);
});
