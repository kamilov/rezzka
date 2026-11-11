import {expect, test, type Page} from '@playwright/test';
import {defaultSettings} from '../../shared/settings';

async function setup(page: Page, login = false) {
  const errors: string[] = [];
  const mirror = 'https://keyboard.fixture.example';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const {method} = route.request().postDataJSON();
    if (method === 'getSettings') {
      await route.fulfill({json: {returnValue: true, settings: {revision: 1, values: {...defaultSettings, mirrorUrl: login ? mirror : ''}}}});
    } else if (method === 'getSourceSession') {
      await route.fulfill({json: {returnValue: true, session: {authenticated: false, origin: mirror}}});
    } else if (method === 'getSource' && login) {
      await route.fulfill({json: {returnValue: false, errorCode: 'auth_required', errorText: 'Войдите в аккаунт.'}});
    } else throw new Error(`Unexpected keyboard fixture method: ${method}`);
  });
  await page.goto('/');
  if (login) await expect(page.getByTestId('auth-username').locator('..')).toHaveClass(/is-focused/);
  else {
    await expect(page.getByTestId('configure-source')).toHaveAttribute('data-focused', 'true');
    await page.getByTestId('configure-source').click();
    await expect(page.getByTestId('settings-mirror').locator('..')).toHaveClass(/is-focused/);
  }
  return errors;
}

test('crossing buttons and fields with the pointer keeps text input through keyboard and voice UI changes', async ({page}) => {
  const errors = await setup(page, true);
  const username = page.getByTestId('auth-username');
  await username.click();
  await expect(username).toBeFocused();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('keyboardStateChange', {detail: {visibility: true}})));
  for (const id of ['auth-password', 'auth-show-password', 'auth-submit']) {
    await page.getByTestId(id).hover();
    await expect(username).toBeFocused();
    await expect(username.locator('..')).toHaveClass(/is-focused/);
  }
  // LG hides the keyboard when its voice interface opens. This is not Done.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('keyboardStateChange', {detail: {visibility: false}})));
  await page.getByTestId('auth-change-source').hover();
  await expect(username).toBeFocused();
  await page.keyboard.insertText('Ввод продолжается');
  await expect(username).toHaveValue('Ввод продолжается');
  expect(errors).toEqual([]);
});

test('arrows keep editing and preserve native default behavior until Done or Back', async ({page}) => {
  const errors = await setup(page);
  const input = page.getByTestId('settings-mirror');
  await input.click();
  await input.fill('https://example.test');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    const prevented = await input.evaluate((element, key) => {
      const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
      element.dispatchEvent(event); return event.defaultPrevented;
    }, key);
    expect(prevented).toBe(false);
    await expect(input).toBeFocused();
  }
  await page.getByTestId('settings-save').hover();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).not.toBeFocused();
  await expect(page.getByTestId('settings-save')).toBeVisible();
  // The section's own name: hovering another one would open that section and take the field away.
  await page.getByTestId('settings-tab-source').hover();
  await expect(page.getByTestId('settings-tab-source')).toHaveAttribute('data-focused', 'true');
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).not.toBeFocused();
  await page.getByTestId('settings-save').hover();
  await expect(page.getByTestId('settings-save')).toHaveAttribute('data-focused', 'true');
  expect(errors).toEqual([]);
});

test('explicit clicks can change fields or leave the editing screen without a stuck hover lock', async ({page}) => {
  const errors = await setup(page, true);
  const username = page.getByTestId('auth-username'), password = page.getByTestId('auth-password');
  await username.click();
  await expect(username).toBeFocused();
  await password.click();
  await expect(password).toBeFocused();
  await expect(password.locator('..')).toHaveClass(/is-focused/);
  await page.getByTestId('auth-change-source').click();
  await expect(page.getByTestId('screen-auth')).toHaveCount(0);
  await expect(page.getByTestId('settings-mirror')).toBeVisible();
  await page.getByTestId('settings-tab-playback').hover();
  await expect(page.getByTestId('settings-tab-playback')).toHaveAttribute('data-focused', 'true');
  expect(errors).toEqual([]);
});

test('a pending focus synchronization cannot reopen the previous input after an immediate field change', async ({page}) => {
  const errors = await setup(page, true);
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('[data-testid="auth-password"]')!.focus();
    document.querySelector<HTMLInputElement>('[data-testid="auth-username"]')!.focus();
  });
  await expect(page.getByTestId('auth-username')).toBeFocused();
  await expect(page.getByTestId('auth-username').locator('..')).toHaveClass(/is-focused/);
  await page.getByTestId('auth-password').hover();
  await page.keyboard.insertText('Остался здесь');
  await expect(page.getByTestId('auth-username')).toHaveValue('Остался здесь');
  await expect(page.getByTestId('auth-password')).toHaveValue('');
  expect(errors).toEqual([]);
});
