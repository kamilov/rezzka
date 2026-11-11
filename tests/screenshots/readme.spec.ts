import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultSettings } from '../../shared/settings';
import type { SourceRequest } from '../../shared/source';

// The README screenshots use free material only: Blender Open Movies posters from
// public/assets/posters, a poster cropped from a Caminandes cover and the Llamigos
// episode played from Wikimedia Commons (CC BY). Sources: docs/screenshots/CREDITS.md.
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const origin = 'https://mirror.example';
const commons = 'https://upload.wikimedia.org/wikipedia/commons';
const output = (name: string) => resolve(root, 'docs/screenshots', `${name}.jpg`);
const posterFile = (name: string) => name === 'caminandes.jpg' ? resolve(here, 'caminandes-poster.jpg') : resolve(root, 'public/assets/posters', name);

interface Title { id: string; slug: string; title: string; year: string; meta: string; poster: string; kind: 'films' | 'cartoons'; description: string }
const local = (file: string) => `${origin}/posters/${file}`;
const caminandes: Title = {
  id: '9001', slug: 'series/animation/9001-caminandes', title: 'Caminandes', year: '2013', meta: '2013, комедия', kind: 'cartoons', poster: local('caminandes.jpg'),
  description: 'Лама Коро живёт в Патагонии и всё время рвётся туда, куда ей нельзя: через шоссе, за электрический забор, к последним ягодам зимы.',
};
const films: Title[] = [
  { id: '9002', slug: 'cartoons/fantasy/9002-sintel', title: 'Sintel', year: '2010', meta: '2010, фэнтези', kind: 'cartoons', poster: local('sintel.jpg'),
    description: 'Девушка Синтел отправляется через горы и пустыни на поиски дракончика, которого вырастила и потеряла.' },
  { id: '9003', slug: 'cartoons/fantasy/9003-spring', title: 'Spring', year: '2019', meta: '2019, фэнтези', kind: 'cartoons', poster: local('spring.jpg'),
    description: 'Пастушка и её собака встречают древних духов, чтобы продолжить круговорот жизни.' },
  { id: '9004', slug: 'cartoons/comedy/9004-sprite-fright', title: 'Sprite Fright', year: '2021', meta: '2021, комедия, ужасы', kind: 'cartoons', poster: local('sprite-fright.jpg'),
    description: 'Подростки устраивают вечеринку в лесу и встречают там маленьких грибных духов, которые не терпят беспорядка.' },
  { id: '9005', slug: 'cartoons/comedy/9005-big-buck-bunny', title: 'Big Buck Bunny', year: '2008', meta: '2008, комедия', kind: 'cartoons', poster: local('big-buck-bunny.jpg'),
    description: 'Большой добродушный кролик решает проучить трёх грызунов, которые испортили ему утро.' },
  { id: '9006', slug: 'films/fiction/9006-tears-of-steel', title: 'Tears of Steel', year: '2012', meta: '2012, фантастика', kind: 'films', poster: local('tears-of-steel.png'),
    description: 'Учёные и солдаты в Амстердаме будущего пытаются спасти мир от роботов, заново разыграв одно давнее расставание.' },
];
const all = [caminandes, ...films];
const url = (title: Title) => `${origin}/${title.slug}.html`;
const entity = { films: 'Фильм', cartoons: 'Мультфильм' };
const card = (title: Title) => `<div class="b-content__inline_item" data-id="${title.id}"><div class="b-content__inline_item-cover"><a href="${url(title)}"><img src="${title.poster}"><span class="cat ${title.kind}"><i class="entity">${entity[title.kind]}</i></span></a></div>` +
  `<div class="b-content__inline_item-link"><a href="${url(title)}">${title.title}</a><div>${title.meta}</div></div></div>`;
const list = (titles: Title[]) => `<div class="b-content__inline_items">${titles.map(card).join('')}</div>`;

// Real episode titles and release years of the series.
const episodes = [['1', 'Llama Drama', '2013'], ['2', 'Gran Dillama', '2013'], ['3', 'Llamigos', '2016']] as const;
const video = `${commons}/transcoded/a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm.1080p.vp9.webm`;
const details = `<!doctype html><html><head><meta charset="utf-8"><meta property="og:type" content="video.tv_show"></head><body>
<div class="b-sidecover"><a href="${caminandes.poster}"><img src="${caminandes.poster}"></a></div>
<div class="b-post__title"><h1>Caminandes</h1></div><div class="b-userset__fav_holder" data-post_id="${caminandes.id}"></div>
<div class="b-post__description_text">${caminandes.description}</div>
<table class="b-post__info">
 <tr><td><h2>Дата выхода:</h2></td><td><a>2013</a> год</td></tr>
 <tr><td><h2>Жанр:</h2></td><td><a>Мультфильм</a>, <a>Комедия</a></td></tr>
 <tr><td>Режиссёр:</td><td><div class="persons-list-holder"><span class="item"><span class="person-name-item" data-id="1" data-pid="1" data-photo="/images/nopersonphoto.png" data-job="Режиссёр"><a href="/person/1-pablo-vazquez/"><span itemprop="name">Pablo Vazquez</span></a></span></span></div></td></tr>
</table>
<div class="b-post__schedule"><div class="b-post__schedule_block"><div class="b-post__schedule_block_title"><div class="title">Caminandes - даты выхода серий (1 сезон)</div></div>
 <div class="b-post__schedule_list"><table class="b-post__schedule_table"><tbody>${episodes.map(([number, name, year]) =>
  `<tr><td class="td-1">${number} серия</td><td class="td-2"><b>${name}</b></td><td class="td-3"><i class="watch-episode-action${number === '3' ? '' : ' watched'}" data-id="${number}"></i></td><td class="td-4">${year}</td><td class="td-5">✓</td></tr>`).join('')}</tbody></table></div>
</div></div>
${list(films)}
<div class="b-translator__item active" data-translator_id="1" title="Оригинал">Оригинал</div>
<ul class="b-simple_episodes__list" id="simple-episodes-list-1">${episodes.map(([number]) =>
  `<li class="b-simple_episode__item${number === '1' ? ' active' : ''}" data-season_id="1" data-episode_id="${number}">Серия ${number}</li>`).join('')}</ul>
</body></html>`;
// The viewer has watched two episodes and stopped in the middle of the third one;
// a few films are started too, so the home screen has something to continue.
const started = (title: Title, position: number, duration: number, hour: number) => ({
  title: { id: title.id, url: url(title), title: title.title, poster: title.poster, kind: 'cartoon' }, voice: { id: '1', label: 'Оригинал' },
  position, duration, updatedAt: Date.parse(`2026-11-12T${hour}:00:00Z`),
});
const history = JSON.stringify({ favorites: [], history: [
  { ...started(caminandes, 52, 150, 19), title: { id: caminandes.id, url: url(caminandes), title: caminandes.title, poster: caminandes.poster, kind: 'series' }, episode: { season: '1', id: '3', title: 'Серия 3' } },
  started(films[0], 610, 888, 18), started(films[3], 420, 596, 17), started(films[1], 140, 464, 16),
] });
const browseNavigation = `<li class="b-topnav__item"><a class="b-topnav__item-link" href="/cartoons/">Мультфильмы</a><select class="select-category"><option value="/cartoons/best/">любого жанра</option><option value="/cartoons/best/comedy/">Комедии</option><option value="/cartoons/best/fantasy/">Фэнтези</option></select>` +
  `<select class="select-year"><option value="0">за все время</option><option value="2021">2021</option><option value="2019">2019</option></select></li>`;

async function source(page: Page) {
  const unexpected: string[] = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await page.addInitScript(value => { localStorage.setItem('rezzka.library.v1', value); localStorage.setItem('rezzka.theme', 'dark'); }, history);
  await page.clock.setFixedTime(new Date('2026-11-12T20:30:00'));
  await page.route('**/*', async (route: Route) => {
    const address = new URL(route.request().url());
    if (address.origin === origin && address.pathname.startsWith('/posters/')) {
      await route.fulfill({ path: posterFile(address.pathname.slice('/posters/'.length)) }); return;
    }
    if (address.hostname === 'upload.wikimedia.org') { await route.continue(); return; }
    if (!['127.0.0.1', 'localhost'].includes(address.hostname)) { unexpected.push(address.href); await route.abort(); return; }
    if (address.pathname !== '/__bridge') { await route.continue(); return; }
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    const reply = (body: string, at = origin + '/') => route.fulfill({ json: { returnValue: true, source: { url: at, body } } });
    if (method === 'getSettings') { await route.fulfill({ json: { returnValue: true, settings: { revision: 1, values: { ...defaultSettings, mirrorUrl: origin } } } }); return; }
    if (method === 'getSourceSession') { await route.fulfill({ json: { returnValue: true, session: { authenticated: false, origin } } }); return; }
    if (method === 'getSource' && params.operation === 'catalog') {
      await reply(params.page > 1 ? list([]) : list(params.sort === 'popular' ? [films[0], films[3], caminandes, films[4], films[1], films[2]] : all)); return;
    }
    if (method === 'getSource' && params.operation === 'ratings') {
      const title = all.find(item => item.id === params.id)!;
      await reply(`<div class="b-content__catlabel ${title.kind}"><i class="entity">${entity[title.kind]}</i></div><div class="b-content__bubble_title"><a href="${url(title)}">${title.title}</a></div><div class="b-content__bubble_text">${title.description}</div>`,
        `${origin}/engine/ajax/quick_content.php`); return;
    }
    if (method === 'getSource' && params.operation === 'details') { await reply(details, url(caminandes)); return; }
    if (method === 'getSource' && params.operation === 'streams') { await reply(JSON.stringify({ success: true, url: `[1080p]${video}`, subtitle: false })); return; }
    if (method === 'getSource' && params.operation === 'browse') { await reply(browseNavigation + list(params.type === 'films' ? [films[4]] : [caminandes, ...films.slice(0, 4)]), `${origin}/${params.type}/best/`); return; }
    unexpected.push(`${method} ${JSON.stringify(params)}`);
    await route.fulfill({ json: { returnValue: false, errorText: 'Not used for screenshots' } });
  });
  await page.goto('/');
  await page.mouse.move(1919, 1079);
  return unexpected;
}

/** Waits until every visible poster has its picture, so no screenshot shows a placeholder. */
async function postersLoaded(page: Page) {
  await expect.poll(() => page.locator('.poster-image img').evaluateAll(images =>
    images.filter(image => image.getBoundingClientRect().top < innerHeight).every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

test('home, title card and player', async ({ page }) => {
  const unexpected = await source(page);
  await expect(page.getByTestId('spotlight-description')).toContainText('Лама Коро');
  await postersLoaded(page);
  await page.screenshot({ path: output('home'), type: 'jpeg', quality: 85, animations: 'disabled' });

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('details-play')).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('details-episodes')).toContainText('Llamigos');
  await postersLoaded(page);
  await page.screenshot({ path: output('title'), type: 'jpeg', quality: 85, animations: 'disabled' });

  await page.keyboard.press('Enter');
  const media = page.locator('video');
  await expect.poll(() => media.evaluate(element => { const video = element as HTMLVideoElement; return video.readyState >= 3 && video.currentTime > 52; })).toBe(true);
  // The same frame on every run: pause and return to the saved position.
  await media.evaluate(element => new Promise<void>(done => {
    const video = element as HTMLVideoElement;
    video.pause();
    video.addEventListener('seeked', () => done(), { once: true });
    video.currentTime = 52;
  }));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);
  await page.screenshot({ path: output('player'), type: 'jpeg', quality: 85, animations: 'disabled' });
  expect(unexpected).toEqual([]);
});

test('catalog', async ({ page }) => {
  const unexpected = await source(page);
  await page.getByTestId('nav-browse').click();
  await page.getByTestId('browse-type-cartoons').click();
  await expect(page.getByTestId('browse-title-0')).toContainText('Caminandes');
  await page.getByTestId('browse-title-0').focus();
  await page.mouse.move(1919, 1079);
  await postersLoaded(page);
  await page.screenshot({ path: output('catalog'), type: 'jpeg', quality: 85, animations: 'disabled' });
  expect(unexpected).toEqual([]);
});
