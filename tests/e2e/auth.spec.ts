import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const mirror = 'https://auth.fixture.example';
const fixturePassword = 'fixture-password-only';
const loginPage = '<!doctype html><title>Вход на HDrezka</title><h1>Вход</h1><form><input name="login_name"><input type="password" name="login_password"></form>';
const titleUrl = mirror + '/films/drama/801-login.html';
const catalog = `<div class="b-content__inline_item" data-id="801"><div class="b-content__inline_item-link"><a href="${titleUrl}">После входа</a><div>2024, драма</div></div></div>`;
const detail = '<div class="b-post__title"><h1>После входа</h1></div><div class="b-userset__fav_holder" data-post_id="801"></div><div class="b-translator__item active" data-translator_id="1" title="Озвучка"></div>';

async function authSource(page: Page, options: { authenticated?: boolean; publicCatalog?: boolean; holdCatalog?: boolean; rejectLogin?: boolean; holdLogin?: boolean; expireDetails?: boolean } = {}) {
  const state = {
    authenticated: options.authenticated ?? false,
    publicCatalog: options.publicCatalog ?? false,
    holdCatalog: options.holdCatalog ?? false,
    rejectLogin: options.rejectLogin ?? false,
    holdLogin: options.holdLogin ?? false,
    expireDetails: options.expireDetails ?? false,
    loginCount: 0,
    logoutCount: 0,
    pendingCatalog: [] as Route[],
    pendingLogin: undefined as Route | undefined,
    external: [] as string[],
  };
  const session = () => ({ authenticated: state.authenticated, origin: mirror, ...(state.authenticated ? { username: 'fixture-user' } : {}) });
  const catalogReply = (route: Route) => route.fulfill({ json: { returnValue: true, source: { body: state.authenticated || state.publicCatalog ? catalog : loginPage, url: mirror + '/' } } });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { state.external.push(url.origin); await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest & { mirrorUrl?: string; username?: string; password?: string } };
    if (method === 'getSettings') {
      await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: mirror } } } });
    } else if (method === 'getSourceSession') {
      await route.fulfill({ json: { returnValue: true, session: session() } });
    } else if (method === 'sourceLogin') {
      state.loginCount++;
      expect(params.mirrorUrl).toBe(mirror);
      expect(params.username).toBe('fixture-user');
      expect(params.password).toBe(fixturePassword);
      if (state.rejectLogin) {
        state.rejectLogin = false;
        await route.fulfill({ json: { returnValue: false, errorCode: 'invalid_credentials', errorText: 'Неверный логин или пароль.' } });
      } else if (state.holdLogin) state.pendingLogin = route;
      else { state.authenticated = true; await route.fulfill({ json: { returnValue: true, session: session() } }); }
    } else if (method === 'sourceLogout') {
      state.logoutCount++;
      state.authenticated = false;
      await route.fulfill({ json: { returnValue: true, session: session() } });
    } else if (method === 'getSource') {
      if (params.operation === 'catalog' && state.holdCatalog) { state.pendingCatalog.push(route); return; }
      if (params.operation === 'details' && state.expireDetails) {
        state.authenticated = false;
        await route.fulfill({ json: { returnValue: false, errorCode: 'auth_required', errorText: 'Сессия истекла. Войдите снова.' } });
      } else if (params.operation === 'details') await route.fulfill({ json: { returnValue: true, source: { body: detail, url: titleUrl } } });
      else await catalogReply(route);
    } else await route.fulfill({ json: { returnValue: false, errorCode: 'unexpected_fixture_method', errorText: 'Неожиданный метод тестовой службы.' } });
  });
  return {
    state,
    releaseCatalog: async () => { state.holdCatalog = false; await Promise.all(state.pendingCatalog.splice(0).map(catalogReply)); },
    releaseLogin: async () => {
      state.holdLogin = false; state.authenticated = true;
      await state.pendingLogin!.fulfill({ json: { returnValue: true, session: session() } });
      state.pendingLogin = undefined;
    },
  };
}

test('startup checks the source before mounting the main UI and Back cannot bypass login', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as Window & { mainMountedBeforeLogin?: boolean };
    state.mainMountedBeforeLogin = false;
    new MutationObserver(() => { if (document.querySelector('.app-shell')) state.mainMountedBeforeLogin = true; }).observe(document, { childList: true, subtree: true });
  });
  const source = await authSource(page, { holdCatalog: true });
  await page.goto('/');
  await expect.poll(() => source.state.pendingCatalog.length).toBeGreaterThan(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByTestId('nav-catalog')).toHaveCount(0);
  await source.releaseCatalog();
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { mainMountedBeforeLogin?: boolean }).mainMountedBeforeLogin)).toBe(false);
  await expect(page.getByTestId('auth-username').locator('..')).toHaveClass(/is-focused/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.getByTestId('nav-catalog')).toHaveCount(0);
  await page.getByTestId('auth-change-source').click();
  await expect(page.getByTestId('settings-mirror')).toHaveValue(mirror);
  await expect(page.getByTestId('nav-catalog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(source.state.external).toEqual([]);
});

test('a failed login clears the password and success opens the catalog only after one submitted request', async ({ page }) => {
  const source = await authSource(page, { rejectLogin: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  const username = page.getByTestId('auth-username'), password = page.getByTestId('auth-password');
  await username.fill('fixture-user');
  await username.press('Enter');
  await expect(password.locator('..')).toHaveClass(/is-focused/);
  await page.keyboard.press('Enter');
  await expect(password).toBeFocused();
  await password.fill(fixturePassword);
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByTestId('auth-show-password').click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByRole('alert')).toHaveText('Неверный логин или пароль.');
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(page.getByTestId('nav-catalog')).toHaveCount(0);
  await expect(username).toHaveValue('fixture-user');

  source.state.holdLogin = true;
  await password.fill(fixturePassword);
  await page.getByTestId('auth-submit').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => Boolean(source.state.pendingLogin)).toBe(true);
  await expect(page.getByTestId('auth-submit')).toBeDisabled();
  await expect(password).toHaveValue('');
  expect(source.state.loginCount).toBe(2);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await source.releaseLogin();
  await expect(page.getByTestId('title-last-0')).toContainText('После входа');
  await expect(page.getByTestId('screen-auth')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(fixturePassword);
  // The mock service retains its session while the frontend reloads, like the
  // private service cookie store; no credentials are resubmitted by the client.
  await page.reload();
  await expect(page.getByTestId('title-last-0')).toContainText('После входа');
  await expect(page.getByTestId('screen-auth')).toHaveCount(0);
  expect(source.state.loginCount).toBe(2);
  expect(source.state.external).toEqual([]);
  expect(errors).toEqual([]);
});

test('session expiry from a title replaces the mounted interface with login', async ({ page }) => {
  const source = await authSource(page, { authenticated: true, expireDetails: true });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.getByTestId('screen-details')).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  expect(source.state.external).toEqual([]);
});

test('signing out of a restricted source removes the catalog and stays signed out after reload', async ({ page }) => {
  const source = await authSource(page, { authenticated: true });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-signout')).toBeEnabled();
  await page.getByTestId('settings-signout').click();
  // Signing out is confirmed first; Back or «Отмена» leaves the session alone.
  await expect(page.getByTestId('settings-confirm-signout-cancel')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-confirm-signout')).toHaveCount(0);
  expect(source.state.logoutCount).toBe(0);
  await page.getByTestId('settings-signout').click();
  await page.getByTestId('settings-confirm-signout-ok').click();
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByTestId('title-last-0')).toHaveCount(0);
  expect(source.state.logoutCount).toBe(1);
  expect(source.state.authenticated).toBe(false);
  await page.reload();
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.getByTestId('nav-catalog')).toHaveCount(0);
  expect(source.state.loginCount).toBe(0);
  expect(source.state.external).toEqual([]);
});

test('Back cannot close voluntary login while the service is creating its session', async ({ page }) => {
  const source = await authSource(page, { publicCatalog: true, holdLogin: true });
  await page.goto('/');
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-signin').click();
  await expect(page.getByTestId('auth-cancel')).toBeVisible();
  await page.getByTestId('auth-username').fill('fixture-user');
  await page.getByTestId('auth-password').fill(fixturePassword);
  await page.getByTestId('auth-submit').click();
  await expect.poll(() => Boolean(source.state.pendingLogin)).toBe(true);
  await expect(page.getByTestId('auth-cancel')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-auth')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await source.releaseLogin();
  await expect(page.getByTestId('title-last-0')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-signout')).toBeVisible();
  await expect(page.getByTestId('settings-signout')).toContainText('fixture-user');
  expect(source.state.loginCount).toBe(1);
  expect(source.state.external).toEqual([]);
});
