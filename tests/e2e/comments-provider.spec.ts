import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Comments from '../../src/provider-comments';
import type * as Provider from '../../src/provider';
import type { SourceDocument, SourceRequest, TitleSummary } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & {
  comments: typeof Comments; provider: typeof Provider; commentsFixtureExecuted?: boolean;
  pendingComments?: Promise<unknown>; authEvents?: number;
};
const origin = 'https://mirror.example';
const title: TitleSummary = { id: '701', url: origin + '/films/drama/701-first.html', title: 'Первый фильм', kind: 'film', poster: '' };
const navigation = (page: number, next?: number) => `<div class="b-navigation"><span>${page}</span>${next ? `<a href="javascript:void(0)" onclick="sof.comments.loadComments(701, ${next}, false, 0); return false;"><span class="b-navigation__next i-sprt">&nbsp;</span></a>` : '<span class="no-page"><span class="b-navigation__next i-sprt">&nbsp;</span></span>'}</div>`;
const source = (comments: string, page = 1, nav = navigation(page)): SourceDocument => ({
  body: JSON.stringify({ comments, navigation: nav, last_update_id: '123' }),
  url: origin + `/ajax/get_comments/?t=1&news_id=701&cstart=${page}&type=0&comment_id=0&skin=hdrezka`,
});
const fixture = async () => readFile(new URL('../fixtures/provider/comments.html', import.meta.url), 'utf8');
const reply = (route: Route, value: SourceDocument) => route.fulfill({ json: { returnValue: true, source: value } });
const parse = (page: Page, value: SourceDocument, number = 1) => page.evaluate(({ value, title, number }) => (window as HarnessWindow).comments.parseComments(value, title, number), { value, title, number });
test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as HarnessWindow).provider));
  await page.evaluate(async () => {
    const modulePath = '/src/provider-comments.ts';
    (window as HarnessWindow).comments = await import(/* @vite-ignore */ modulePath) as typeof Comments;
  });
});

test('comments preserve nested text and spoilers, isolate reply metadata, and discard executable media markup', async ({ page }) => {
  const result = await parse(page, source(await fixture(), 1, navigation(1, 2)));
  expect(result.items.map(({ id, author, date, parentId, indent, likes }) => ({ id, author, date, parentId, indent, likes }))).toEqual([
    { id: '91', author: 'Первый автор', date: 'Сегодня, 12:00', parentId: undefined, indent: 0, likes: 12 },
    { id: '92', author: 'Автор ответа', date: 'Сегодня, 13:00', parentId: '91', indent: 1, likes: -2 },
    { id: '93', author: 'Третий автор', date: 'Вчера', parentId: undefined, indent: 0, likes: undefined },
  ]);
  expect(result.items[0].avatar).toBe(origin + '/avatars/91.jpg'); expect(result.items[1].avatar).toBeUndefined();
  expect(result.items[0].content).toEqual([
    { kind: 'text', text: 'Начало ' }, { kind: 'bold', children: [{ kind: 'text', text: 'жирный ' }, { kind: 'italic', children: [{ kind: 'text', text: 'курсив' }] }] },
    { kind: 'break' }, { kind: 'underline', children: [{ kind: 'text', text: 'подчёркнутый' }] }, { kind: 'text', text: ' и ' },
    { kind: 'strike', children: [{ kind: 'text', text: 'зачёркнутый' }] },
    { kind: 'spoiler', children: [{ kind: 'text', text: 'Секрет ' }, { kind: 'bold', children: [{ kind: 'text', text: 'внутри ' }, { kind: 'italic', children: [{ kind: 'text', text: 'спойлера' }] }] }, { kind: 'spoiler', children: [{ kind: 'text', text: 'Ещё тайна' }] }] },
    { kind: 'text', text: ' безопасная ссылка' },
  ]);
  expect(result.nextPage).toBe(2); expect(result.total).toBeUndefined();
  expect(await page.evaluate(() => (window as HarnessWindow).commentsFixtureExecuted)).toBeUndefined();
});

test('pagination reads only matching literal calls, stops on the last page, and deduplicates comment IDs', async ({ page }) => {
  const html = await fixture();
  expect((await parse(page, source(html + html, 1, navigation(1, 2)))).items).toHaveLength(3);
  expect((await parse(page, source(html, 2), 2)).nextPage).toBeUndefined();
  for (const nav of [navigation(1, 2).replace('loadComments(701,', 'loadComments(702,'), navigation(1, 2).replace('return false;', 'window.commentsFixtureExecuted=true;'), navigation(1, 3), '<div class="b-navigation"><span>1</span><span class="no-page"><a onclick="sof.comments.loadComments(701,2,false,0);">2</a></span></div>']) {
    expect((await parse(page, source(html, 1, nav))).nextPage).toBeUndefined();
  }
  expect(await page.evaluate(() => (window as HarnessWindow).commentsFixtureExecuted)).toBeUndefined();
});

test('explicit empty JSON is terminal while wrong pages, incomplete rows, login and malformed payloads remain errors', async ({ page }) => {
  expect(await parse(page, source('', 1, ''))).toEqual({ items: [] });
  expect(await parse(page, source('', 3, '<div class="b-navigation"><a onclick="sof.comments.loadComments(701,2,false,0);">2</a></div>'), 3)).toEqual({ items: [] });
  const html = await fixture(), valid = source(html);
  const errors: Array<[SourceDocument, number, string]> = [
    [{ ...valid, body: '<h1>Вход</h1><input name="login_name"><input name="login_password">' }, 1, 'authentication'],
    [{ ...valid, body: '<title>Just a moment</title><div id="challenge-form"></div>' }, 1, 'challenge'],
    [{ ...valid, body: JSON.stringify({ success: false, message: 'Необходимо войти в аккаунт.' }) }, 1, 'authentication'],
    [{ ...valid, body: JSON.stringify({ success: false, message: 'Временно недоступно' }) }, 1, 'unavailable'],
    [{ ...valid, body: '{}' }, 1, 'markup'], [source('<h1>Сервис недоступен</h1>'), 1, 'markup'],
    [source(html.replace('<span class="name">Первый автор</span>', '')), 1, 'markup'],
    [source(html, 2, navigation(1, 2)), 2, 'markup'], [source('', 1, navigation(1, 2)), 1, 'markup'],
    [{ ...valid, url: valid.url.replace('news_id=701', 'news_id=702') }, 1, 'markup'],
    [{ ...valid, url: valid.url.replace(origin, 'https://another.example') }, 1, 'markup'],
  ];
  for (const [value, number, expected] of errors) expect(await page.evaluate(({ value, title, number }) => {
    try { (window as HarnessWindow).comments.parseComments(value, title, number); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, { value, title, number })).toBe(expected);
});

test('loadComments forwards only the selected title and page and propagates authentication to the existing gate', async ({ page }) => {
  const requests: SourceRequest[] = [], html = await fixture();
  await page.route('**/__bridge', async route => {
    const { method, params } = route.request().postDataJSON(); expect(method).toBe('getSource'); requests.push(params);
    if (params.page === 3) { await route.fulfill({ json: { returnValue: false, errorCode: 'auth_required', errorText: 'Источник требует входа.' } }); return; }
    await reply(route, source(html, params.page, navigation(params.page, params.page === 1 ? 2 : undefined)));
  });
  const result = await page.evaluate(async title => {
    const state = window as HarnessWindow; state.authEvents = 0;
    state.provider.subscribeToSourceAuth(() => { state.authEvents!++; });
    await state.comments.loadComments(title); await state.comments.loadComments(title, 2);
    try { await state.comments.loadComments(title, 3); return { code: 'no-error', events: state.authEvents }; }
    catch (error) { return { code: (error as { code: string }).code, events: state.authEvents }; }
  }, title);
  expect(requests).toEqual([1, 2, 3].map(page => ({ operation: 'comments', url: title.url, id: title.id, page })));
  expect(result).toEqual({ code: 'auth_required', events: 1 });
});

test('a late comments response from an obsolete source generation is rejected without another request', async ({ page }) => {
  const requests: SourceRequest[] = []; let pending: Route | undefined;
  await page.route('**/__bridge', async route => { requests.push(route.request().postDataJSON().params); pending = route; });
  await page.evaluate(title => { const state = window as HarnessWindow; state.pendingComments = state.comments.loadComments(title).then(() => 'accepted', error => error.message); }, title);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(() => (window as HarnessWindow).provider.resetProviderSession());
  await reply(pending!, source(await fixture()));
  expect(await page.evaluate(() => (window as HarnessWindow).pendingComments)).toContain('Сессия источника изменилась');
  expect(requests).toHaveLength(1);
});
