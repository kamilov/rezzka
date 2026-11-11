import { test, expect, type Page } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';

const origin = 'https://scroll.fixture.example';
const cards = Array.from({ length: 40 }, (_, index) => `<div class="b-content__inline_item" data-id="${100 + index}"><div class="b-content__inline_item-link"><a href="/films/drama/${100 + index}-fixture.html">Фильм ${index + 1}</a></div><i class="b-category-bestrating">8.3</i></div>`).join('');
const filters = '<select class="select-category"><option value="/films/best/">Все жанры</option><option value="/films/best/drama/">Драма</option></select><select class="select-year"><option value="0">Все годы</option><option value="2026">2026</option></select>';

async function browse(page: Page, openBrowse = true, authenticated = false) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort(); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON();
    if (method === 'getSettings') {
      await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return;
    }
    if (method === 'getSourceSession') {
      await route.fulfill({ json: { returnValue: true, session: { authenticated, origin } } }); return;
    }
    if (params.operation === 'continue') {
      await route.fulfill({ json: { returnValue: true, source: { url: origin + '/continue/', body: '<div id="videosaves-list" class="b-videosaves__list"><p>Вы ещё ничего не сохраняли.</p></div>' } } }); return;
    }
    await route.fulfill({ json: { returnValue: true, source: { url: origin + '/', body: params.operation === 'browse' ? filters + cards : cards } } });
  });
  await page.goto('/');
  // The app opens with focus on the first thing to watch, not on the menu.
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await page.mouse.move(1919, 0);
  if (openBrowse) {
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('nav-catalog')).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('browse-title-39')).toBeAttached();
    await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  }
}

const rem = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
// The menu is a narrow rail that opens to show its labels only while focus is in it.
async function openMenu(page: Page, id: string) {
  await expect(page.getByTestId(id)).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('.sidebar [data-focused="true"]')).toHaveCount(1);
  const unit = await rem(page);
  await expect.poll(() => page.getByTestId(id).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(14.9 * unit);
  await expect(page.getByTestId(id).locator('.nav-label')).toBeVisible();
}
async function closedMenu(page: Page) {
  await expect(page.locator('.sidebar [data-focused="true"]')).toHaveCount(0);
  const unit = await rem(page);
  await expect.poll(() => page.getByTestId('nav-catalog').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(3.9 * unit);
}

// The poster grows and gets a ring when focused, so its painted edge reaches past its box: it must not slide under the top bar.
async function clearOfHeader(page: Page, id: string) {
  await expect.poll(() => page.getByTestId(id).evaluate(card => {
    const poster = card.querySelector('.poster-image')!.getBoundingClientRect(), bar = document.querySelector('.topbar')!.getBoundingClientRect();
    const ring = 0.2 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Math.round(poster.top - ring - bar.bottom);
  })).toBeGreaterThanOrEqual(0);
}

test('Up walks back through offscreen lines of a grid and from the first line reaches the chosen filter at the start of the page', async ({ page }) => {
  await browse(page);
  const main = page.getByTestId('screen-browse');
  const scroll = () => main.evaluate(element => element.scrollTop);
  await page.getByTestId('browse-title-0').focus();
  await clearOfHeader(page, 'browse-title-0');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('browse-title-7')).toHaveAttribute('data-focused', 'true');
  await clearOfHeader(page, 'browse-title-7');
  await page.keyboard.press('ArrowUp');
  await clearOfHeader(page, 'browse-title-0');
  // The first line of cards keeps its place at the start of the page.
  await expect.poll(scroll).toBe(0);
  await page.getByTestId('browse-title-38').focus();
  await expect.poll(scroll).toBeGreaterThan(1000);
  for (const index of [31, 24, 17, 10, 3]) {
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId(`browse-title-${index}`)).toHaveAttribute('data-focused', 'true');
    // The focused line of cards is never left half hidden under the page's top bar.
    await expect(page.getByTestId(`browse-title-${index}`)).toBeInViewport({ ratio: 1 });
    await clearOfHeader(page, `browse-title-${index}`);
  }
  // The chosen filter, not the one that happens to be above the fourth column.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  await expect.poll(scroll).toBe(0);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('.sidebar [data-focused="true"]')).toHaveCount(0);
});

test('Left from the first control of a line opens the menu on the current section and Right returns to where the viewer was', async ({ page }) => {
  await browse(page, false);
  await closedMenu(page);
  // Along a row Left and Right move between its cards.
  for (const index of [1, 2, 3]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId(`title-last-${index}`)).toHaveAttribute('data-focused', 'true');
  }
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('title-last-2')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight');
  // The next row starts from its beginning; the cards of the first row that slid under the menu do not catch Left.
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('title-popular-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-catalog');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('title-popular-0')).toHaveAttribute('data-focused', 'true');
  await closedMenu(page);
  // Up returns to the card the row above was left on, not to a filter in the pinned top bar.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('title-last-3')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('filter-0')).toHaveAttribute('data-focused', 'true');
});

test('Right at the end of a row stays on its last card', async ({ page }) => {
  await browse(page, false);
  await page.getByTestId('title-last-39').focus();
  await expect(page.getByTestId('title-last-39')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('title-last-39')).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('title-last-39')).toHaveAttribute('data-focused', 'true');
});

test('Right from the menu restores the scrolled card and ignores hidden content after switching sections', async ({ page }) => {
  await browse(page);
  await page.getByTestId('browse-title-35').focus();
  await expect.poll(() => page.getByTestId('screen-browse').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  await closedMenu(page);
  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-browse');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('browse-title-35')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('browse-title-35')).toBeInViewport({ ratio: 1 });

  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-browse');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-catalog')).toBeVisible();
  // A section opens with focus in its content.
  await expect(page.getByTestId('title-last-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-catalog');
  await page.keyboard.press('ArrowRight');
  const current = page.getByTestId('screen-catalog').locator('[data-focused="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toBeVisible();
  await expect(page.getByTestId('browse-title-35')).not.toHaveAttribute('data-focused', 'true');
  await closedMenu(page);
});

test('an empty section keeps focus on its tabs and still lets the viewer reach the menu', async ({ page }) => {
  await browse(page, false, true);
  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-catalog');
  await page.getByTestId('nav-library').focus();
  await page.keyboard.press('Enter');
  const main = page.getByTestId('screen-library');
  await expect(main.getByText('Вы пока ничего не смотрели')).toBeVisible();
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowLeft');
  await openMenu(page, 'nav-library');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('mine-tab-continue')).toHaveAttribute('data-focused', 'true');
  await closedMenu(page);
});

test('Back returns a scrolled section to its start, then goes to the menu', async ({ page }) => {
  await browse(page);
  const main = page.getByTestId('screen-browse');
  await page.getByTestId('browse-title-35').focus();
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  await page.keyboard.press('Escape');
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await openMenu(page, 'nav-browse');
  // In a browser there is no system exit dialog to hand over to: focus simply stays in the menu.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nav-browse')).toHaveAttribute('data-focused', 'true');
});

test('Up reveals the start of the page after wheel scrolling and leaves dialog navigation alone', async ({ page }) => {
  await browse(page);
  const main = page.getByTestId('screen-browse');
  await page.getByTestId('browse-type-films').focus();
  await main.evaluate(element => { element.scrollTop = 180; });
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByTestId('browse-type-films')).toHaveAttribute('data-focused', 'true');

  await page.getByTestId('browse-genre').click();
  await expect(page.getByTestId('browse-genre-option-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('browse-filter-close')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browse-genre')).toHaveAttribute('data-focused', 'true');
});
