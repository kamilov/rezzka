import type { CatalogPage, CatalogSort, CatalogType, ContentKind, Episode, Playback, SourceDocument, SourceRequest, TitleDetails, TitleRating, TitleSummary, Voice } from '../shared/source';
import { sourceRequest } from './platform';
import { parseInitialPlayer, playbackFields, safeHttpUrl } from './provider-codec';
import { parseDetailsExtra } from './provider-details-extra';
import { parseKinopoiskFilmId } from './provider-identity';
import { parseSeriesUpdates } from './provider-updates';

export class ProviderError extends Error {
  constructor(public readonly code: 'challenge' | 'authentication' | 'markup' | 'unavailable', message: string) { super(message); this.name = 'ProviderError'; }
}
let sourceGeneration = 0;
export function getProviderGeneration(): number { return sourceGeneration; }
let authenticationListener: (() => void) | undefined;
export function subscribeToSourceAuth(listener: () => void): () => void {
  authenticationListener = listener;
  return () => { if (authenticationListener === listener) authenticationListener = undefined; };
}
export function resetProviderSession(): void { sourceGeneration++; initialPlayback.clear(); }
export function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['authentication', 'auth_required', 'source_http_401'].includes(String(error.code));
}
export async function sourceData<T>(query: SourceRequest, parse: (source: SourceDocument) => T): Promise<T> {
  const generation = sourceGeneration;
  try {
    const source = await sourceRequest(query);
    if (generation !== sourceGeneration) throw new Error('Сессия источника изменилась. Повторите запрос.');
    return parse(source);
  } catch (error) {
    if (generation === sourceGeneration && isAuthenticationError(error)) authenticationListener?.();
    throw error;
  }
}
const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const attr = (node: Element | null | undefined, name: string): string => node?.getAttribute(name)?.trim() ?? '';
const numeric = (value: string | undefined): string | undefined => value && /^\d+$/.test(value) ? value : undefined;

export function documentFrom(body: string): Document {
  const doc = new DOMParser().parseFromString(body, 'text/html');
  const heading = text(doc.querySelector('title')) + ' ' + text(doc.querySelector('h1'));
  if (doc.querySelector('#challenge-form, #cf-challenge-running, .cf-challenge, #cf-wrapper') ||
      /just a moment|checking your browser|verify you are human|проверка браузера|подтвердите.{0,20}(человек|робот)/i.test(heading)) {
    throw new ProviderError('challenge', 'Источник запросил проверку браузера. Попробуйте другое зеркало в настройках.');
  }
  if (/^(вход|авторизация)(?:\s|$)/i.test(text(doc.querySelector('h1'))) &&
      doc.querySelector('input[name="login_name"]') && doc.querySelector('input[name="login_password"]') &&
      !doc.querySelector('.b-content__inline_item, .b-post__title')) {
    throw new ProviderError('authentication', 'Источник требует вход в аккаунт. Войдите, чтобы продолжить.');
  }
  return doc;
}

function titleId(url: string): string | undefined { return new URL(url).pathname.match(/\/(\d+)(?:-|\.html|\/|$)/)?.[1]; }
function kindOf(node: ParentNode, url: string): ContentKind {
  const category = node.querySelector('span.cat, i.entity');
  for (const [name, kind] of [['films', 'film'], ['series', 'series'], ['cartoons', 'cartoon'], ['animation', 'anime']] as const) {
    if (category?.classList.contains(name) || category?.querySelector(`.${name}`) || new URL(url).pathname.startsWith(`/${name}/`)) return kind;
  }
  return 'unknown';
}

function ratingValue(node: Element | null): string | undefined {
  const value = text(node).replace(',', '.');
  return /^(?:\d(?:\.\d{1,3})?|10(?:\.0{1,3})?)$/.test(value) && Number(value) > 0 ? value : undefined;
}

function detailRatings(doc: Document): TitleRating[] {
  const result: TitleRating[] = [];
  for (const [source, selector, voteSelector] of [
    ['Кинопоиск', '.b-post__info .kp > span, .b-post__info .kp > b', '.b-post__info .kp > i'],
    ['IMDb', '.b-post__info .imdb > span, .b-post__info .imdb > b', '.b-post__info .imdb > i'],
    ['World Art', '.b-post__info .wa > span, .b-post__info .wa > b', '.b-post__info .wa > i'],
    ['HDrezka', '.b-post__rating .num', '.b-post__rating .votes > span'],
  ] as const) {
    // Only the rating number: vote counts and recommendation scores are separate elements.
    const value = [...doc.querySelectorAll(selector)].map(ratingValue).find(Boolean);
    const rawVotes = text(doc.querySelector(voteSelector)).replace(/^\(\s*|\s*\)$/g, '').trim();
    const votes = /^\d+(?:[\s.,]\d{3})*$/.test(rawVotes) ? rawVotes : undefined;
    if (value) result.push({ source, value, ...(votes ? { votes } : {}) });
  }
  return result;
}

function listItems(doc: ParentNode, base: string): { items: TitleSummary[]; count: number } {
  const cards = [...doc.querySelectorAll('.b-content__inline_item')];
  const items: TitleSummary[] = [];
  for (const card of cards) {
    const link = card.querySelector('.b-content__inline_item-link a');
    const url = safeHttpUrl(attr(card.querySelector('.b-content__inline_item-cover a'), 'href'), base) ??
      safeHttpUrl(attr(link, 'href'), base) ?? safeHttpUrl(attr(card, 'data-url'), base);
    const name = text(link);
    if (!url || !name) continue;
    const id = numeric(attr(card, 'data-id')) ?? titleId(url) ?? url;
    if (items.some(item => item.url === url)) continue;
    const image = card.querySelector('.b-content__inline_item-cover img');
    const meta = text(card.querySelector('.b-content__inline_item-link div'));
    const rating = ratingValue(card.querySelector('.b-category-bestrating'));
    items.push({
      id, url, title: name, poster: safeHttpUrl(attr(image, 'src') || attr(image, 'data-src'), base) ?? '',
      kind: kindOf(card, url), year: meta.match(/\b(?:19|20)\d{2}\b/)?.[0], meta: meta || undefined,
      rating, ...(rating ? { ratings: [{ source: 'Кинопоиск', value: rating }] } : {}),
    });
  }
  return { items, count: cards.length };
}

function pageNumber(url: URL): number | undefined {
  const value = url.searchParams.get('page') ?? url.pathname.match(/\/page\/(\d+)(?:\/|$)/)?.[1];
  if (!value) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

export function parseCatalog(source: SourceDocument, page = 1): CatalogPage {
  const doc = documentFrom(source.body), { items, count } = listItems(doc, source.url);
  if (!items.length) {
    const notice = text(doc.querySelector('.b-info__message, .b-content__inline_items-empty, .b-search__empty, .search-error, #search-results'));
    const explicitEmpty = /ничего не найдено|поиск не дал|не найден|нет результатов|no results/i.test(notice);
    if (count || !explicitEmpty) throw new ProviderError('markup', 'Источник вернул неизвестную разметку каталога. Попробуйте другое зеркало.');
    return { items: [] };
  }
  const navigation = doc.querySelector('.b-navigation, .navigation, .pagination');
  const links = [...(navigation ?? doc).querySelectorAll('a[href]')];
  const hasNext = links.some(link => {
    if (!navigation && !link.matches('[rel=next], .next, .nextlink')) return false;
    const href = safeHttpUrl(attr(link, 'href'), source.url);
    return href && new URL(href).origin === new URL(source.url).origin && (pageNumber(new URL(href)) ?? 0) > page;
  });
  // The first catalog page also carries the block of released episodes.
  const updates = page === 1 ? parseSeriesUpdates(doc, source.url) : [];
  return { items, nextPage: hasNext ? page + 1 : undefined, ...(updates.length ? { updates } : {}) };
}

export function parseEpisodeMarkup(html: string): Episode[] {
  const doc = documentFrom(html), result: Episode[] = [];
  for (const list of doc.querySelectorAll('ul.b-simple_episodes__list')) {
    const listSeason = list.id.replace(/^simple-episodes-list-/, '');
    for (const item of list.querySelectorAll('li.b-simple_episode__item')) {
      const id = numeric(attr(item, 'data-episode_id'));
      const season = numeric(attr(item, 'data-season_id')) ?? numeric(listSeason);
      if (!id || !season || result.some(episode => episode.id === id && episode.season === season)) continue;
      result.push({ id, season, title: text(item) || `Серия ${id}` });
    }
  }
  return result;
}

function metadata(doc: Document, label: RegExp): string | undefined {
  for (const row of doc.querySelectorAll('.b-post__info tr')) {
    const cells = row.querySelectorAll('td');
    if (label.test(text(cells[0]))) return text(cells[1]) || undefined;
  }
  return undefined;
}

export function parseDetails(source: SourceDocument, summary?: TitleSummary): TitleDetails {
  const doc = documentFrom(source.body);
  const name = text(doc.querySelector('.b-post__title h1'));
  if (!name) throw new ProviderError('markup', 'Не удалось распознать карточку. Разметка источника могла измениться.');
  const initial = parseInitialPlayer([...doc.scripts].map(script => script.textContent ?? ''));
  const url = safeHttpUrl(source.url);
  if (!url) throw new ProviderError('markup', 'Источник вернул некорректный адрес карточки.');
  const id = numeric(attr(doc.querySelector('.b-userset__fav_holder'), 'data-post_id')) ?? initial?.titleId ??
    numeric(summary?.id) ?? titleId(url);
  if (!id) throw new ProviderError('markup', 'В карточке отсутствует идентификатор фильма.');
  const voices: Voice[] = [];
  let selectedVoiceId: string | undefined;
  for (const node of doc.querySelectorAll('.b-translator__item')) {
    const voiceId = numeric(attr(node, 'data-translator_id'));
    if (!voiceId || voices.some(voice => voice.id === voiceId)) continue;
    const extra = attr(node.querySelector('img'), 'alt');
    voices.push({
      id: voiceId, label: [attr(node, 'title') || text(node) || `Озвучка ${voiceId}`, extra].filter(Boolean).join(' · '),
      premium: node.classList.contains('b-prem_translator'),
      isAds: attr(node, 'data-ads') || '0', isCamrip: attr(node, 'data-camrip') || '0', isDirector: attr(node, 'data-director') || '0',
    });
    if (node.classList.contains('active')) selectedVoiceId = voiceId;
  }
  if (!voices.length && initial) {
    voices.push({ id: initial.voiceId ?? 'default', label: 'Основная озвучка', isAds: '0', isCamrip: '0', isDirector: '0' });
  }
  const episodes = parseEpisodeMarkup(source.body);
  const activeEpisode = doc.querySelector('.b-simple_episode__item.active');
  const activeSeason = numeric(attr(activeEpisode, 'data-season_id')) ?? initial?.season;
  const activeId = numeric(attr(activeEpisode, 'data-episode_id')) ?? initial?.episode;
  const selectedEpisode = episodes.find((item) => item.season === activeSeason && item.id === activeId);
  const ogType = attr(doc.querySelector('meta[property="og:type"]'), 'content');
  const isSeries = initial?.isSeries ?? (episodes.length > 0 || ogType === 'video.tv_show' || ogType === 'video.episode' || summary?.kind === 'series');
  const image = doc.querySelector('.b-sidecover img');
  const poster = safeHttpUrl(attr(image, 'src') || attr(image, 'data-src'), url) ??
    safeHttpUrl(attr(doc.querySelector('.b-sidecover a'), 'href'), url) ?? safeHttpUrl(summary?.poster, url) ?? '';
  const ratings = detailRatings(doc);
  const kinopoiskFilmId = parseKinopoiskFilmId(doc, url);
  if (!ratings.some(item => item.source === 'Кинопоиск')) {
    const catalogRating = summary?.ratings?.find(item => item.source === 'Кинопоиск');
    if (catalogRating) ratings.unshift(catalogRating);
  }
  return {
    id, url, title: name, poster, kind: summary?.kind && summary.kind !== 'unknown' ? summary.kind : kindOf(doc, url), isSeries,
    year: metadata(doc, /дата выхода|год/i)?.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? summary?.year,
    meta: metadata(doc, /жанр/i) ?? summary?.meta,
    rating: ratings[0]?.value ?? summary?.rating, ratings,
    originalTitle: text(doc.querySelector('.b-post__origtitle')) || undefined,
    ...(kinopoiskFilmId ? { kinopoiskFilmId } : {}),
    description: text(doc.querySelector('.b-post__description_text')), duration: text(doc.querySelector('[itemprop="duration"]')) || undefined,
    ...parseDetailsExtra(doc, url, name),
    voices, selectedVoiceId: selectedVoiceId ?? voices[0]?.id, selectedEpisode, episodes,
    related: listItems(doc, url).items.filter(item => item.id !== id),
  };
}

function responseObject(source: SourceDocument): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(source.body); }
  catch {
    const doc = documentFrom(source.body);
    try { value = JSON.parse(doc.body.textContent ?? ''); }
    catch { throw new ProviderError('markup', 'Источник вернул неизвестный ответ плеера.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('markup', 'Источник вернул некорректные данные плеера.');
  const data = value as Record<string, unknown>;
  if (data.success === false) {
    const message = typeof data.message === 'string' ? text(new DOMParser().parseFromString(data.message, 'text/html').body).slice(0, 300) : '';
    throw new ProviderError('unavailable', message || 'Источник не предоставил видео для выбранной озвучки.');
  }
  if (data.success !== true) throw new ProviderError('markup', 'В ответе источника отсутствует подтверждение операции.');
  return data;
}

export function parseEpisodes(source: SourceDocument): Episode[] {
  const data = responseObject(source);
  if (typeof data.episodes !== 'string') throw new ProviderError('markup', 'Источник не вернул список серий.');
  const episodes = parseEpisodeMarkup(data.episodes);
  if (!episodes.length && data.episodes.trim()) throw new ProviderError('markup', 'Не удалось распознать список серий.');
  return episodes;
}

export function parsePlayback(source: SourceDocument): Playback {
  const playback = playbackFields(responseObject(source), source.url);
  if (!playback.streams.length) throw new ProviderError('unavailable', 'Источник не предоставил подходящую ссылку на видео.');
  return playback;
}

interface CachedInitial { expires: number; voiceId: string; playback: Playback; season?: string; episode?: string }
const initialPlayback = new Map<string, CachedInitial>();
const cacheLimit = 12, cacheLifetime = 30_000;
function rememberInitial(source: SourceDocument, details: TitleDetails): void {
  initialPlayback.delete(details.url);
  const doc = documentFrom(source.body);
  const initial = parseInitialPlayer([...doc.scripts].map(script => script.textContent ?? ''));
  if (!initial) return;
  const playback = playbackFields(initial.data, source.url);
  if (!playback.streams.length) return;
  const active = doc.querySelector('.b-simple_episode__item.active');
  initialPlayback.set(details.url, {
    expires: Date.now() + cacheLifetime, voiceId: initial.voiceId ?? details.selectedVoiceId ?? 'default', playback,
    season: numeric(attr(active, 'data-season_id')) ?? initial.season,
    episode: numeric(attr(active, 'data-episode_id')) ?? initial.episode,
  });
  while (initialPlayback.size > cacheLimit) initialPlayback.delete(initialPlayback.keys().next().value!);
}

export async function loadCatalog(options: { page: number; sort: CatalogSort; type: CatalogType }): Promise<CatalogPage> {
  return sourceData({ operation: 'catalog', ...options }, (source) => parseCatalog(source, options.page));
}
export async function searchTitles(query: string, page = 1): Promise<CatalogPage> {
  if (!query.trim()) return { items: [] };
  return sourceData({ operation: 'search', query: query.trim(), page }, (source) => parseCatalog(source, page));
}
export async function loadDetails(title: TitleSummary): Promise<TitleDetails> {
  return sourceData({ operation: 'details', url: title.url }, (source) => {
    const details = parseDetails(source, title);
    rememberInitial(source, details);
    return details;
  });
}
export async function loadEpisodes(title: TitleDetails, voice: Voice): Promise<Episode[]> {
  if (!title.isSeries && title.kind !== 'series') return [];
  if (voice.id === title.selectedVoiceId && title.episodes.length) return title.episodes;
  if (!numeric(voice.id)) throw new ProviderError('unavailable', 'Источник не указал озвучку для загрузки серий.');
  return sourceData({ operation: 'episodes', id: title.id, voice }, parseEpisodes);
}
export async function loadPlayback(title: TitleDetails, voice: Voice, episode?: Episode): Promise<Playback> {
  if ((title.isSeries || title.kind === 'series') && !episode) throw new ProviderError('unavailable', 'Выберите серию перед просмотром.');
  const initial = initialPlayback.get(title.url);
  if (initial && initial.expires > Date.now() && initial.voiceId === voice.id &&
      (!episode || (episode.id === initial.episode && episode.season === initial.season))) return initial.playback;
  if (!numeric(voice.id)) {
    const fresh = await loadDetails(title);
    const refreshed = initialPlayback.get(fresh.url);
    if (refreshed && !episode) return refreshed.playback;
    throw new ProviderError('unavailable', 'Источник не предоставил видео. Откройте карточку заново или выберите другую озвучку.');
  }
  return sourceData({ operation: 'streams', id: title.id, voice, season: episode?.season, episode: episode?.id }, parsePlayback);
}
