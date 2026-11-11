import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://favorite-edit.fixture.example';
const titleUrl = origin + '/films/drama/701-film.html';
const title = { id: '701', title: 'Фильм для коллекций', url: titleUrl, kind: 'film', poster: '' };
const catalog = `<div class="b-content__inline_item" data-id="701"><div class="b-content__inline_item-link"><a href="${titleUrl}">${title.title}</a></div></div>`;
type State = { names: Record<string, string>; selected: Record<string, boolean>; details: number; toggles: number; creates: number; authenticated: boolean; requests: SourceRequest[]; errors: string[]; external: string[] };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const document = (state: State) => `<meta property="og:type" content="video.movie"><div class="b-post__title"><h1>${title.title}</h1></div><div class="b-post__description_text">Проверка избранного.</div><div class="b-userset__fav_holder" data-post_id="701"></div><div class="b-translator__item active" data-translator_id="1" title="Студия"></div><div id="user-favorites-holder" data-post_id="701"><div id="user-favorites-list">${Object.entries(state.names).map(([id, name]) => `<div class="hd-label-row"><input class="user-fav-check" type="checkbox" value="${id}" ${state.selected[id] ? 'checked' : ''}><label>${escape(name)}<small>(<b>1</b>)</small></label></div>`).join('')}</div></div>`;
const reply = (route: Route, body: string, url = titleUrl) => route.fulfill({ json: { returnValue: true, source: { body, url } } });
const fail = (route: Route, errorText: string, errorCode?: string) => route.fulfill({ json: { returnValue: false, errorText, errorCode } });

async function fixture(page: Page, options: { authenticated?: boolean; mirror?: string; empty?: boolean; intercept?: (route: Route, query: SourceRequest, state: State) => Promise<boolean> } = {}) {
  const state: State = { names: options.empty ? {} : { '7': 'Смотреть позже', '8': 'Пересмотреть' }, selected: { '7': false, '8': true }, details: 0, toggles: 0, creates: 0, authenticated: options.authenticated ?? true, requests: [], errors: [], external: [] };
  await page.addInitScript(value => localStorage.setItem('rezzka.library.v1', JSON.stringify({ favorites: [value], history: [] })), title);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { state.external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: options.mirror ?? origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: state.authenticated, origin, ...(state.authenticated ? { username: 'fixture-user' } : {}) } } }); return; }
    if (method !== 'getSource') { await fail(route, 'Unexpected bridge method'); return; }
    const query = params; state.requests.push(query);
    if (query.operation === 'details') state.details++;
    if (query.operation === 'favoriteToggle') state.toggles++;
    if (query.operation === 'favoriteCreate') state.creates++;
    if (await options.intercept?.(route, query, state)) return;
    if (query.operation === 'details') { await reply(route, document(state)); return; }
    if (query.operation === 'favoriteToggle') {
      state.selected[query.collectionId] = !state.selected[query.collectionId];
      await reply(route, JSON.stringify({ success: true }), origin + '/ajax/favorites/'); return;
    }
    if (query.operation === 'favoriteCreate') {
      const id = String(8 + state.creates);
      state.names[id] = query.name; state.selected[id] = false;
      await reply(route, JSON.stringify({ success: true, id, name: query.name }), origin + '/ajax/favorites/'); return;
    }
    await reply(route, catalog, origin + '/');
  });
  await page.goto('/');
  return state;
}
const localData = (page: Page) => page.evaluate(() => localStorage.getItem('rezzka.library.v1'));
async function openPanel(page: Page) {
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('details-favorite')).toBeEnabled();
  await page.getByTestId('details-favorite').click();
  await expect(page.getByTestId('favorite-membership-7')).toBeEnabled();
}

test('account collections support confirmed add and remove without changing local favorites', async ({ page }) => {
  const state = await fixture(page);
  const before = await localData(page);
  await openPanel(page);
  await expect(page.getByTestId('details-favorite')).not.toHaveAttribute('aria-pressed');
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('favorite-membership-8')).toHaveAttribute('aria-checked', 'true');
  expect(state.toggles).toBe(0);
  await page.mouse.move(1919, 0);
  await page.getByTestId('favorite-membership-7').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Избранное обновлено.', { exact: true })).toBeVisible();
  expect(state.toggles).toBe(1);
  await page.getByTestId('favorite-membership-8').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-membership-8')).toHaveAttribute('aria-checked', 'false');
  expect(state.toggles).toBe(2);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('favorite-panel').locator('[data-focused="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-panel')).toHaveCount(0);
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('a pending update blocks duplicate toggles and closing without optimistic selection', async ({ page }) => {
  let pending: Route | undefined;
  const state = await fixture(page, { intercept: async (route, query) => {
    if (query.operation === 'favoriteToggle') { pending = route; return true; }
    return false;
  } });
  await openPanel(page);
  await page.getByTestId('favorite-membership-7').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => Boolean(pending)).toBe(true);
  expect(state.toggles).toBe(1);
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('favorite-membership-7')).toBeDisabled();
  await expect(page.getByTestId('favorite-membership-8')).toBeDisabled();
  await expect(page.getByTestId('favorite-panel-close')).toBeDisabled();
  await expect(page.getByText('Сохраняем изменения…', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-panel')).toBeVisible();
  state.selected['7'] = true;
  await reply(pending!, JSON.stringify({ success: true }), origin + '/ajax/favorites/');
  await expect(page.getByTestId('favorite-membership-7')).toBeEnabled();
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-panel')).toHaveCount(0);
  expect(state.toggles).toBe(1); expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('an unverified update disables further toggles until a read confirms the account state', async ({ page }) => {
  let verificationFails = true;
  const state = await fixture(page, { intercept: async (route, query, current) => {
    if (query.operation === 'favoriteToggle') {
      current.selected[query.collectionId] = true;
      await fail(route, 'Ответ потерян.'); return true;
    }
    if (query.operation === 'details' && current.toggles && verificationFails) { await fail(route, 'Проверка временно недоступна.'); return true; }
    return false;
  } });
  const before = await localData(page);
  await openPanel(page);
  await page.getByTestId('favorite-membership-7').click();
  await expect(page.getByRole('alert')).toContainText('Состояние избранного неизвестно');
  await expect(page.getByTestId('favorite-membership-7')).toBeDisabled();
  await expect(page.getByTestId('favorite-membership-8')).toBeDisabled();
  await expect(page.getByText('Избранное обновлено.', { exact: true })).toHaveCount(0);
  expect(state.toggles).toBe(1);
  verificationFails = false;
  await page.getByTestId('favorite-panel-reload').click();
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('favorite-membership-7')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.toggles).toBe(1); expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('a refused update displays the verified unchanged membership', async ({ page }) => {
  const state = await fixture(page, { intercept: async (route, query) => {
    if (query.operation === 'favoriteToggle') { await reply(route, JSON.stringify({ success: false, message: 'Коллекция недоступна.' }), origin + '/ajax/favorites/'); return true; }
    return false;
  } });
  await openPanel(page);
  await page.getByTestId('favorite-membership-7').click();
  await expect(page.getByRole('alert')).toContainText('Коллекция недоступна.');
  await expect(page.getByTestId('favorite-membership-7')).toBeEnabled();
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Избранное обновлено.', { exact: true })).toHaveCount(0);
  expect(state.toggles).toBe(1); expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('late description and membership reads cannot focus the background or reopen a closed panel', async ({ page }) => {
  const pending = new Map<number, Route>();
  const state = await fixture(page, { intercept: async (route, query, current) => {
    if (query.operation === 'details' && [1, 3].includes(current.details)) { pending.set(current.details, route); return true; }
    return false;
  } });
  await openPanel(page);
  await page.mouse.move(1919, 0);
  await page.getByTestId('favorite-membership-7').focus();
  await reply(pending.get(1)!, document(state));
  await page.waitForTimeout(100);
  await expect(page.getByTestId('favorite-membership-7')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('favorite-panel').locator('[data-focused="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => pending.has(3)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  await reply(pending.get(3)!, document(state));
  await page.waitForTimeout(100);
  await expect(page.getByTestId('favorite-panel')).toHaveCount(0);
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
  expect(state.toggles).toBe(0); expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('cancelled sign-in returns to favorites and a late description keeps that focus', async ({ page }) => {
  let pending: Route | undefined;
  const state = await fixture(page, { authenticated: false, intercept: async (route, query, current) => {
    if (query.operation === 'details' && current.details >= 2) { pending = route; return true; }
    return false;
  } });
  const before = await localData(page);
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('details-play')).toBeEnabled();
  for (const moveAway of [false, true]) {
    pending = undefined;
    await page.getByTestId('details-favorite').click();
    await expect(page.getByTestId('screen-auth')).toBeVisible();
    await page.getByTestId('auth-cancel').click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await expect(page.getByTestId('details-favorite')).toHaveAttribute('data-focused', 'true');
    await page.mouse.move(1919, 0);
    if (moveAway) {
      // While the description loads the card has one control, so the viewer can only move to the menu.
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('nav-catalog')).toHaveAttribute('data-focused', 'true');
    }
    await reply(pending!, document(state));
    await page.waitForTimeout(100);
    await expect(page.getByTestId(moveAway ? 'nav-catalog' : 'details-favorite')).toHaveAttribute('data-focused', 'true');
  }
  expect(state.toggles).toBe(0); expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('session expiry before an update opens login without sending the toggle', async ({ page }) => {
  let expire = false;
  const state = await fixture(page, { intercept: async (route, query, current) => {
    if (query.operation === 'details' && expire) {
      current.authenticated = false;
      await fail(route, 'Сессия истекла.', 'auth_required'); return true;
    }
    return false;
  } });
  const before = await localData(page);
  await openPanel(page); expire = true;
  await page.getByTestId('favorite-membership-7').click();
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.getByTestId('favorite-panel')).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(state.toggles).toBe(0); expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('demo favorites remain local and never open the account panel', async ({ page }) => {
  const state = await fixture(page, { mirror: '' });
  await page.getByTestId('demo-start').click();
  await page.getByTestId('title-last-0').click();
  await page.getByTestId('details-favorite').click();
  await expect(page.getByTestId('details-favorite')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('favorite-panel')).toHaveCount(0);
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('collection controls show a spaced create action and retry only after a read error', async ({ page }) => {
  let failRead = true;
  const state = await fixture(page, { intercept: async (route, query, current) => {
    if (query.operation === 'details' && current.details === 2 && failRead) { await fail(route, 'Списки временно недоступны.'); return true; }
    return false;
  } });
  await page.getByTestId('title-last-0').click();
  await page.getByTestId('details-favorite').click();
  await expect(page.getByRole('alert')).toContainText('Списки временно недоступны.');
  await expect(page.getByTestId('favorite-create-open')).toHaveCount(0);
  await expect(page.getByTestId('favorite-panel-reload')).toHaveText('Повторить загрузку');
  failRead = false;
  await page.mouse.move(1919, 0);
  await page.getByTestId('favorite-panel-reload').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-membership-7')).toBeEnabled();
  await expect(page.getByTestId('favorite-panel-reload')).toHaveCount(0);
  await expect(page.getByTestId('favorite-create-open')).toHaveText('Создать список');
  const gap = await page.getByTestId('favorite-create-open').evaluate(button => button.getBoundingClientRect().top - window.document.querySelector('[data-testid="favorite-membership-8"]')!.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThan(20);
  expect(state.creates).toBe(0); expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('an empty account can create its first list with the remote without adding the current film', async ({ page }) => {
  const state = await fixture(page, { empty: true });
  const before = await localData(page);
  await page.getByTestId('title-last-0').click();
  await page.getByTestId('details-favorite').click();
  await expect(page.getByText('Пока нет списков.', { exact: false })).toBeVisible();
  await page.mouse.move(1919, 0);
  await page.getByTestId('favorite-create-open').focus();
  await page.keyboard.press('Enter');
  const name = page.getByTestId('favorite-create-name');
  await expect(name.locator('..')).toHaveClass(/is-focused/);
  await page.keyboard.press('Enter');
  await expect(name).toBeFocused();
  await name.fill('  На выходные  ');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-create-submit')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('favorite-membership-9')).toHaveText('На выходные');
  await expect(page.getByTestId('favorite-membership-9')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('favorite-membership-9')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('favorite-create-form')).toHaveCount(0);
  expect(state.requests.filter(request => request.operation === 'favoriteCreate')).toEqual([{ operation: 'favoriteCreate', url: titleUrl, id: '701', name: 'На выходные' }]);
  expect(state.toggles).toBe(0); expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('creating a list blocks duplicate submission and closing until the source confirms it', async ({ page }) => {
  let pending: Route | undefined;
  const state = await fixture(page, { intercept: async (route, query) => {
    if (query.operation === 'favoriteCreate') { pending = route; return true; }
    return false;
  } });
  await openPanel(page);
  await page.getByTestId('favorite-create-open').click();
  await page.getByTestId('favorite-create-name').fill('Очередь');
  await page.getByTestId('favorite-create-submit').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.getByTestId('favorite-create-name')).toBeDisabled();
  await expect(page.getByTestId('favorite-create-cancel')).toBeDisabled();
  await expect(page.getByTestId('favorite-panel-close')).toBeDisabled();
  await expect(page.getByTestId('favorite-membership-7')).toBeDisabled();
  await expect(page.getByTestId('favorite-membership-9')).toHaveCount(0);
  await expect(page.getByText('Создаём список…', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-create-form')).toBeVisible();
  expect(state.creates).toBe(1);
  state.names['9'] = 'Очередь'; state.selected['9'] = false;
  await reply(pending!, JSON.stringify({ success: true, id: '9', name: 'Очередь' }), origin + '/ajax/favorites/');
  await expect(page.getByTestId('favorite-membership-9')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('favorite-membership-9')).toHaveAttribute('data-focused', 'true');
  expect(state.creates).toBe(1); expect(state.toggles).toBe(0);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('the creation form supports editing, validation, Cancel and Back without closing favorites', async ({ page }) => {
  const state = await fixture(page);
  await openPanel(page);
  await page.getByTestId('favorite-create-open').click();
  const name = page.getByTestId('favorite-create-name');
  await name.fill('AB');
  await page.keyboard.press('Backspace');
  await expect(name).toHaveValue('A');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('favorite-panel')).toBeVisible();
  await expect(page.getByTestId('favorite-create-form')).toHaveCount(0);
  await expect(page.getByTestId('favorite-create-open')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(name).toHaveValue('');
  await expect(page.getByTestId('favorite-create-submit')).toBeDisabled();
  await name.fill('x'.repeat(101));
  await expect(page.getByRole('alert')).toContainText('не больше 100 символов');
  await expect(page.getByTestId('favorite-create-submit')).toBeDisabled();
  await name.fill('Без отправки');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('favorite-create-submit')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('favorite-create-cancel').click();
  await expect(page.getByTestId('favorite-create-form')).toHaveCount(0);
  await expect(page.getByTestId('favorite-create-open')).toHaveAttribute('data-focused', 'true');
  expect(state.creates).toBe(0); expect(state.toggles).toBe(0);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('an uncertain creation offers only a read retry and never resubmits the old name', async ({ page }) => {
  let verificationFails = true;
  const state = await fixture(page, { intercept: async (route, query, current) => {
    if (query.operation === 'favoriteCreate') {
      current.names['9'] = query.name; current.selected['9'] = false;
      await fail(route, 'Ответ потерян.'); return true;
    }
    if (query.operation === 'details' && current.creates && verificationFails) { await fail(route, 'Проверка недоступна.'); return true; }
    return false;
  } });
  await openPanel(page);
  await page.getByTestId('favorite-create-open').click();
  await page.getByTestId('favorite-create-name').fill('Новый список');
  await page.getByTestId('favorite-create-submit').click();
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить создание');
  await expect(page.getByTestId('favorite-create-form')).toHaveCount(0);
  await expect(page.getByTestId('favorite-create-open')).toHaveCount(0);
  await expect(page.getByTestId('favorite-panel-reload')).toHaveText('Проверить списки');
  await expect(page.getByTestId('favorite-membership-7')).toBeDisabled();
  expect(state.creates).toBe(1);
  verificationFails = false;
  await page.getByTestId('favorite-panel-reload').click();
  await expect(page.getByTestId('favorite-membership-9')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('favorite-create-open')).toBeEnabled();
  await expect(page.getByTestId('favorite-panel-reload')).toHaveCount(0);
  await page.getByTestId('favorite-create-open').click();
  await expect(page.getByTestId('favorite-create-name')).toHaveValue('');
  expect(state.creates).toBe(1); expect(state.toggles).toBe(0);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('a creation refused by the source shows its error and does not add a local list', async ({ page }) => {
  const state = await fixture(page, { intercept: async (route, query) => {
    if (query.operation === 'favoriteCreate') { await reply(route, JSON.stringify({ success: false, message: 'Название занято.' }), origin + '/ajax/favorites/'); return true; }
    return false;
  } });
  const before = await localData(page);
  await openPanel(page);
  await page.getByTestId('favorite-create-open').click();
  await page.getByTestId('favorite-create-name').fill('Занято');
  await page.getByTestId('favorite-create-submit').click();
  await expect(page.getByRole('alert')).toContainText('Название занято.');
  await expect(page.getByTestId('favorite-create-form')).toHaveCount(0);
  await expect(page.getByTestId('favorite-membership-9')).toHaveCount(0);
  await expect(page.getByTestId('favorite-create-open')).toBeEnabled();
  await expect(page.getByText('Список создан.', { exact: true })).toHaveCount(0);
  expect(state.creates).toBe(1); expect(await localData(page)).toBe(before);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});
