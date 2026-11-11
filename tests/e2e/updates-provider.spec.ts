import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Provider from '../../src/provider';
import type * as Ratings from '../../src/provider-ratings';
import type { SourceDocument } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & { provider: typeof Provider; ratings: typeof Ratings; updatesFixtureExecuted?: boolean };
const fixture = async (file: string, url: string): Promise<SourceDocument> => ({ body: await readFile(new URL(`../fixtures/provider/${file}`, import.meta.url), 'utf8'), url });

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.evaluate(async () => {
    const modulePath = '/src/provider-ratings.ts';
    (window as HarnessWindow).ratings = await import(/* @vite-ignore */ modulePath) as typeof Ratings;
  });
  await page.waitForFunction(() => 'provider' in window);
});

test('the first catalog page carries released episodes with their day, voice and the account tracking mark', async ({ page }) => {
  const source = await fixture('updates.html', 'https://mirror.example/');
  const first = await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source, 1), source);
  expect(first.updates).toEqual([
    { id: '301', url: 'https://mirror.example/series/fiction/301-route.html', title: 'Дальний путь', season: '2 сезон', episode: '4 серия', voice: 'Студия А', date: 'Сегодня', tracked: true },
    { id: '302', url: 'https://mirror.example/series/drama/302-north.html', title: 'Северный ветер', season: '1 сезон', episode: '9 серия', date: 'Сегодня', tracked: false },
    { id: '305', url: 'https://mirror.example/animation/305-light.html', title: 'Линия света', season: '1 сезон', episode: '12 серия', voice: 'Оригинал', date: 'Вчера', tracked: false },
  ]);
  expect(first.items.map(item => item.id)).toEqual(['501']);
  expect(await page.evaluate(() => (window as HarnessWindow).updatesFixtureExecuted)).toBeUndefined();
});

test('later pages and catalogs without the block report no updates', async ({ page }) => {
  const source = await fixture('updates.html', 'https://mirror.example/page/2/');
  expect(await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source, 2), source)).not.toHaveProperty('updates');
  const plain = await fixture('catalog.html', 'https://mirror.example/');
  expect(await page.evaluate(source => (window as HarnessWindow).provider.parseCatalog(source, 1), plain)).not.toHaveProperty('updates');
});

test('the short card yields its description together with the ratings', async ({ page }) => {
  const source = await fixture('ratings.html', 'https://mirror.example/engine/ajax/quick_content.php');
  const title = { id: '701', url: 'https://mirror.example/films/drama/701-first.html', title: 'Первый фильм', poster: '', kind: 'film' as const };
  const brief = await page.evaluate(([source, title]) => (window as HarnessWindow).ratings.parseCardBrief(source, title), [source, title] as const);
  expect(brief).toEqual({ ratings: [{ source: 'Кинопоиск', value: '8.3' }, { source: 'IMDb', value: '7.6' }], description: 'Описание фильма' });
  const withoutText = { ...source, body: source.body.replace(/<div class="b-content__bubble_text">.*?<\/div>/, '') };
  expect(await page.evaluate(([source, title]) => (window as HarnessWindow).ratings.parseCardBrief(source, title), [withoutText, title] as const)).not.toHaveProperty('description');
});
