import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type * as People from '../../src/provider-person';
import type * as Provider from '../../src/provider';
import type { SourceDocument, SourceRequest } from '../../shared/source';

type Harness = Window & typeof globalThis & { people: typeof People; provider: typeof Provider; personFixtureExecuted?: boolean };
const origin = 'https://mirror.example', url = origin + '/person/41-alexey/';
const fixture = async (): Promise<SourceDocument> => ({ url, body: await readFile(new URL('../fixtures/provider/person.html', import.meta.url), 'utf8') });
test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as Harness).provider));
  await page.evaluate(async () => {
    const path = '/src/provider-person.ts';
    (window as Harness).people = await import(/* @vite-ignore */ path) as typeof People;
  });
});

test('person metadata and filmography preserve source roles and exclude unrelated or unsafe cards', async ({ page }) => {
  const result = await page.evaluate(source => (window as Harness).people.parsePerson(source), await fixture());
  expect(result).toMatchObject({ id: '41', url, name: 'Алексей Смирнов', originalName: 'Alexey Smirnov', photo: 'https://images.example/people/41.jpg' });
  expect(result.facts).toEqual([
    { label: 'Карьера', value: 'актёр, режиссёр' }, { label: 'Дата рождения', value: '1 февраля, 1980 (46 лет)' },
    { label: 'Место рождения', value: 'Москва, Россия' }, { label: 'Рост', value: '1.85 м' },
  ]);
  expect(result.filmography.map(group => ({ role: group.role, ids: group.items.map(item => item.id) }))).toEqual([
    { role: 'Актёр', ids: ['501', '502'] }, { role: 'Режиссёр', ids: ['501'] },
  ]);
  expect(result.filmography[0].items[0]).toMatchObject({ title: 'Первый фильм', kind: 'film', year: '2026', poster: origin + '/posters/501.jpg', rating: '8.3' });
  expect(await page.evaluate(() => (window as Harness).personFixtureExecuted)).toBeUndefined();
});

test('all filmography cards are read in one document, including long careers and empty roles', async ({ page }) => {
  const source = await fixture();
  source.body = '<div class="b-post__title"><h1><span itemprop="name">Большая фильмография</span></h1></div>' +
    '<div class="b-person__career"><h2>Актёр</h2>' + Array.from({ length: 103 }, (_, index) => `<div class="b-content__inline_item" data-id="${index + 1}"><div class="b-content__inline_item-link"><a href="/films/${index + 1}-film.html">Фильм ${index + 1}</a></div></div>`).join('') + '</div>' +
    '<div class="b-person__career"><h2>Режиссёр</h2></div>';
  const result = await page.evaluate(source => (window as Harness).people.parsePerson(source), source);
  expect(result.filmography[0].items).toHaveLength(103);
  expect(result.filmography[0].items.at(-1)?.title).toBe('Фильм 103');
  expect(result.filmography[1]).toEqual({ role: 'Режиссёр', items: [] });
  expect(result.facts).toEqual([]); expect(result.photo).toBeUndefined();
});

test('details accept real slash person links and legacy html while rejecting foreign and parameterized links', async ({ page }) => {
  const links = ['/person/41-alexey/', '/person/42-legacy.html', 'https://outside.example/person/43-other/', '/person/44-query/?page=2', '/person/45-name%2Fextra/', '/person/0-invalid/'];
  const source = { url: origin + '/films/drama/501-first.html', body: '<div class="b-post__title"><h1>Фильм</h1></div><div class="persons-list-holder">' + links.map((link, index) => `<span class="person-name-item" data-id="${41 + index}"><a href="${link}"><span itemprop="name">Персона ${index}</span></a></span>`).join('') + '</div>' };
  const result = await page.evaluate(source => (window as Harness).provider.parseDetails(source), source);
  expect(result.people?.map(person => person.url)).toEqual([url, origin + '/person/42-legacy.html', undefined, undefined, undefined, undefined]);
});

test('empty profiles remain distinct from unexpected markup and authentication challenges', async ({ page }) => {
  const source = { url, body: '<div class="b-post__title"><h1><span class="t1" itemprop="name">Новая персона</span></h1></div>' };
  expect(await page.evaluate(source => (window as Harness).people.parsePerson(source), source)).toEqual({ id: '41', url, name: 'Новая персона', facts: [], filmography: [] });
  for (const [body, code] of [
    ['<h1>Не найдено</h1>', 'markup'], ['<div class="b-post__title"><h1>Фильм вместо человека</h1></div>', 'markup'],
    ['<h1>Вход</h1><input name="login_name"><input name="login_password">', 'authentication'],
    ['<h1>Проверка браузера</h1>', 'challenge'],
  ]) {
    const error = await page.evaluate(source => { try { (window as Harness).people.parsePerson(source); return ''; } catch (error) { return (error as { code: string }).code; } }, { url, body });
    expect(error).toBe(code);
  }
});

test('loading a person performs only the explicit readonly person request', async ({ page }) => {
  const source = await fixture(), requests: SourceRequest[] = [];
  await page.route('**/__bridge', route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    expect(method).toBe('getSource'); requests.push(params);
    return route.fulfill({ json: { returnValue: true, source } });
  });
  expect((await page.evaluate(url => (window as Harness).people.loadPerson(url), url)).filmography).toHaveLength(2);
  expect(requests).toEqual([{ operation: 'person', url }]);
});
