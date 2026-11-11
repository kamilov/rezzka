import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable, Writable } from 'node:stream';
import { isRecord, type ServiceResponse } from '../shared/settings';
import type { BrowseType, CatalogSort, CatalogType, SourceDocument, SourceRequest, Voice } from '../shared/source';
import type { Runtime } from './runtime';
import type { SourceCredentials, SourceSession } from '../shared/auth';
import { SourceCookies, readSourceSession, writeSourceSession } from './source-session';

export class SourceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const invalid = (message = 'Некорректный запрос к источнику.') => new SourceError('invalid_source_request', message);
const controlCharacters = /[\u0000-\u001f\u007f]/;

function shape(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isRecord(value) || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) throw invalid('Некорректный идентификатор фильма, озвучки или серии.');
  return value;
}

function favoriteIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,11}$/.test(value)) throw invalid('Некорректный идентификатор фильма или списка избранного.');
  return value;
}

function identifiedTitleUrl(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.length > 2048 || controlCharacters.test(value)) throw invalid('Некорректный адрес фильма.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Нужен полный адрес фильма.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash ||
      url.pathname.match(/\/(\d+)(?:-|\.html|\/|$)/)?.[1] !== id) throw invalid('Адрес фильма не соответствует идентификатору.');
  return url.href;
}

function page(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10000) throw invalid('Номер страницы должен быть от 1 до 10000.');
  return Number(value);
}

function personUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || controlCharacters.test(value) || value.includes('\\')) throw invalid('Некорректный адрес персоны.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Нужен полный адрес персоны.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash ||
      /%2f|%5c/i.test(url.pathname) || !/^\/person\/[1-9]\d{0,11}(?:-[^/]+)?(?:\/|\.html)$/.test(url.pathname)) {
    throw invalid('Адрес должен вести на страницу персоны.');
  }
  return url.href;
}

function thumbnailsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || controlCharacters.test(value) || value.includes('\\')) throw invalid('Некорректный адрес карты кадров.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Нужен полный адрес карты кадров.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw invalid('Некорректный адрес карты кадров.');
  return url.href;
}

function voice(value: unknown): Voice {
  const item = shape(value, ['id', 'label'], ['premium', 'isAds', 'isCamrip', 'isDirector']);
  identifier(item.id);
  if (typeof item.label !== 'string' || item.label.length > 200 || controlCharacters.test(item.label) ||
      (item.premium !== undefined && typeof item.premium !== 'boolean')) throw invalid();
  for (const key of ['isAds', 'isCamrip', 'isDirector']) {
    if (item[key] !== undefined && item[key] !== '0' && item[key] !== '1') throw invalid('Некорректные параметры озвучки.');
  }
  return { ...item } as unknown as Voice;
}

export function validateSourceRequest(input: unknown): SourceRequest {
  if (!isRecord(input)) throw invalid();
  switch (input.operation) {
    case 'catalog': {
      const item = shape(input, ['operation', 'page', 'sort', 'type']);
      if (typeof item.sort !== 'string' || typeof item.type !== 'string' ||
          !['last', 'popular', 'watching', 'new'].includes(item.sort) ||
          !['0', '1', '2', '3', '82'].includes(item.type)) throw invalid();
      return { operation: 'catalog', page: page(item.page), sort: item.sort as CatalogSort, type: item.type as CatalogType };
    }
    case 'browse': {
      const item = shape(input, ['operation', 'page', 'type', 'genre', 'year']);
      if (typeof item.type !== 'string' || !['films', 'series', 'cartoons', 'animation'].includes(item.type) ||
          typeof item.genre !== 'string' || item.genre.length > 64 || (item.genre !== '' && !/^[a-z]+(?:-[a-z]+)*$/.test(item.genre)) ||
          typeof item.year !== 'string' || (item.year !== '' && !/^(18|19|20)\d{2}$/.test(item.year))) throw invalid('Некорректные фильтры каталога.');
      return { operation: 'browse', page: page(item.page), type: item.type as BrowseType, genre: item.genre, year: item.year };
    }
    case 'continue': {
      shape(input, ['operation']);
      return { operation: 'continue' };
    }
    case 'continueSave': {
      const item = shape(input, ['operation', 'url', 'id', 'voice'], ['season', 'episode']);
      const id = favoriteIdentifier(item.id);
      // A series is saved with both numbers, a film with neither.
      if ((item.season === undefined) !== (item.episode === undefined)) throw invalid('Сезон и серия указываются вместе.');
      const result: SourceRequest = { operation: 'continueSave', id, voice: voice(item.voice), url: identifiedTitleUrl(item.url, id) };
      if (item.season !== undefined) { result.season = identifier(item.season); result.episode = identifier(item.episode); }
      return result;
    }
    case 'thumbnails': {
      const item = shape(input, ['operation', 'url']);
      return { operation: 'thumbnails', url: thumbnailsUrl(item.url) };
    }
    case 'favorites': {
      const item = shape(input, ['operation', 'page'], ['collectionId']);
      const number = page(item.page), collectionId = item.collectionId === undefined ? undefined : favoriteIdentifier(item.collectionId);
      if (!collectionId && number !== 1) throw invalid('Для следующей страницы выберите список избранного.');
      return { operation: 'favorites', page: number, ...(collectionId ? { collectionId } : {}) };
    }
    case 'favoriteToggle': {
      const item = shape(input, ['operation', 'url', 'id', 'collectionId']);
      const id = favoriteIdentifier(item.id);
      return { operation: 'favoriteToggle', id, collectionId: favoriteIdentifier(item.collectionId), url: identifiedTitleUrl(item.url, id) };
    }
    case 'favoriteCreate': {
      const item = shape(input, ['operation', 'url', 'id', 'name']);
      const id = favoriteIdentifier(item.id);
      if (typeof item.name !== 'string' || controlCharacters.test(item.name) || !item.name.trim() || item.name.trim().length > 100) {
        throw invalid('Название коллекции должно содержать от 1 до 100 символов без управляющих символов.');
      }
      return { operation: 'favoriteCreate', id, name: item.name.trim(), url: identifiedTitleUrl(item.url, id) };
    }
    case 'ratings': {
      const item = shape(input, ['operation', 'url', 'id']);
      const id = favoriteIdentifier(item.id);
      return { operation: 'ratings', id, url: identifiedTitleUrl(item.url, id) };
    }
    case 'comments': {
      const item = shape(input, ['operation', 'url', 'id', 'page']);
      const id = favoriteIdentifier(item.id);
      return { operation: 'comments', id, page: page(item.page), url: identifiedTitleUrl(item.url, id) };
    }
    case 'search': {
      const item = shape(input, ['operation', 'query', 'page']);
      if (typeof item.query !== 'string' || !item.query.trim() || item.query.length > 200 || controlCharacters.test(item.query)) {
        throw invalid('Поисковый запрос должен содержать от 1 до 200 символов.');
      }
      return { operation: 'search', query: item.query.trim(), page: page(item.page) };
    }
    case 'details': {
      const item = shape(input, ['operation', 'url']);
      if (typeof item.url !== 'string' || !item.url || item.url.length > 2048 || controlCharacters.test(item.url)) throw invalid();
      return { operation: 'details', url: item.url };
    }
    case 'person': {
      const item = shape(input, ['operation', 'url']);
      return { operation: 'person', url: personUrl(item.url) };
    }
    case 'episodes': {
      const item = shape(input, ['operation', 'id', 'voice']);
      return { operation: 'episodes', id: identifier(item.id), voice: voice(item.voice) };
    }
    case 'streams': {
      const item = shape(input, ['operation', 'id', 'voice'], ['season', 'episode']);
      if ((item.season === undefined) !== (item.episode === undefined)) throw invalid('Выберите сезон и серию.');
      const result: SourceRequest = { operation: 'streams', id: identifier(item.id), voice: voice(item.voice) };
      if (item.season !== undefined) { result.season = identifier(item.season); result.episode = identifier(item.episode); }
      return result;
    }
    default: throw invalid('Неизвестная операция источника.');
  }
}

function mirrorAddress(input: string): URL {
  if (!input) throw new SourceError('mirror_not_configured', 'Источник не настроен. Укажите адрес зеркала в настройках.');
  let url: URL;
  try { url = new URL(input); } catch { throw invalid('Некорректный адрес зеркала.'); }
  if (input.length > 2048 || controlCharacters.test(input) || !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password || url.search || url.hash) throw invalid('Укажите HTTP(S)-адрес зеркала без логина, пароля и параметров.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function sameOriginUrl(input: string, base: URL): URL {
  let url: URL;
  try { url = new URL(input, base); } catch { throw invalid('Некорректный адрес страницы.'); }
  if (url.username || url.password || url.origin !== base.origin || !['https:', 'http:'].includes(url.protocol)) {
    throw new SourceError('source_origin', 'Адрес страницы относится к другому зеркалу. Обновите каталог после смены источника.');
  }
  return url;
}

function buildRequest(base: URL, query: SourceRequest): RequestPlan {
  if (query.operation === 'catalog') {
    const path = (query.sort === 'new' ? 'new/' : '') + (query.page > 1 ? `page/${query.page}/` : '');
    const url = new URL(path, base);
    if (query.sort !== 'new') url.searchParams.set('filter', query.sort);
    if (query.type !== '0') url.searchParams.set('genre', query.type);
    return { url, method: 'GET' };
  }
  if (query.operation === 'browse') {
    const segments = [query.type, 'best', ...(query.genre ? [query.genre] : []), ...(query.year ? [query.year] : []), ...(query.page > 1 ? ['page', String(query.page)] : [])];
    return { url: new URL(`${segments.join('/')}/`, base), method: 'GET' };
  }
  if (query.operation === 'continue') return { url: new URL('continue/', base), method: 'GET' };
  if (query.operation === 'continueSave') {
    sameOriginUrl(query.url, base);
    const url = new URL('ajax/send_save/', base);
    url.searchParams.set('t', String(Date.now()));
    // The source's Android client sends the constant 1 as the time; the exact
    // position is not part of the contract we know, so it stays on the device.
    return { url, method: 'POST', mutation: true,
      body: new URLSearchParams({ post_id: query.id, translator_id: query.voice.id, season: query.season ?? '0', episode: query.episode ?? '0', current_time: '1' }).toString() };
  }
  // The seek preview map lives on the mirror; its sprite images are loaded by the page itself.
  if (query.operation === 'thumbnails') return { url: sameOriginUrl(query.url, base), method: 'POST', body: '' };
  if (query.operation === 'favorites') {
    const url = new URL(`favorites/${query.collectionId ? `${query.collectionId}/` : ''}${query.page > 1 ? `page/${query.page}/` : ''}`, base);
    url.searchParams.set('filter', 'added');
    return { url, method: 'GET' };
  }
  if (query.operation === 'favoriteToggle') {
    sameOriginUrl(query.url, base);
    return { url: new URL('ajax/favorites/', base), method: 'POST', mutation: true,
      body: new URLSearchParams({ post_id: query.id, cat_id: query.collectionId, action: 'add_post' }).toString() };
  }
  if (query.operation === 'favoriteCreate') {
    sameOriginUrl(query.url, base);
    return { url: new URL('ajax/favorites/', base), method: 'POST', mutation: true,
      body: new URLSearchParams({ name: query.name, action: 'add_cat' }).toString() };
  }
  if (query.operation === 'ratings') {
    sameOriginUrl(query.url, base);
    return { url: new URL('engine/ajax/quick_content.php', base), method: 'POST',
      body: new URLSearchParams({ id: query.id, is_touch: '1' }).toString() };
  }
  if (query.operation === 'comments') {
    sameOriginUrl(query.url, base);
    const url = new URL('ajax/get_comments/', base);
    url.search = new URLSearchParams({ t: String(Date.now()), news_id: query.id, cstart: String(query.page), type: '0', comment_id: '0', skin: 'hdrezka' }).toString();
    return { url, method: 'GET' };
  }
  if (query.operation === 'search') {
    const url = new URL('search/', base);
    url.search = new URLSearchParams({ do: 'search', subaction: 'search', q: query.query, page: String(query.page) }).toString();
    return { url, method: 'GET' };
  }
  if (query.operation === 'details') {
    const url = sameOriginUrl(query.url, base);
    if (url.search || url.hash) throw invalid('Адрес фильма должен быть без параметров и fragment.');
    return { url, method: 'GET' };
  }
  if (query.operation === 'person') return { url: sameOriginUrl(query.url, base), method: 'GET' };
  const url = new URL('ajax/get_cdn_series/', base);
  url.searchParams.set('t', String(Date.now()));
  const form = new URLSearchParams({ id: query.id, translator_id: query.voice.id });
  if (query.operation === 'episodes') form.set('action', 'get_episodes');
  else if (query.season !== undefined && query.episode !== undefined) {
    form.set('season', query.season); form.set('episode', query.episode); form.set('action', 'get_stream');
  } else {
    form.set('is_camrip', query.voice.isCamrip ?? '0');
    form.set('is_ads', query.voice.isAds ?? '0');
    form.set('is_director', query.voice.isDirector ?? '0');
    form.set('action', 'get_movie');
  }
  return { url, method: 'POST', body: form.toString() };
}

export interface SourceTransport {
  request(mirror: string, query: unknown): Promise<SourceDocument>;
  session(mirror: string): Promise<SourceSession>;
  login(mirror: string, credentials: unknown, isCurrent?: () => Promise<boolean>): Promise<SourceSession>;
  logout(mirror: string, input: unknown): Promise<SourceSession>;
  selectMirror(mirror: string, invalidate?: boolean): Promise<void>;
  close(): void;
}

interface TransportOptions {
  timeoutMs?: number; maxBytes?: number; maxRedirects?: number; sessionPath?: string;
  /** Only local transport fixtures opt in; production bridge and Luna never do. */
  allowInsecureLoopbackAuth?: boolean;
}
interface SessionState { base: URL; cookies: SourceCookies; username?: string; pending?: boolean }
type RequestPlan = { url: URL; method: 'GET' | 'POST'; body?: string; mutation?: boolean };

function authenticationPage(body: string): boolean {
  if (/class=["'][^"']*\bb-(?:content__inline_item|post__title)\b/i.test(body)) return false;
  const heading = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]*>/g, '').trim() || '';
  return /^(вход|авторизация)(?:\s|$)/i.test(heading) && /name=["']login_name["']/i.test(body) && /name=["']login_password["']/i.test(body);
}
function authChallenge(body: string): boolean {
  return /(?:id=["'](?:challenge-form|cf-challenge-running|cf-wrapper)["']|<title[^>]*>\s*(?:just a moment|checking your browser))/i.test(body);
}
function credentialsFor(mirror: string, input: unknown): SourceCredentials {
  const data = shape(input, ['mirrorUrl', 'username', 'password']);
  if (typeof data.mirrorUrl !== 'string' || mirrorAddress(data.mirrorUrl).href !== mirrorAddress(mirror).href) {
    throw new SourceError('source_changed', 'Источник изменился. Откройте форму входа заново.');
  }
  if (typeof data.username !== 'string' || !data.username.trim() || data.username.length > 200 || controlCharacters.test(data.username) ||
      typeof data.password !== 'string' || !data.password || data.password.length > 1024 || controlCharacters.test(data.password)) {
    throw new SourceError('invalid_credentials', 'Введите логин и пароль аккаунта.');
  }
  return { mirrorUrl: data.mirrorUrl, username: data.username.trim(), password: data.password };
}

export function createSourceTransport(options: TransportOptions = {}): SourceTransport {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const active = new Set<ClientRequest>();
  const mutations = new WeakMap<SessionState, Set<string>>();
  let current: SessionState | undefined;
  let inFlight = 0;
  let closed = false;
  let writes: Promise<void> = Promise.resolve();
  const initialized = (async () => {
    if (!options.sessionPath) return;
    try {
      const saved = await readSourceSession(options.sessionPath);
      if (saved) {
        const base = new URL(saved.origin + '/'), cookies = new SourceCookies(saved.cookies);
        current = { base, cookies, username: saved.username };
      }
    } catch { throw new SourceError('auth_storage', 'Не удалось прочитать сохранённую сессию. Проверьте хранилище устройства.'); }
  })();
  // The bridge creates this transport before its first request; avoid an unhandled
  // read failure while keeping the original rejection observable by callers.
  void initialized.catch(() => {});
  const changed = () => new SourceError('source_changed', 'Сессия или источник изменились. Повторите действие.');
  const check = (session: SessionState) => {
    if (closed) throw new SourceError('service_closed', 'Сервис остановлен.');
    if (session !== current) throw changed();
  };
  const persist = async () => {
    if (!options.sessionPath) return;
    const write = async () => {
      if (closed) return;
      const state = current;
      const value = state?.username && !state.pending && state.cookies.authenticated(state.base)
        ? { schemaVersion: 1 as const, origin: state.base.origin, username: state.username, cookies: state.cookies.serialize() } : undefined;
      try { await writeSourceSession(options.sessionPath!, value, () => !closed && current === state); }
      catch { throw new SourceError('auth_storage', 'Не удалось сохранить сессию на устройстве. Повторите вход.'); }
    };
    const result = writes.then(write, write); writes = result;
    await result;
  };
  const select = async (mirror: string): Promise<SessionState> => {
    const base = mirrorAddress(mirror);
    await initialized;
    if (closed) throw new SourceError('service_closed', 'Сервис остановлен.');
    let state = current;
    if (!state || state.base.origin !== base.origin) {
      state = { base, cookies: new SourceCookies() }; current = state;
      await persist();
    } else if (state.base.href !== base.href) {
      state = { base, cookies: state.pending ? state.cookies.technical() : new SourceCookies(state.cookies.serialize()), username: state.username };
      current = state; await persist();
    }
    check(state); return state;
  };
  const publicSession = (state: SessionState): SourceSession => {
    const authenticated = !!state.username && !state.pending && state.cookies.authenticated(state.base);
    return { authenticated, origin: state.base.origin, ...(authenticated ? { username: state.username } : {}) };
  };
  const requireAccountHttps = (base: URL, message: string) => {
    if (base.protocol !== 'https:' && !(options.allowInsecureLoopbackAuth && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new SourceError('auth_https_required', message);
    }
  };

  async function perform(base: URL, plan: RequestPlan, session: SessionState): Promise<SourceDocument> {
    check(session);
    if (inFlight >= 4) throw new SourceError('source_busy', 'Источник занят предыдущими запросами. Повторите через несколько секунд.');
    const deadline = Date.now() + timeoutMs;
    inFlight++;
    async function load(url: URL, method: 'GET' | 'POST', body: string | undefined, redirects: number): Promise<SourceDocument> {
      check(session);
      if (Date.now() >= deadline) throw new SourceError('source_timeout', 'Источник не ответил за 15 секунд. Проверьте зеркало и подключение.');
      const result = await new Promise<SourceDocument | { redirect: URL; method: 'GET' | 'POST'; body?: string }>((resolve, reject) => {
        let response: IncomingMessage | undefined;
        let decoded: Readable | undefined;
        let done = false;
        const finish = (error?: Error, value?: SourceDocument | { redirect: URL; method: 'GET' | 'POST'; body?: string }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          active.delete(outgoing);
          if (error) {
            outgoing.destroy(); response?.destroy(); decoded?.destroy(); reject(error);
          } else resolve(value!);
        };
        const networkError = (error: NodeJS.ErrnoException) => {
          if (error instanceof SourceError) { finish(error); return; }
          const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '');
          finish(new SourceError(tls ? 'source_tls' : 'source_network', tls
            ? 'Не удалось проверить HTTPS-сертификат зеркала. Проверьте адрес и дату на устройстве.'
            : 'Не удалось подключиться к источнику. Проверьте зеркало и сеть.'));
        };
        const headers: Record<string, string> = {
          'User-Agent': 'Rezzka/0.1 (webOS TV)',
          Accept: 'text/html, application/json, application/xhtml+xml, text/plain;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: base.href,
        };
        const cookie = session.cookies.header(url);
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          headers['Content-Length'] = String(Buffer.byteLength(body));
          headers.Origin = base.origin;
          headers['X-Requested-With'] = 'XMLHttpRequest';
        }
        const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          method, headers, agent: false, maxHeaderSize: 16 * 1024,
          // No TLS override: Node verifies the certificate and hostname.
        }, (incoming) => {
          response = incoming;
          incoming.on('error', networkError);
          incoming.on('aborted', () => finish(new SourceError('source_incomplete', 'Источник прервал ответ. Повторите запрос.')));
          try { check(session); } catch (error) { finish(error as Error); return; }
          session.cookies.receive(url, incoming.headers['set-cookie'] || [], session.pending || !!session.username);
          const status = incoming.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            try {
              // Replaying a mutation could undo a membership change or create a
              // duplicate collection; following with GET cannot confirm its result.
              if (plan.mutation) throw new SourceError('source_mutation_redirect', 'Источник перенаправил запрос изменения. Обновите избранное, чтобы проверить результат.');
              if (redirects >= maxRedirects) throw new SourceError('source_redirects', 'Слишком много перенаправлений. Проверьте адрес зеркала.');
              const location = incoming.headers.location;
              if (!location || location.length > 2048 || controlCharacters.test(location)) throw new SourceError('source_redirect', 'Источник вернул некорректное перенаправление.');
              let next: URL;
              try { next = sameOriginUrl(location, url); }
              catch { throw new SourceError('source_redirect_origin', 'Источник перенаправляет на другой адрес. Укажите актуальное зеркало в настройках.'); }
              next.hash = '';
              const useGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
              finish(undefined, { redirect: next, method: useGet ? 'GET' : method, body: useGet ? undefined : body });
            } catch (error) { finish(error as Error); }
            incoming.destroy();
            return;
          }
          if (status < 200 || status >= 300) {
            const advice = status === 401 || status === 403
              ? 'Доступ к зеркалу ограничен. Проверьте адрес и подключение.'
              : status === 404 ? 'Страница не найдена. Обновите каталог или проверьте зеркало.'
                : status === 429 ? 'Источник ограничил частоту запросов. Повторите позже.'
                  : 'Источник временно недоступен. Повторите позже или проверьте зеркало.';
            finish(new SourceError('source_http_' + status, `HTTP ${status}. ${advice}`));
            return;
          }
          const contentType = (incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          // text/vtt is the seek preview map; every other reply is a page or an API answer.
          if (contentType && !['text/html', 'application/xhtml+xml', 'application/json', 'text/plain', 'text/vtt'].includes(contentType)) {
            finish(new SourceError('source_content_type', 'Источник вернул файл вместо HTML/JSON. Проверьте адрес зеркала.')); return;
          }
          const length = incoming.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
            finish(new SourceError('source_too_large', 'Ответ источника превышает допустимый размер.')); return;
          }
          const encoding = (incoming.headers['content-encoding'] || 'identity').trim().toLowerCase();
          if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
            finish(new SourceError('source_encoding', 'Источник использует неподдерживаемое сжатие ответа.')); return;
          }
          decoded = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
            : encoding === 'br' ? createBrotliDecompress() : incoming;
          if (decoded !== incoming) decoded.on('error', () => finish(new SourceError('source_encoding', 'Не удалось распаковать ответ источника.')));
          const chunks: Buffer[] = [];
          let received = 0;
          let expanded = 0;
          incoming.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) finish(new SourceError('source_too_large', 'Ответ источника превышает допустимый размер.'));
          });
          decoded.on('data', (chunk: Buffer) => {
            expanded += chunk.length;
            if (expanded > maxBytes) finish(new SourceError('source_too_large', 'Распакованный ответ источника превышает допустимый размер.'));
            else if (!done) chunks.push(chunk);
          });
          decoded.on('end', () => {
            try { check(session); finish(undefined, { body: Buffer.concat(chunks).toString('utf8'), url: url.href }); }
            catch (error) { finish(error as Error); }
          });
          if (decoded !== incoming) incoming.pipe(decoded as Readable & Writable);
        });
        const timer = setTimeout(() => finish(new SourceError('source_timeout', 'Источник не ответил за 15 секунд. Проверьте зеркало и подключение.')), Math.max(1, deadline - Date.now()));
        active.add(outgoing);
        outgoing.on('error', networkError);
        outgoing.end(body);
      });
      return 'redirect' in result ? load(result.redirect, result.method, result.body, redirects + 1) : result;
    }
    try { return await load(plan.url, plan.method, plan.body, 0); }
    finally { inFlight--; }
  }
  async function request(mirror: string, input: unknown): Promise<SourceDocument> {
    const query = validateSourceRequest(input), base = mirrorAddress(mirror), plan = buildRequest(base, query);
    const saving = query.operation === 'continueSave';
    if (plan.mutation) requireAccountHttps(base, saving ? 'Для записи просмотра в аккаунт используйте HTTPS-адрес источника.' : 'Для изменения избранного используйте HTTPS-адрес источника.');
    const state = await select(mirror);
    if (state.pending) throw new SourceError('auth_busy', 'Дождитесь завершения входа.');
    let mutationKey: string | undefined, locked: Set<string> | undefined;
    if (query.operation === 'favoriteToggle' || query.operation === 'favoriteCreate' || query.operation === 'continueSave') {
      if (!publicSession(state).authenticated) throw new SourceError('auth_required', saving ? 'Войдите в аккаунт, чтобы сохранять просмотр.' : 'Войдите в аккаунт, чтобы изменить избранное.');
      mutationKey = query.operation === 'favoriteCreate' ? 'create' : query.operation === 'continueSave' ? `save:${query.id}` : `${query.id}:${query.collectionId}`;
      locked = mutations.get(state) ?? new Set<string>();
      if (locked.has(mutationKey)) throw query.operation === 'continueSave'
        ? new SourceError('continue_busy', 'Просмотр этого фильма уже записывается.')
        : new SourceError('favorite_busy', query.operation === 'favoriteCreate'
          ? 'Создание коллекции уже выполняется. Дождитесь ответа источника.'
          : 'Изменение этой записи уже выполняется. Дождитесь ответа источника.');
      locked.add(mutationKey); mutations.set(state, locked);
    }
    try {
      const result = await perform(base, plan, state);
      check(state);
      if (authenticationPage(result.body)) {
        current = { base, cookies: state.cookies.technical() };
        await persist();
        throw new SourceError('auth_required', 'Источник требует входа в аккаунт.');
      }
      if (state.username) {
        if (!state.cookies.authenticated(base)) state.username = undefined;
        await persist(); check(state);
      }
      return result;
    } catch (error) {
      if (plan.mutation && error instanceof SourceError && ['source_timeout', 'source_network', 'source_incomplete'].includes(error.code)) {
        check(state);
        throw new SourceError('source_mutation_unconfirmed', saving ? 'Не удалось подтвердить запись просмотра в аккаунт.' : 'Не удалось подтвердить изменение. Обновите избранное, чтобы проверить результат.');
      }
      throw error;
    } finally {
      if (mutationKey) locked?.delete(mutationKey);
    }
  }
  async function login(mirror: string, input: unknown, isCurrent: () => Promise<boolean> = async () => true): Promise<SourceSession> {
    const credentials = credentialsFor(mirror, input), base = mirrorAddress(mirror);
    requireAccountHttps(base, 'Для входа используйте HTTPS-адрес источника.');
    const previous = await select(mirror);
    check(previous);
    if (previous.pending) throw new SourceError('auth_busy', 'Вход уже выполняется.');
    const state: SessionState = { base, cookies: previous.cookies.technical(), pending: true };
    current = state;
    try {
      await persist();
      const result = await perform(base, {
        url: new URL('ajax/login/', base), method: 'POST',
        body: new URLSearchParams({ login_name: credentials.username, login_password: credentials.password, login_not_save: '0' }).toString(),
      }, state);
      check(state);
      if (authChallenge(result.body)) throw new SourceError('auth_challenge', 'Источник запросил проверку браузера. Откройте сайт источника в браузере или смените зеркало.');
      let data: unknown;
      try { data = JSON.parse(result.body); }
      catch { throw new SourceError('auth_response', 'Источник вернул неизвестный ответ входа. Проверьте зеркало.'); }
      if (!isRecord(data) || typeof data.success !== 'boolean') throw new SourceError('auth_response', 'Не удалось распознать ответ входа.');
      if (!data.success) {
        if (data.captcha || data.recaptcha || data.challenge) throw new SourceError('auth_challenge', 'Источник требует дополнительной проверки в браузере.');
        if (data.logged_email) throw new SourceError('invalid_credentials', 'Источник сообщает о другой активной сессии. Повторите вход.');
        throw new SourceError('invalid_credentials', 'Не удалось войти. Проверьте логин и пароль.');
      }
      if (!state.cookies.authenticated(base)) throw new SourceError('auth_session_missing', 'Источник подтвердил вход, но не выдал сессию. Повторите вход или проверьте зеркало.');
      if (!await isCurrent()) throw changed();
      check(state);
      state.username = credentials.username; state.pending = false;
      await persist(); check(state);
      return publicSession(state);
    } catch (error) {
      if (current === state) { current = { base, cookies: new SourceCookies() }; await persist(); }
      throw error;
    }
  }
  async function logout(mirror: string, input: unknown): Promise<SourceSession> {
    const data = shape(input, ['mirrorUrl']);
    if (typeof data.mirrorUrl !== 'string' || mirrorAddress(data.mirrorUrl).href !== mirrorAddress(mirror).href) throw changed();
    await select(mirror);
    const state = { base: mirrorAddress(mirror), cookies: new SourceCookies() };
    current = state; await persist(); check(state);
    return publicSession(state);
  }
  return {
    request, login, logout,
    async session(mirror) {
      if (!mirror) { await initialized; current = undefined; await persist(); return { authenticated: false, origin: '' }; }
      const state = await select(mirror);
      if (state.username && !state.cookies.authenticated(state.base)) { state.username = undefined; await persist(); check(state); }
      return publicSession(state);
    },
    async selectMirror(mirror, invalidate = false) {
      if (mirror && invalidate) {
        const base = mirrorAddress(mirror);
        await initialized;
        if (closed) throw new SourceError('service_closed', 'Сервис остановлен.');
        const state = { base, cookies: new SourceCookies() }; current = state;
        await persist(); check(state);
      } else if (mirror) await select(mirror);
      else { await initialized; current = undefined; await persist(); }
    },
    close() {
      closed = true;
      current = undefined;
      for (const outgoing of active) outgoing.destroy(new SourceError('service_closed', 'Сервис остановлен.'));
    },
  };
}

export async function getSource(runtime: Runtime, transport: SourceTransport, query: unknown): Promise<ServiceResponse> {
  let settings: ServiceResponse;
  try { settings = await runtime.getSettings(); }
  catch { return { returnValue: false, errorCode: 'storage_error', errorText: 'Не удалось прочитать сохранённый адрес источника.' }; }
  if (!settings.returnValue) return settings;
  if (!settings.settings) return { returnValue: false, errorCode: 'storage_error', errorText: 'Сервис не вернул настройки источника.' };
  try {
    return { returnValue: true, source: await transport.request(settings.settings.values.mirrorUrl, query) };
  } catch (cause) {
    return {
      returnValue: false,
      errorCode: cause instanceof SourceError ? cause.code : 'source_error',
      errorText: cause instanceof SourceError ? cause.message : 'Не удалось прочитать источник. Проверьте зеркало и повторите запрос.',
    };
  }
}

async function withSource(runtime: Runtime, work: (mirror: string) => Promise<ServiceResponse>): Promise<ServiceResponse> {
  try {
    const settings = await runtime.getSettings();
    if (!settings.returnValue) return settings;
    if (!settings.settings) throw new SourceError('storage_error', 'Не удалось прочитать адрес источника.');
    return await work(settings.settings.values.mirrorUrl);
  } catch (cause) {
    return { returnValue: false, errorCode: cause instanceof SourceError ? cause.code : 'source_error',
      errorText: cause instanceof SourceError ? cause.message : 'Не удалось выполнить действие с аккаунтом. Повторите попытку.' };
  }
}

export function getSourceSession(runtime: Runtime, transport: SourceTransport): Promise<ServiceResponse> {
  return withSource(runtime, async mirror => ({ returnValue: true, session: await transport.session(mirror) }));
}
export function sourceLogin(runtime: Runtime, transport: SourceTransport, input: unknown): Promise<ServiceResponse> {
  return withSource(runtime, async mirror => ({ returnValue: true, session: await transport.login(mirror, input, async () => {
    const current = await runtime.getSettings();
    return !!(current.returnValue && current.settings && current.settings.values.mirrorUrl === mirror);
  }) }));
}
export function sourceLogout(runtime: Runtime, transport: SourceTransport, input: unknown): Promise<ServiceResponse> {
  return withSource(runtime, async mirror => ({ returnValue: true, session: await transport.logout(mirror, input) }));
}
