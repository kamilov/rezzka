import type { Episode, TitleSummary, Voice } from '../shared/source';

export interface HistoryItem {
  title: TitleSummary; voice: Voice; episode?: Episode;
  position: number; duration: number; updatedAt: number;
}
interface Library { favorites: TitleSummary[]; history: HistoryItem[] }
const STORAGE_KEY = 'rezzka.library.v1';
const LIMIT = 200;
const empty = (): Library => ({ favorites: [], history: [] });
let fallback = empty();
let memoryOnly = false;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
const string = (value: unknown): value is string => typeof value === 'string' && value.length <= 16_384;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function titleKey(url: string) {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; }
  catch { return url.trim(); }
}
function titleValue(value: unknown): TitleSummary | undefined {
  if (!object(value) || !string(value.id) || !string(value.url) || !value.url || !string(value.title) || !value.title || !string(value.poster)) return;
  if (!['film', 'series', 'cartoon', 'anime', 'unknown'].includes(String(value.kind))) return;
  return {
    id: value.id, url: titleKey(value.url), title: value.title, poster: value.poster, kind: value.kind as TitleSummary['kind'],
    ...(string(value.year) ? { year: value.year } : {}), ...(string(value.meta) ? { meta: value.meta } : {}),
    ...(string(value.rating) ? { rating: value.rating } : {}),
  };
}
function voiceValue(value: unknown): Voice | undefined {
  if (!object(value) || !string(value.id) || !value.id || !string(value.label)) return;
  return {
    id: value.id, label: value.label, ...(typeof value.premium === 'boolean' ? { premium: value.premium } : {}),
    ...(string(value.isAds) ? { isAds: value.isAds } : {}), ...(string(value.isCamrip) ? { isCamrip: value.isCamrip } : {}),
    ...(string(value.isDirector) ? { isDirector: value.isDirector } : {}),
  };
}
function episodeValue(value: unknown): Episode | undefined {
  if (!object(value) || !string(value.id) || !value.id || !string(value.season) || !string(value.title)) return;
  return { id: value.id, season: value.season, title: value.title };
}
function progressKey(url: string, voice: string, episode?: Episode) {
  return JSON.stringify([titleKey(url), voice, episode?.season ?? null, episode?.id ?? null]);
}
function historyValue(value: unknown): HistoryItem | undefined {
  if (!object(value) || !finite(value.position) || !finite(value.duration) || !finite(value.updatedAt)) return;
  const title = titleValue(value.title), voice = voiceValue(value.voice);
  const episode = value.episode === undefined ? undefined : episodeValue(value.episode);
  if (!title || !voice || (value.episode !== undefined && !episode)) return;
  return { title, voice, ...(episode ? { episode } : {}), position: value.duration > 0 ? Math.min(value.position, value.duration) : value.position, duration: value.duration, updatedAt: value.updatedAt };
}
function clean(value: unknown): Library {
  if (!object(value)) return empty();
  const favorites: TitleSummary[] = [], history: HistoryItem[] = [], favoriteKeys = new Set<string>(), historyKeys = new Set<string>();
  for (const raw of Array.isArray(value.favorites) ? value.favorites.slice(0, 2_000) : []) {
    const title = titleValue(raw);
    if (title && !favoriteKeys.has(title.url) && favorites.length < LIMIT) { favoriteKeys.add(title.url); favorites.push(title); }
  }
  const candidates = (Array.isArray(value.history) ? value.history.slice(0, 2_000) : []).map(historyValue).filter((item): item is HistoryItem => Boolean(item));
  for (const item of candidates.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = progressKey(item.title.url, item.voice.id, item.episode);
    if (!historyKeys.has(key) && history.length < LIMIT) { historyKeys.add(key); history.push(item); }
  }
  return { favorites, history };
}
export function readLibrary(): Library {
  if (memoryOnly) return clean(fallback);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    fallback = raw ? clean(JSON.parse(raw)) : empty();
  } catch { return clean(fallback); }
  return clean(fallback);
}
function writeLibrary(value: Library) {
  fallback = clean(value);
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback)); memoryOnly = false; }
  catch { memoryOnly = true; }
}
export function isFavorite(title: TitleSummary): boolean {
  return readLibrary().favorites.some((item) => item.url === titleKey(title.url));
}
export function toggleFavorite(title: TitleSummary): boolean {
  const valid = titleValue(title);
  if (!valid) return false;
  const library = readLibrary(), exists = library.favorites.some((item) => item.url === valid.url);
  library.favorites = exists ? library.favorites.filter((item) => item.url !== valid.url) : [valid, ...library.favorites];
  writeLibrary(library);
  return !exists;
}
export function getProgress(titleUrl: string, voiceId: string, episode?: Episode): number {
  const key = progressKey(titleUrl, voiceId, episode);
  return readLibrary().history.find((item) => progressKey(item.title.url, item.voice.id, item.episode) === key)?.position ?? 0;
}
export function saveProgress(item: HistoryItem): void {
  const valid = historyValue(item);
  if (!valid) return;
  const library = readLibrary(), key = progressKey(valid.title.url, valid.voice.id, valid.episode);
  library.history = [valid, ...library.history.filter((entry) => progressKey(entry.title.url, entry.voice.id, entry.episode) !== key)];
  writeLibrary(library);
}
export function clearHistory(): void {
  const library = readLibrary(); library.history = []; writeLibrary(library);
  writeList(SEARCH_KEY, []); writeList(MARKS_KEY, []);
}

/** The most recent thing watched on this device for a title, in any voice. */
export function latestProgress(titleUrl: string): HistoryItem | undefined {
  const key = titleKey(titleUrl);
  return readLibrary().history.find((item) => item.title.url === key);
}

const SEARCH_KEY = 'rezzka.search.v1', MARKS_KEY = 'rezzka.account-marks.v1';
const lists = new Map<string, unknown[]>();
function readList(key: string): unknown[] {
  try { const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]'); if (Array.isArray(value)) lists.set(key, value); }
  catch { /* Storage can be unavailable on the device; the copy in memory keeps the session working. */ }
  return lists.get(key) ?? [];
}
function writeList(key: string, value: unknown[]) {
  lists.set(key, value);
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Kept in memory only. */ }
}

/** Search queries typed on this device, newest first. */
export function readRecentSearches(): string[] {
  return readList(SEARCH_KEY).filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 80).slice(0, 8);
}
export function rememberSearch(query: string): void {
  const text = query.trim().replace(/\s+/g, ' ');
  if (text.length < 2 || text.length > 80) return;
  writeList(SEARCH_KEY, [text, ...readRecentSearches().filter((item) => item.toLocaleLowerCase('ru') !== text.toLocaleLowerCase('ru'))].slice(0, 8));
}

/** The voice and episode the account held for a title when this device last played it or wrote to it. */
export interface AccountMark { voice?: string; season?: string; episode?: string }
const sameMark = (a?: AccountMark, b?: AccountMark) => !!a && !!b && (a.voice ?? '') === (b.voice ?? '') && (a.season ?? '') === (b.season ?? '') && (a.episode ?? '') === (b.episode ?? '');
function marks(): [string, AccountMark][] {
  return readList(MARKS_KEY).filter((item): item is [string, AccountMark] => Array.isArray(item) && typeof item[0] === 'string' && object(item[1])).slice(0, 300);
}
export function readAccountMark(titleUrl: string): AccountMark | undefined {
  const key = titleKey(titleUrl);
  return marks().find((item) => item[0] === key)?.[1];
}
export function writeAccountMark(titleUrl: string, mark: AccountMark): void {
  const key = titleKey(titleUrl);
  writeList(MARKS_KEY, [[key, { voice: mark.voice, season: mark.season, episode: mark.episode }], ...marks().filter((item) => item[0] !== key)].slice(0, 300));
}

/**
 * Decides where a title resumes: from the account's saved voice and episode or from
 * what was last watched on this device.
 * The account wins when it changed since this device last played the title, because
 * then it was watched somewhere else. If it did not change, the device knows better:
 * it may have watched further while the account kept an older episode.
 * Without a mark the further episode wins.
 */
export function resumeSource(account: AccountMark | undefined, mark: AccountMark | undefined, local: HistoryItem | undefined): 'account' | 'local' | 'none' {
  if (!local) return account ? 'account' : 'none';
  if (!account) return 'local';
  if (mark) return sameMark(account, mark) ? 'local' : 'account';
  const position = (season?: string, episode?: string) => Number(season ?? 0) * 100_000 + Number(episode ?? 0);
  return position(account.season, account.episode) > position(local.episode?.season, local.episode?.id) ? 'account' : 'local';
}
