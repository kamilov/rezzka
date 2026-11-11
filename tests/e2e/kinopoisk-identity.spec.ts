import { expect, test } from '@playwright/test';
import type * as Provider from '../../src/provider';
import type * as People from '../../src/provider-person';
import type { SourceDocument } from '../../shared/source';

type Harness = Window & typeof globalThis & { provider: typeof Provider; identityPeople: typeof People; identityFixtureExecuted?: boolean };
const origin = 'https://mirror.example';
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const wrapped = (value: string) => '/help/' + Buffer.from(encodeURIComponent(value)).toString('base64') + '/';
const link = (value: string) => `<a href="${escapeAttribute(value)}">Кинопоиск</a>`;
const title = (links: string[], extra = ''): SourceDocument => ({
  url: origin + '/films/drama/501-title.html',
  body: `<div class="b-post__title"><h1>Фильм источника</h1></div><table class="b-post__info"><tr><td>Рейтинг</td><td><span class="kp">${links.map(link).join('')}<span>8.3</span><i>(326)</i></span></td></tr></table>${extra}`,
});
const person = (datetime?: string, extra = ''): SourceDocument => ({
  url: origin + '/person/41-person/',
  body: `<div class="b-post__title"><h1><span itemprop="name">Персона</span><span itemprop="alternativeHeadline">Person</span></h1></div><table class="b-post__info"><tr><td>Дата рождения:</td><td><time itemprop="birthDate"${datetime === undefined ? '' : ` datetime="${escapeAttribute(datetime)}"`}>1 февраля, 1980 (46 лет)</time></td></tr></table>${extra}`,
});

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as Harness).provider));
  await page.evaluate(async () => {
    const modulePath = '/src/provider-person.ts';
    (window as Harness).identityPeople = await import(/* @vite-ignore */ modulePath) as typeof People;
  });
});

test('title identity comes from explicit direct film or series links, not source IDs or rating values', async ({ page }) => {
  for (const url of ['https://www.kinopoisk.ru/film/326/', 'https://kinopoisk.ru/film/326', '//www.kinopoisk.ru/series/326/', 'http://www.kinopoisk.ru/film/326/']) {
    const result = await page.evaluate(source => (window as Harness).provider.parseDetails(source), title([url]));
    expect(result).toMatchObject({ id: '501', kinopoiskFilmId: '326', rating: '8.3' });
  }
  const result = await page.evaluate(source => (window as Harness).provider.parseDetails(source), title([], '<span class="person-name-item" data-id="999" data-pid="326">Имя</span>'));
  expect(result.kinopoiskFilmId).toBeUndefined();
});

test('source help links are decoded locally once without following redirects or executing scripts', async ({ page }) => {
  const unexpected: string[] = [];
  await page.route('**/help/**', async route => { unexpected.push(route.request().url()); await route.abort(); });
  await page.route('https://**/*', async route => { unexpected.push(route.request().url()); await route.abort(); });
  const observed = '/help/aHR0cHMlM0ElMkYlMkZ3d3cua2lub3BvaXNrLnJ1JTJGZmlsbSUyRjMyNiUyRg==/';
  for (const url of [observed, origin + wrapped('https://www.kinopoisk.ru/film/326/')]) {
    const result = await page.evaluate(source => (window as Harness).provider.parseDetails(source), title([url], '<script>window.identityFixtureExecuted=true</script>'));
    expect(result.kinopoiskFilmId).toBe('326');
  }
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => (window as Harness).identityFixtureExecuted)).toBeUndefined();
});

test('unsafe, foreign, malformed and ambiguous rating links cannot identify a Kinopoisk title', async ({ page }) => {
  const unsafe = [
    'https://kinopoisk.ru.evil.example/film/326/', 'https://evil.example/film/326/',
    'https://user:password@www.kinopoisk.ru/film/326/', 'https://www.kinopoisk.ru:8443/film/326/',
    'https://www.kinopoisk.ru/film/326/?other=1', 'https://www.kinopoisk.ru/film/326/#other',
    'https://www.kinopoisk.ru/name/326/', 'https://www.kinopoisk.ru/film/0/',
    'https://www.kinopoisk.ru/film/0326/', 'https://www.kinopoisk.ru/film/1234567890123/',
    'https://www.kinopoisk.ru/film/15000001/', wrapped('https://www.kinopoisk.ru/film/15000001/'),
    'https://www.kinopoisk.ru/film/%33%32%36/', 'https://www.kinopoisk.ru/film/326/extra/',
    'https:\\www.kinopoisk.ru\\film\\326\\', 'javascript:alert(326)', '/film/326/',
    'https://evil.example' + wrapped('https://www.kinopoisk.ru/film/326/'),
    wrapped('https://evil.example/film/326/'), wrapped('javascript:alert(326)'),
    wrapped('https://www.kinopoisk.ru/film/326/?other=1'), wrapped('https://www.kinopoisk.ru/name/326/'),
    wrapped(origin + wrapped('https://www.kinopoisk.ru/film/326/')),
    '/help/!invalid-base64!/', '/help/' + Buffer.from('%INVALID').toString('base64') + '/',
    '/help/' + 'A'.repeat(2049) + '/', wrapped('https://www.kinopoisk.ru/film/326/') + '?next=1',
  ];
  const results = await page.evaluate(sources => sources.map(source => (window as Harness).provider.parseDetails(source).kinopoiskFilmId), unsafe.map(url => title([url])));
  expect(results).toEqual(unsafe.map(() => undefined));
  const unrelated = title([], `<aside class="kp">${link('https://www.kinopoisk.ru/film/326/')}</aside>`);
  const conflicting = title(['https://www.kinopoisk.ru/film/326/', 'https://www.kinopoisk.ru/film/377/']);
  for (const source of [unrelated, conflicting]) expect(await page.evaluate(source => (window as Harness).provider.parseDetails(source).kinopoiskFilmId, source)).toBeUndefined();
  const duplicate = title(['https://www.kinopoisk.ru/film/326/', wrapped('https://www.kinopoisk.ru/film/326/')]);
  expect(await page.evaluate(source => (window as Harness).provider.parseDetails(source).kinopoiskFilmId, duplicate)).toBe('326');
  expect(await page.evaluate(source => (window as Harness).provider.parseDetails(source).kinopoiskFilmId, title(['https://www.kinopoisk.ru/film/15000000/']))).toBe('15000000');
});

test('person identity preserves a real ISO birth date without deriving it from display text', async ({ page }) => {
  for (const value of ['1937-06-01', '1980-02-01', '2000-02-29', '1564-04-26']) {
    const result = await page.evaluate(source => (window as Harness).identityPeople.parsePerson(source), person(value));
    expect(result).toMatchObject({ name: 'Персона', originalName: 'Person', birthDate: value });
    expect(result.facts).toEqual([{ label: 'Дата рождения', value: '1 февраля, 1980 (46 лет)' }]);
  }
  const invalid = [undefined, '', '0000-01-01', '1900-02-29', '2025-02-29', '2026-04-31', '1980-13-01', '1980-00-01', '1980-02-00', '1980-02-32', '80-02-01', '1 февраля 1980', '1980-02-01T00:00:00Z'];
  for (const value of invalid) {
    const result = await page.evaluate(source => (window as Harness).identityPeople.parsePerson(source), person(value));
    expect(result.birthDate).toBeUndefined();
  }
  const unrelated = person(undefined, '<aside><time itemprop="birthDate" datetime="1980-02-01">Другой человек</time></aside>');
  expect(await page.evaluate(source => (window as Harness).identityPeople.parsePerson(source).birthDate, unrelated)).toBeUndefined();
});
