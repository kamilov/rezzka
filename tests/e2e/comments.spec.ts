import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://comments.fixture.example';
type CommentsRequest = Extract<SourceRequest, { operation: 'comments' }>;
const address = (id = '701') => `${origin}/films/drama/${id}-fixture.html`;
const card = (id: string) => `<div class="b-content__inline_item" data-id="${id}"><div class="b-content__inline_item-link"><a href="${address(id)}">Фильм ${id}</a></div><i class="b-category-bestrating">8.3</i></div>`;
const row = (id: number, text = `Текст комментария ${id}`, indent = 0) => `<li class="comments-tree-item" data-id="${id}" data-indent="${indent}"><div id="comment-id-${id}"><div class="b-comment"><span class="name">Автор ${id}</span><span class="date">Сегодня, 12:00</span><div class="text"><div>${text}</div></div></div></div></li>`;
const reply = (route: Route, query: CommentsRequest, rows: string, nextPage?: number) => route.fulfill({ json: { returnValue: true, source: {
  url: `${origin}/ajax/get_comments/?news_id=${query.id}&cstart=${query.page}&type=0&comment_id=0&skin=hdrezka&t=1`,
  body: JSON.stringify({ comments: rows ? `<ol class="comments-tree-list">${rows}</ol>` : '', navigation: nextPage ? `<div class="b-navigation"><span>${query.page}</span><a href="javascript:void(0)" onclick="sof.comments.loadComments(${query.id}, ${nextPage}, false, 0); return false;">${nextPage}</a></div>` : '', last_update_id: '100' }),
} } });
const fail = (route: Route, errorText: string) => route.fulfill({ json: { returnValue: false, errorText } });

async function fixture(page: Page, handler: (route: Route, query: CommentsRequest) => Promise<void>) {
  const requests: CommentsRequest[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    expect(method).toBe('getSource');
    if (params.operation === 'comments') { requests.push(params); await handler(route, params); return; }
    if (params.operation === 'catalog') { await route.fulfill({ json: { returnValue: true, source: { url: origin + '/', body: card('701') + card('702') } } }); return; }
    if (params.operation === 'details') { await route.fulfill({ json: { returnValue: true, source: { url: params.url, body: '<div class="b-post__title"><h1>Фильм для обсуждения</h1></div><div class="b-post__description_text">Описание фильма.</div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div>' } } }); return; }
    await fail(route, 'Unexpected source request');
  });
  await page.goto('/');
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.mouse.move(1919, 0);
  return { requests, errors, external };
}

test('comments load when their panel opens and spoilers remain absent until explicitly opened', async ({ page }) => {
  const mocked = await fixture(page, (route, query) => reply(route, query, row(91, 'Открытый <b>жирный</b> текст.<br>Вторая строка. <span class="text_spoiler">Скрытый финал <i>истории</i></span> &lt;img src=x&gt;')));
  expect(mocked.requests).toEqual([]);
  await page.getByTestId('details-comments').click();
  await expect(page.getByTestId('comment-91')).toContainText('Автор 91');
  await expect(page.getByTestId('comment-91').locator('strong')).toHaveText('жирный');
  await expect(page.getByTestId('comment-91')).toContainText('<img src=x>');
  await expect(page.getByTestId('comments-panel').locator('img, input, textarea, form')).toHaveCount(0);
  await expect(page.getByText('Скрытый финал', { exact: false })).toHaveCount(0);
  const spoiler = page.getByRole('button', { name: 'Показать спойлер', exact: true });
  await spoiler.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('comment-91')).toContainText('Скрытый финал истории');
  await expect(page.getByRole('button', { name: 'Скрыть спойлер', exact: true })).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Скрытый финал', { exact: false })).toHaveCount(0);
  // Closing the panel keeps what was loaded: opening it again asks the source for nothing.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-discussion-sheet')).toBeHidden();
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('comment-91')).toBeVisible();
  expect(mocked.requests).toHaveLength(1);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('remote scrolling and pagination preserve comments through a failed page and retry', async ({ page }) => {
  let pending: { route: Route; query: CommentsRequest } | undefined, attempts = 0;
  const initial = Array.from({ length: 8 }, (_, index) => row(91 + index, index ? `Комментарий ${index}.<br>Вторая строка.<br>Третья строка.` : Array.from({ length: 60 }, (_, line) => `Строка ${line}`).join('<br>'))).join('');
  const mocked = await fixture(page, async (route, query) => {
    if (query.page === 1) { await reply(route, query, initial, 2); return; }
    if (attempts++ === 0) { pending = { route, query }; return; }
    await reply(route, query, row(98) + row(99) + row(100));
  });
  await page.getByTestId('details-comments').click();
  const first = page.getByTestId('comment-91');
  await first.focus(); await page.keyboard.press('ArrowDown');
  await expect(first).toHaveAttribute('data-focused', 'true');
  await expect.poll(() => first.locator('.comment-body').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => first.locator('.comment-body').evaluate(element => element.scrollTop)).toBe(0);
  await page.getByTestId('comment-97').focus();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('comment-98').focus();
  expect(mocked.requests.filter(request => request.page === 2)).toHaveLength(1);
  await fail(pending!.route, 'Ошибка следующей страницы.');
  await expect(page.getByTestId('comments-panel').getByRole('alert')).toContainText('Ошибка следующей страницы.');
  await expect(page.locator('.comment-card')).toHaveCount(8);
  await page.getByTestId('comments-retry').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.comment-card')).toHaveCount(10);
  await expect(page.getByTestId('comment-99')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('comments-retry')).toHaveCount(0);
  await expect(page.getByTestId('comments-panel').locator('.load-more-trigger')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Показать ещё|Загрузить ещё/ })).toHaveCount(0);
  expect(mocked.requests.map(request => request.page)).toEqual([1, 2, 2]);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('a late comment response cannot move focus into a closed panel or replace another title', async ({ page }) => {
  let pending: { route: Route; query: CommentsRequest } | undefined;
  const mocked = await fixture(page, async (route, query) => {
    if (query.id === '701') { pending = { route, query }; return; }
    await reply(route, query, row(102, 'Обсуждение второго фильма.'));
  });
  await page.getByTestId('details-comments').click();
  await expect(page.getByTestId('comments-panel').getByRole('status')).toContainText('Загружаем комментарии');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await page.getByTestId('title-last-1').click();
  await expect(page.getByTestId('details-play')).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.getByTestId('details-comments').click();
  await expect(page.getByTestId('comment-102')).toContainText('Обсуждение второго фильма.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  const response = page.waitForResponse(item => item.url().endsWith('/__bridge') && item.request().postDataJSON()?.params?.operation === 'comments' && item.request().postDataJSON()?.params?.id === '701');
  await reply(pending!.route, pending!.query, row(91, 'Устаревшее обсуждение.'));
  await (await response).finished();
  await page.waitForTimeout(80);
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('comment-91')).toHaveCount(0);
  await expect(page.getByTestId('comment-102')).toContainText('Обсуждение второго фильма.');
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});

test('an initial error stays distinct from empty comments and a late retry respects the closed panel', async ({ page }) => {
  let pending: { route: Route; query: CommentsRequest } | undefined, attempts = 0;
  const mocked = await fixture(page, async (route, query) => {
    if (attempts++ === 0) { await fail(route, 'Не удалось прочитать обсуждение.'); return; }
    pending = { route, query };
  });
  await page.getByTestId('details-comments').click();
  await expect(page.getByTestId('comments-panel').getByRole('alert')).toContainText('Не удалось прочитать обсуждение.');
  await expect(page.getByText('Комментариев пока нет.', { exact: true })).toHaveCount(0);
  await page.getByTestId('comments-retry').focus(); await page.keyboard.press('Enter');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  await reply(pending!.route, pending!.query, '');
  await page.waitForTimeout(80);
  await expect(page.getByTestId('details-comments')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('details-discussion-sheet')).toBeHidden();
  await page.getByTestId('details-comments').click();
  await expect(page.getByText('Комментариев пока нет.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('comments-retry')).toHaveCount(0);
  expect(mocked.requests).toHaveLength(2);
  expect(mocked.errors).toEqual([]); expect(mocked.external).toEqual([]);
});
