import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KinopoiskPerson, KinopoiskPersonQuery, KinopoiskResult, KinopoiskStatus } from '../shared/kinopoisk';
import { isRecord } from '../shared/settings';

export class KinopoiskError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'KinopoiskError'; }
}
export interface KinopoiskService {
  status(): Promise<KinopoiskStatus>;
  setKey(input: unknown): Promise<KinopoiskStatus>;
  person(input: unknown): Promise<KinopoiskResult>;
  close(): Promise<void>;
}
export interface KinopoiskOptions {
  storagePath: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  personTimeoutMs?: number;
}
type Staff = { id: string; name: string; originalName: string; profession: string };
type Profile = { person: KinopoiskPerson; nameRu: string; birthDate?: string };
type Cached<T> = { expiresAt: number; value: T };
const invalid = () => new KinopoiskError('invalid_kinopoisk_request', 'Некорректные параметры Кинопоиска.');
const stale = () => new KinopoiskError('kinopoisk_stale', 'Настройки Кинопоиска изменились. Повторите запрос.');
const malformed = () => new KinopoiskError('kinopoisk_response', 'Кинопоиск вернул неполные или некорректные данные.');
const storageError = () => new KinopoiskError('kinopoisk_storage', 'Не удалось прочитать или сохранить ключ Кинопоиска.');
const maxBytes = 1024 * 1024, ttl = 24 * 60 * 60 * 1000;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value);
const numericId = (value: unknown): string | undefined => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 999999999 ? String(value) : undefined;
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^[\x21-\x7e]*$/.test(value);
function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}
function plain(value: unknown, limit = 500): string {
  if (typeof value !== 'string') return '';
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
    }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function professionKeys(value?: string): Set<string> {
  const words = normalize(value ?? '');
  const result = new Set<string>();
  for (const [pattern, key] of [[/актер|актрис|\bactor\b|\bactress\b/, 'ACTOR'], [/режиссер|\bdirector\b/, 'DIRECTOR'], [/сценар|\bwriter\b/, 'WRITER'], [/продюсер|\bproducer\b/, 'PRODUCER'], [/оператор|\boperator\b/, 'OPERATOR'], [/композитор|\bcomposer\b/, 'COMPOSER'], [/художник|\bdesign\b/, 'DESIGN'], [/монтаж|\beditor\b/, 'EDITOR']] as const) {
    if (pattern.test(words)) result.add(key);
  }
  return result;
}
function matchesNames(query: KinopoiskPersonQuery, name: string, originalName: string): boolean {
  if (query.originalName) {
    return normalize(query.originalName) === normalize(originalName) && (!name || normalize(query.name) === normalize(name) || normalize(query.name) === normalize(originalName));
  }
  const expected = normalize(query.name);
  return !!expected && (expected === normalize(name) || expected === normalize(originalName));
}
function queryFrom(input: unknown): KinopoiskPersonQuery {
  if (!isRecord(input) || Object.keys(input).some(key => !['filmId', 'personId', 'name', 'originalName', 'profession', 'birthDate'].includes(key))) throw invalid();
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\u0000-\u001f\u007f]/.test(input.name)) throw invalid();
  for (const field of ['originalName', 'profession'] as const) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 200 || /[\u0000-\u001f\u007f]/.test(input[field]))) throw invalid();
  if (input.filmId !== undefined && (!identifier(input.filmId) || Number(input.filmId) > 15000000)) throw invalid();
  if (input.personId !== undefined && !identifier(input.personId)) throw invalid();
  if (input.birthDate !== undefined && !date(input.birthDate)) throw invalid();
  return { name: input.name.trim(), ...(input.filmId ? { filmId: input.filmId as string } : {}), ...(input.personId ? { personId: input.personId as string } : {}),
    ...(input.originalName ? { originalName: (input.originalName as string).trim() } : {}), ...(input.profession ? { profession: (input.profession as string).trim() } : {}), ...(input.birthDate ? { birthDate: input.birthDate as string } : {}) };
}
function staffFrom(input: unknown): Staff[] {
  if (!Array.isArray(input) || input.length > 10000) throw malformed();
  return input.map(item => {
    if (!isRecord(item) || !numericId(item.staffId) || (item.nameRu != null && typeof item.nameRu !== 'string') || (item.nameEn != null && typeof item.nameEn !== 'string') || typeof item.professionKey !== 'string') throw malformed();
    return { id: String(item.staffId), name: plain(item.nameRu, 200), originalName: plain(item.nameEn, 200), profession: item.professionKey };
  });
}
function profileFrom(input: unknown, id: string): Profile {
  if (!isRecord(input) || numericId(input.personId) !== id || (!plain(input.nameRu, 200) && !plain(input.nameEn, 200)) || !Array.isArray(input.facts)) throw malformed();
  const name = plain(input.nameRu, 200) || plain(input.nameEn, 200), originalName = plain(input.nameEn, 200);
  const facts: KinopoiskPerson['facts'] = [], add = (label: string, value: string) => { if (value) facts.push({ label, value }); };
  add('Карьера', plain(input.profession));
  const birthDate = date(input.birthday), death = date(input.death);
  if (birthDate) add('Дата рождения', birthDate.split('-').reverse().join('.'));
  add('Место рождения', plain(input.birthplace));
  if (death) add('Дата смерти', death.split('-').reverse().join('.'));
  add('Место смерти', plain(input.deathplace));
  if (Number.isInteger(input.growth) && Number(input.growth) > 0 && Number(input.growth) < 300) add('Рост', `${input.growth} см`);
  if (Number.isInteger(input.hasAwards) && Number(input.hasAwards) > 0) add('Награды', 'Есть');
  let photo: string | undefined;
  if (typeof input.posterUrl === 'string' && input.posterUrl.length <= 2048) {
    try {
      const url = new URL(input.posterUrl);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['kinopoiskapiunofficial.tech', 'st.kp.yandex.net', 'avatars.mds.yandex.net'].includes(url.hostname)) photo = url.href;
    } catch { /* Ignore malformed image URLs from the provider. */ }
  }
  const trivia = [...new Set(input.facts.slice(0, 100).map(item => plain(item, 3000)).filter(Boolean))];
  return { nameRu: plain(input.nameRu, 200), ...(birthDate ? { birthDate } : {}), person: { id, name, ...(originalName ? { originalName } : {}), ...(photo ? { photo } : {}), profileUrl: `https://www.kinopoisk.ru/name/${id}/`, facts, trivia } };
}

export function createKinopoisk(options: KinopoiskOptions): KinopoiskService {
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  const requestTimeout = options.requestTimeoutMs ?? 6000, personTimeout = options.personTimeoutMs ?? 17000;
  if (!options.storagePath || !Number.isFinite(requestTimeout) || requestTimeout <= 0 || requestTimeout > 7000 || !Number.isFinite(personTimeout) || personTimeout <= 0 || personTimeout > 18000) throw invalid();
  let apiKey = '', revision = 0, generation = 0, closed = false;
  let writes: Promise<unknown> = Promise.resolve();
  const controllers = new Set<AbortController>(), staff = new Map<string, Cached<Staff[]>>(), profiles = new Map<string, Cached<Profile>>();
  const staffPending = new Map<string, Promise<Staff[]>>(), profilePending = new Map<string, Promise<Profile>>();
  const ready = (async () => {
    try {
      const file = await open(options.storagePath, 'r');
      try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size > 4096) throw storageError();
        const value: unknown = JSON.parse(await file.readFile('utf8'));
        if (!isRecord(value) || value.schemaVersion !== 1 || !validKey(value.apiKey) || !value.apiKey || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw storageError();
        apiKey = value.apiKey; revision = Number(value.revision);
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw storageError(); }
  })();
  // Keep startup failures private and observable through the public methods.
  void ready.catch(() => {});
  function check(epoch?: number) {
    if (closed) throw new KinopoiskError('kinopoisk_closed', 'Сервис Кинопоиска остановлен.');
    if (epoch !== undefined && epoch !== generation) throw stale();
  }
  function invalidate() {
    generation++; for (const controller of controllers) controller.abort();
    staff.clear(); profiles.clear(); staffPending.clear(); profilePending.clear();
  }
  async function request(path: string, token: string, epoch: number, deadline: number): Promise<unknown> {
    check(epoch);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new KinopoiskError('kinopoisk_timeout', 'Кинопоиск не ответил вовремя. Повторите позже.');
    const controller = new AbortController(); controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(requestTimeout, remaining));
    let rejectAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new KinopoiskError(timedOut ? 'kinopoisk_timeout' : 'kinopoisk_stale', timedOut ? 'Кинопоиск не ответил вовремя. Повторите позже.' : 'Настройки Кинопоиска изменились. Повторите запрос.'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      const response = await Promise.race([fetcher(`https://kinopoiskapiunofficial.tech${path}`, { method: 'GET', headers: { Accept: 'application/json', 'X-API-KEY': token }, redirect: 'manual', credentials: 'omit', signal: controller.signal }), abort]);
      check(epoch);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        const errors: Record<number, [string, string]> = {
          401: ['kinopoisk_invalid_key', 'Ключ Кинопоиска не принят. Проверьте его в настройках.'],
          402: ['kinopoisk_quota', 'Лимит запросов Кинопоиска исчерпан. Повторите позже.'],
          403: ['kinopoisk_forbidden', 'API Кинопоиска недоступен для этого аккаунта.'],
          404: ['kinopoisk_not_found', 'Кинопоиск не нашёл эти сведения.'],
          429: ['kinopoisk_rate_limit', 'Слишком много запросов к Кинопоиску. Повторите позже.'],
        };
        const [code, message] = errors[response.status] ?? ['kinopoisk_unavailable', 'API Кинопоиска временно недоступен.'];
        throw new KinopoiskError(code, message);
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > maxBytes) { void response.body?.cancel().catch(() => {}); throw malformed(); }
      const reader = response.body?.getReader(); if (!reader) throw malformed();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const item = await Promise.race([reader.read(), abort]); check(epoch);
          if (item.done) break;
          bytes += item.value.byteLength; if (bytes > maxBytes) throw malformed();
          chunks.push(item.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw malformed(); }
    } catch (error) {
      check(epoch);
      if (error instanceof KinopoiskError) throw error;
      throw new KinopoiskError('kinopoisk_unavailable', 'Не удалось связаться с API Кинопоиска.');
    } finally {
      clearTimeout(timer); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      controllers.delete(controller);
    }
  }
  async function cached<T>(id: string, cache: Map<string, Cached<T>>, pending: Map<string, Promise<T>>, maximum: number, epoch: number, read: () => Promise<T>): Promise<T> {
    check(epoch); const found = cache.get(id);
    if (found && found.expiresAt > now()) return found.value;
    cache.delete(id);
    const running = pending.get(id); if (running) return running;
    const work = read().then(value => {
      check(epoch); if (cache.size >= maximum) cache.delete(cache.keys().next().value!);
      cache.set(id, { value, expiresAt: now() + ttl }); return value;
    }).finally(() => { if (pending.get(id) === work) pending.delete(id); });
    pending.set(id, work); return work;
  }
  async function status(): Promise<KinopoiskStatus> { await ready; check(); return { configured: !!apiKey, revision }; }
  function setKey(input: unknown): Promise<KinopoiskStatus> {
    if (!isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'apiKey') || typeof input.apiKey !== 'string' || !validKey(input.apiKey.trim())) return Promise.reject(invalid());
    const nextKey = input.apiKey.trim();
    const write = async () => {
      await ready; check(); invalidate(); const epoch = generation;
      if (nextKey) profileFrom(await request('/api/v1/staff/66539', nextKey, epoch, Date.now() + requestTimeout), '66539');
      check(epoch);
      if (revision === Number.MAX_SAFE_INTEGER) throw storageError();
      const nextRevision = revision + 1;
      if (nextKey) {
        const temporary = `${options.storagePath}.${randomBytes(12).toString('hex')}.tmp`;
        try {
          await mkdir(dirname(options.storagePath), { recursive: true, mode: 0o700 });
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify({ schemaVersion: 1, revision: nextRevision, apiKey: nextKey }) + '\n', 'utf8'); await file.sync(); }
          finally { await file.close(); }
          check(epoch); await rename(temporary, options.storagePath);
        } catch (error) { if (error instanceof KinopoiskError) throw error; throw storageError(); }
        finally { await unlink(temporary).catch(() => {}); }
      } else {
        try { await unlink(options.storagePath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw storageError(); }
      }
      apiKey = nextKey; revision = nextRevision; check(epoch); invalidate();
      return { configured: !!apiKey, revision };
    };
    const result = writes.then(write, write); writes = result; return result;
  }
  async function person(input: unknown): Promise<KinopoiskResult> {
    const deadline = Date.now() + personTimeout, query = queryFrom(input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready.then(() => writes.catch(() => {})),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new KinopoiskError('kinopoisk_timeout', 'Кинопоиск не ответил вовремя. Повторите позже.')), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally { clearTimeout(timer); }
    check();
    if (!apiKey) return { status: 'disabled' };
    if (!query.personId && !query.filmId) return { status: 'unmatched' };
    const epoch = generation, token = apiKey;
    let id = query.personId;
    try {
      if (!id && query.filmId) {
        const people = await cached(query.filmId, staff, staffPending, 128, epoch, async () => staffFrom(await request(`/api/v1/staff?filmId=${query.filmId}`, token, epoch, deadline)));
        check(epoch); const professions = professionKeys(query.profession);
        const candidates = [...new Set(people.filter(item => matchesNames(query, item.name, item.originalName) && (!professions.size || professions.has(item.profession))).map(item => item.id))];
        if (!candidates.length) return { status: 'unmatched' };
        if (candidates.length > 1) return { status: 'ambiguous' };
        id = candidates[0];
      }
      const profile = await cached(id!, profiles, profilePending, 64, epoch, async () => profileFrom(await request(`/api/v1/staff/${id}`, token, epoch, deadline), id!));
      check(epoch);
      if (!matchesNames(query, profile.nameRu, profile.person.originalName ?? '') || (query.birthDate && query.birthDate !== profile.birthDate)) return { status: 'unmatched' };
      return { status: 'matched', person: structuredClone(profile.person) };
    } catch (error) {
      check(epoch); if (error instanceof KinopoiskError && error.code === 'kinopoisk_not_found') return { status: 'unmatched' };
      throw error;
    }
  }
  async function close() { closed = true; invalidate(); await ready.catch(() => {}); await writes.catch(() => {}); apiKey = ''; }
  return { status, setKey, person, close };
}
