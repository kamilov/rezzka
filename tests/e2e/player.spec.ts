import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings, type Settings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

const origin = 'https://player-fixture.example';
const titleUrl = origin + '/series/901-fixture.html';
const episodeHtml = (ids = ['1', '2']) => '<ul class="b-simple_episodes__list" id="simple-episodes-list-1">' + ids.map(id => `<li class="b-simple_episode__item" data-episode_id="${id}">Серия ${id}</li>`).join('') + '</ul>';
const catalogHtml = '<div class="b-content__inline_items"><div class="b-content__inline_item" data-id="901"><span class="cat series"><i class="entity">Сериал</i></span><div class="b-content__inline_item-link"><a href="/series/901-fixture.html">Проверка плеера</a><div>2025, Россия, фантастика</div></div></div></div>';
const detailsHtml = '<meta property="og:type" content="video.tv_show"><div class="b-post__title"><h1>Проверка плеера</h1></div><div class="b-post__description_text">Локальный синтетический ролик.</div><div class="b-userset__fav_holder" data-post_id="901"></div>'
  + ['1', '2', '3', '4'].map(id => `<div class="b-translator__item ${id === '1' ? 'active' : ''} ${id === '4' ? 'b-prem_translator' : ''}" data-translator_id="${id}" title="Студия ${id}"></div>`).join('') + episodeHtml();
const sourceReply = (route: Route, body: string, url = origin + '/') => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, source: { body, url } }) });
const streamBody = (local: string, voice = '1') => JSON.stringify({ success: true,
  url: `[1080p]${local}/demo/sample.mp4?quality=1080&voice=${voice},[720p]${local}/demo/sample.mp4?quality=720&voice=${voice}`,
  subtitle: `[Русский]${local}/player-captions.vtt` });

async function sourceFixture(page: Page, intercept?: (route: Route, query: SourceRequest, local: string) => Promise<boolean>, waitForPlayback = true, settings: Partial<Settings> = {}) {
  const external: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname === '/player-captions.vtt') { await route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00.000 --> 00:11.000\nЛокальные субтитры\n' }); return; }
    if (url.pathname !== '/__bridge') { await route.continue(); return; }
    const body = route.request().postDataJSON() as { method: string; params: SourceRequest };
    if (body.method === 'getSettings') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin, ...settings } } }) }); return;
    }
    if (body.method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (body.method !== 'getSource') throw new Error('Unexpected bridge method: ' + body.method);
    const query = body.params;
    if (await intercept?.(route, query, url.origin)) return;
    if (query.operation === 'details') await sourceReply(route, detailsHtml, titleUrl);
    else if (query.operation === 'episodes') await sourceReply(route, JSON.stringify({ success: true, episodes: episodeHtml() }));
    else if (query.operation === 'streams') await sourceReply(route, streamBody(url.origin, query.voice.id));
    else await sourceReply(route, catalogHtml);
  });
  await page.goto('/');
  await page.getByTestId('title-last-0').click();
  await expect(page.getByTestId('details-play')).toBeEnabled();
  await page.getByTestId('details-play').click();
  if (waitForPlayback) await expect.poll(() => page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.1);
  return external;
}
// Back first hides the player's controls when they are shown, then closes the player.
async function leavePlayer(page: Page) {
  for (let presses = 0; presses < 3 && await page.getByTestId('player').count(); presses++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await expect(page.getByTestId('player')).toHaveCount(0);
}

test('paused quality change preserves position and later remote seeking is saved', async ({ page }) => {
  const external = await sourceFixture(page);
  const video = page.getByTestId('video');
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Воспроизвести');
  // Every control says in words what it does and what is chosen now; leaving is the remote's Back.
  for (const [id, text] of [['player-toggle', 'Воспроизвести'], ['player-next', 'Следующая'], ['player-episodes', 'Серии'], ['player-voice', 'Озвучка: Студия 1'], ['player-subtitles', 'Субтитры: выкл.'], ['player-quality', 'Качество: авто']]) {
    await expect(page.getByTestId(id).locator('svg')).toBeVisible();
    await expect(page.getByTestId(id)).toContainText(text);
  }
  await expect(page.getByTestId('player-exit')).toHaveCount(0);
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1; });
  await page.getByTestId('player-quality').click();
  await page.getByTestId('player-quality-1').click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentSrc)).toContain('quality=720');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  expect(await video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 1);
  await expect(page.getByTestId('player-quality')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-quality')).toHaveAccessibleName('Качество: 720p');
  await expect(page.getByTestId('player-quality')).toContainText('Качество: 720p');
  await page.getByTestId('player-timeline').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.seek-hint')).toContainText('Назад — отмена');
  // This source gave no preview frames: seeking shows the time alone.
  await expect(page.getByTestId('seek-frame')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(11, 1);
  await leavePlayer(page);
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('rezzka.library.v1')!).history);
  expect(history[0]).toMatchObject({ title: { url: titleUrl }, voice: { id: '1' }, episode: { id: '1', season: '1' } });
  expect(history[0].position).toBeCloseTo(11, 1); expect(external).toEqual([]);
});

test('watch opens the player while episodes load and an unavailable initial voice can be changed', async ({ page }) => {
  let pendingEpisodes: Route | undefined;
  const external = await sourceFixture(page, async (route, query) => {
    if (query.operation === 'details') {
      await sourceReply(route, detailsHtml.replace(episodeHtml(), ''), titleUrl); return true;
    }
    if (query.operation === 'episodes' && query.voice.id === '1') { pendingEpisodes = route; return true; }
    if (query.operation === 'streams' && query.voice.id === '1') {
      await sourceReply(route, JSON.stringify({ success: false, message: 'Озвучка временно недоступна.' })); return true;
    }
    return false;
  }, false);
  await expect.poll(() => Boolean(pendingEpisodes)).toBe(true);
  await expect(page.getByTestId('player')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Загрузка видео' })).toBeVisible();
  await expect(page.getByTestId('player-voice')).toBeEnabled();
  await sourceReply(pendingEpisodes!, JSON.stringify({ success: true, episodes: episodeHtml() }));
  await expect(page.getByRole('alert')).toContainText('Озвучка временно недоступна.');
  await expect(page.getByTestId('player-episodes')).toBeEnabled();
  await page.getByTestId('player-voice').click();
  await page.getByTestId('player-voice-1').click();
  await expect(page.getByTestId('player-voice')).toContainText('Студия 2');
  await expect(page.locator('.player-context')).toContainText('Сезон 1, серия 1');
  await expect.poll(() => page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(external).toEqual([]);
});

test('player panels keep remote focus, restore the opener and apply native captions', async ({ page }) => {
  const external = await sourceFixture(page);
  await page.keyboard.press('Space');
  await page.getByTestId('player-voice').click();
  // A list opens on what is chosen now.
  await expect(page.getByTestId('player-voice-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-voice-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('player-voice-3')).toBeDisabled();
  await expect(page.getByTestId('player-voice-3')).toContainText('Нужен Premium');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('player-panel').locator('[data-focused="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-panel')).toHaveCount(0);
  await expect(page.getByTestId('player-voice')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('player-subtitles').click();
  await page.getByTestId('player-subtitle-0').click();
  await expect(page.getByTestId('player-subtitles')).toHaveAttribute('data-focused', 'true');
  await expect.poll(() => page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.textTracks[0]?.mode)).toBe('showing');
  expect(external).toEqual([]);
});

test('late voice resolution cannot replace a newer voice and its available episode', async ({ page }) => {
  let pending: Route | undefined, localOrigin = '';
  const external = await sourceFixture(page, async (route, query, local) => {
    localOrigin = local;
    if (query.operation === 'streams' && query.voice.id === '2') { pending = route; return true; }
    if (query.operation === 'episodes' && query.voice.id === '3') {
      await sourceReply(route, JSON.stringify({ success: true, episodes: episodeHtml(['2']) })); return true;
    }
    return false;
  });
  await page.keyboard.press('Space');
  await page.getByTestId('video').evaluate((node: HTMLVideoElement) => { node.currentTime = 5; });
  await page.getByTestId('player-voice').click();
  await page.getByTestId('player-voice-1').click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('player-voice').click();
  await page.getByTestId('player-voice-2').click();
  await expect(page.getByTestId('player-voice')).toContainText('Студия 3');
  await expect(page.locator('.player-context')).toContainText('серия 2');
  await expect.poll(() => page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.currentSrc)).toContain('voice=3');
  expect(await page.getByTestId('video').evaluate((node: HTMLVideoElement) => node.currentTime)).toBeLessThan(3);
  await sourceReply(pending!, streamBody(localOrigin, '2'));
  await expect(page.getByTestId('player-voice')).toContainText('Студия 3');
  await expect(page.getByTestId('video')).toHaveAttribute('src', /voice=3/);
  await page.getByTestId('player-episodes').click();
  await expect(page.getByTestId('player-episode-0')).toContainText('Серия 2');
  await expect(page.getByTestId('player-episode-1')).toHaveCount(0);
  expect(external).toEqual([]);
});

test('reselecting the current voice cancels a pending switch to another voice', async ({ page }) => {
  let pending: Route | undefined, localOrigin = '', firstVoiceRequests = 0;
  const external = await sourceFixture(page, async (route, query, local) => {
    localOrigin = local;
    if (query.operation === 'streams' && query.voice.id === '1') firstVoiceRequests++;
    if (query.operation === 'streams' && query.voice.id === '2') { pending = route; return true; }
    return false;
  });
  const video = page.getByTestId('video');
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 4; });
  await page.getByTestId('player-voice').click();
  await page.getByTestId('player-voice-1').click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByTestId('player-voice').click();
  await page.getByTestId('player-voice-0').click();
  await expect.poll(() => firstVoiceRequests).toBe(2);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(4, 1);
  const staleResponse = page.waitForResponse(response => response.url().endsWith('/__bridge') && response.request().postDataJSON()?.params?.voice?.id === '2');
  await sourceReply(pending!, streamBody(localOrigin, '2'));
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('player-voice')).toContainText('Студия 1');
  await expect(video).toHaveAttribute('src', /voice=1/);
  expect(await video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  expect(external).toEqual([]);
});

test('OK pauses hidden controls and the next OK resumes without closing controls first', async ({ page }) => {
  const external = await sourceFixture(page);
  const video = page.getByTestId('video');
  await page.mouse.move(0, 0);
  // Deliberately hide a different focused control: restoring its stale focus
  // would make the second OK open quality selection instead of resuming.
  await page.getByTestId('player-quality').focus();
  await expect(page.getByTestId('player-quality')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-toggle')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(page.getByTestId('player-toggle')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await expect(page.getByTestId('player-panel')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  expect(external).toEqual([]);
});

test('the episode list opens on the season being watched and returns focus to the current episode', async ({ page }) => {
  const episodes = Array.from({ length: 8 }, (_, index) => {
    const season = String(index + 1);
    return `<ul class="b-simple_episodes__list" id="simple-episodes-list-${season}">${['1', '2', '3'].map(id => `<li class="b-simple_episode__item" data-season_id="${season}" data-episode_id="${id}">Серия ${id}</li>`).join('')}</ul>`;
  }).join('');
  await page.addInitScript(titleUrl => localStorage.setItem('rezzka.library.v1', JSON.stringify({ favorites: [], history: [{
    title: { id: '901', url: titleUrl, title: 'Проверка плеера', poster: '', kind: 'series' },
    voice: { id: '1', label: 'Студия 1' }, episode: { season: '4', id: '2', title: 'Серия 2' },
    position: 0, duration: 12, updatedAt: 1,
  }] })), titleUrl);
  const streams: SourceRequest[] = [];
  const external = await sourceFixture(page, async (route, query) => {
    if (query.operation === 'details') { await sourceReply(route, detailsHtml.replace(episodeHtml(), episodes), titleUrl); return true; }
    if (query.operation === 'episodes') { await sourceReply(route, JSON.stringify({ success: true, episodes })); return true; }
    if (query.operation === 'streams') streams.push(query);
    return false;
  });
  await page.keyboard.press('Space');
  await page.getByTestId('player-episodes').click();
  await page.mouse.move(0, 0);
  const tabs = page.getByTestId('player-seasons').locator('[data-testid^="player-season-"]');
  await expect(tabs).toHaveCount(8);
  await expect(page.getByTestId('player-season-3')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('player-seasons').locator('[data-testid^="player-season-"][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByTestId('player-episode-10')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-episode-10')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('player-episode-10')).toBeInViewport();
  await expect(page.getByTestId('player-episode-0')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('player-seasons.png') });

  // Up from the list returns to the open season, not to whichever tab happens to be above.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('player-episode-9')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('player-season-3')).toHaveAttribute('data-focused', 'true');
  // Moving along the tabs shows each season's episodes without starting anything.
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('player-season-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-season-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('player-episode-10')).toHaveCount(0);
  expect(streams).toHaveLength(1);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('player-episode-0')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('player-episode-1')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player-panel')).toHaveCount(0);
  await expect(page.locator('.player-context')).toContainText('Сезон 1, серия 2');
  await expect.poll(() => streams.at(-1)).toMatchObject({ operation: 'streams', season: '1', episode: '2' });
  await page.getByTestId('player-episodes').click();
  await page.mouse.move(0, 0);
  await expect(page.getByTestId('player-season-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('player-episode-1')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-episode-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-episodes')).toHaveAttribute('data-focused', 'true');
  expect(external).toEqual([]);
});

test('closing an episode panel cancels its initial focus and media end cannot focus controls behind it', async ({ page }) => {
  const external = await sourceFixture(page);
  await page.keyboard.press('Space');
  await page.clock.install();
  await page.getByTestId('player-episodes').click();
  await page.keyboard.press('Escape');
  await page.clock.runFor(100);
  await expect(page.getByTestId('player-panel')).toHaveCount(0);
  await expect(page.getByTestId('player-episodes')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await page.clock.runFor(100);
  await expect(page.getByTestId('player-episode-0')).toHaveAttribute('data-focused', 'true');
  await page.getByTestId('video').evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event('ended')));
  await page.clock.runFor(100);
  await expect(page.getByTestId('player-episode-0')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('player-panel').locator('[data-focused="true"]')).toHaveCount(1);
  expect(external).toEqual([]);
});

test('seeking shows the frame the cursor stands on', async ({ page }) => {
  const reads: string[] = [];
  const external = await sourceFixture(page, async (route, query, local) => {
    if (query.operation === 'streams') {
      await sourceReply(route, JSON.stringify({ ...JSON.parse(streamBody(local)), thumbnails: '/ajax/get_cdn_tiles/1/901/?t=1' })); return true;
    }
    if (query.operation === 'thumbnails') {
      reads.push(query.url);
      // Three frames of one sprite: two in its first row and one below them.
      const cue = (from: string, to: string, x: number, y: number) => `${from} --> ${to}\n${local}/seek-sprite.svg#xywh=${x},${y},160,90\n`;
      await sourceReply(route, ['WEBVTT\n', cue('00:00.000', '00:05.000', 0, 0), cue('00:05.000', '00:10.000', 160, 0), cue('00:10.000', '00:15.000', 0, 90)].join('\n'), query.url); return true;
    }
    return false;
  });
  await page.route('**/seek-sprite.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="160" height="90" fill="#345"/><rect x="160" width="160" height="90" fill="#543"/><rect y="90" width="160" height="90" fill="#354"/></svg>' }));
  const video = page.getByTestId('video');
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1; });
  await expect.poll(() => reads).toEqual([origin + '/ajax/get_cdn_tiles/1/901/?t=1']);
  // The frame appears only while a new position is being chosen.
  await expect(page.getByTestId('seek-frame')).toHaveCount(0);
  await page.getByTestId('player-timeline').focus();
  await page.keyboard.press('ArrowRight');
  const frame = page.getByTestId('seek-frame'), region = frame.locator('span');
  await expect(frame).toBeVisible();
  await expect(page.locator('.seek-bubble strong')).toHaveText('0:11');
  await expect(region).toHaveCSS('background-image', /seek-sprite\.svg/);
  await expect(region).toHaveCSS('background-position', '0px -90px');
  // The frame is scaled to one width whatever the size of the source's sprites.
  const unit = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const box = (await frame.boundingBox())!;
  expect(box.width).toBeCloseTo(14 * unit, 0);
  expect(box.height).toBeCloseTo(14 * unit * 90 / 160, 0);
  await expect(frame).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('player-seek-frame.png'), animations: 'disabled' });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.seek-bubble strong')).toHaveText('0:01');
  await expect(region).toHaveCSS('background-position', '0px 0px');
  // Back drops the chosen position together with its frame.
  await page.keyboard.press('Escape');
  await expect(frame).toHaveCount(0);
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 1);
  expect(external).toEqual([]);
});

test('the next episode is offered near the end and starts by itself', async ({ page }) => {
  const streams: SourceRequest[] = [];
  const external = await sourceFixture(page, async (_route, query) => { if (query.operation === 'streams') streams.push(query); return false; });
  const video = page.getByTestId('video');
  await expect(page.getByTestId('next-up')).toHaveCount(0);
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.duration - 2.5; });
  const offer = page.getByTestId('next-up');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Следующая серия через');
  await expect(offer).toContainText('Сезон 1, серия 2');
  await expect(page.getByTestId('player-next-stay')).toHaveText('Остаться');
  await page.screenshot({ path: test.info().outputPath('player-next-up.png'), animations: 'disabled' });
  // Nothing is pressed: when the episode ends the next one starts.
  await expect.poll(() => streams.length, { timeout: 10_000 }).toBe(2);
  expect(streams[1]).toMatchObject({ operation: 'streams', season: '1', episode: '2' });
  await expect(offer).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => !node.paused && node.currentTime > 0.1 && node.currentTime < 3)).toBe(true);
  // The last episode has nothing to offer.
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.duration - 2.5; });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended), { timeout: 10_000 }).toBe(true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('player-toggle')).toHaveAttribute('data-focused', 'true');
  expect(streams).toHaveLength(2);
  expect(external).toEqual([]);
});

test('staying on the episode cancels the automatic start of the next one', async ({ page }) => {
  const streams: SourceRequest[] = [];
  const external = await sourceFixture(page, async (_route, query) => { if (query.operation === 'streams') streams.push(query); return false; });
  const video = page.getByTestId('video');
  await page.mouse.move(0, 0);
  // With the controls hidden the offer takes focus, so OK accepts it and Right reaches «Остаться».
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-toggle')).toHaveCount(0);
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.duration - 4; });
  await expect(page.getByTestId('player-next-now')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('player-next-stay')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('next-up')).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended), { timeout: 10_000 }).toBe(true);
  // The episode ends and waits; the next one is one press away.
  await expect(page.getByTestId('player-next')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('next-up')).toHaveCount(0);
  expect(streams).toHaveLength(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => streams.length).toBe(2);
  expect(streams[1]).toMatchObject({ season: '1', episode: '2' });
  expect(external).toEqual([]);
});

test('with automatic start switched off the next episode is only offered', async ({ page }) => {
  const streams: SourceRequest[] = [];
  const external = await sourceFixture(page, async (_route, query) => { if (query.operation === 'streams') streams.push(query); return false; }, true, { autoNext: false });
  const video = page.getByTestId('video');
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.duration - 2.5; });
  const offer = page.getByTestId('next-up');
  await expect(offer).toContainText('Серия заканчивается');
  await expect(offer).not.toContainText('через');
  await expect(page.getByTestId('player-next-stay')).toHaveText('Не сейчас');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId('player-next')).toHaveAttribute('data-focused', 'true');
  expect(streams).toHaveLength(1);
  expect(external).toEqual([]);
});
