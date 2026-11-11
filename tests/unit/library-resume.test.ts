import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleSummary } from '../../shared/source';

const title: TitleSummary = { id: '7', url: 'https://mirror-a.example/series/7-name.html', title: 'Сериал', poster: '', kind: 'series' };
const voice = { id: '1', label: 'Студия' };
const local = (season: string, id: string, updatedAt = 1000) => ({ title, voice, episode: { season, id, title: `Серия ${id}` }, position: 30, duration: 100, updatedAt });
let store: Map<string, string>;
let library: typeof import('../../src/library');

beforeEach(async () => {
  vi.resetModules(); store = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } } });
  library = await import('../../src/library');
});
afterEach(() => vi.unstubAllGlobals());

describe('where a title resumes', () => {
  it('uses the account when nothing was watched on this device, and nothing when neither side knows', () => {
    expect(library.resumeSource({ voice: '1', season: '2', episode: '3' }, undefined, undefined)).toBe('account');
    expect(library.resumeSource(undefined, undefined, undefined)).toBe('none');
    expect(library.resumeSource(undefined, undefined, local('1', '4'))).toBe('local');
  });

  it('keeps the device position while the account still holds what this device last saw', () => {
    const mark = { voice: '1', season: '2', episode: '3' };
    expect(library.resumeSource({ ...mark }, mark, local('2', '6'))).toBe('local');
  });

  it('follows the account once it changed elsewhere, even to an earlier episode', () => {
    const mark = { voice: '1', season: '2', episode: '3' };
    expect(library.resumeSource({ voice: '1', season: '2', episode: '8' }, mark, local('2', '6'))).toBe('account');
    expect(library.resumeSource({ voice: '1', season: '1', episode: '1' }, mark, local('2', '6'))).toBe('account');
    expect(library.resumeSource({ voice: '4', season: '2', episode: '3' }, mark, local('2', '6'))).toBe('account');
  });

  it('prefers the further episode when this device has no record of the account state', () => {
    expect(library.resumeSource({ voice: '1', season: '2', episode: '3' }, undefined, local('2', '6'))).toBe('local');
    expect(library.resumeSource({ voice: '1', season: '3', episode: '1' }, undefined, local('2', '6'))).toBe('account');
    expect(library.resumeSource({ voice: '1', season: '2', episode: '6' }, undefined, local('2', '6'))).toBe('local');
  });

  it('stores one account mark per title address and returns the newest', () => {
    library.writeAccountMark(title.url + '#continue', { voice: '1', season: '1', episode: '2' });
    library.writeAccountMark(title.url, { voice: '1', season: '1', episode: '3' });
    expect(library.readAccountMark(title.url)).toEqual({ voice: '1', season: '1', episode: '3' });
    expect(library.readAccountMark('https://mirror-a.example/series/8-other.html')).toBeUndefined();
    expect(JSON.parse(store.get('rezzka.account-marks.v1')!)).toHaveLength(1);
  });

  it('reports the latest progress of a title regardless of voice', () => {
    library.saveProgress(local('1', '2', 1000));
    library.saveProgress({ ...local('1', '5', 3000), voice: { id: '9', label: 'Другая' } });
    library.saveProgress({ ...local('1', '9', 2000), title: { ...title, url: 'https://mirror-a.example/series/8-other.html', id: '8' } });
    expect(library.latestProgress(title.url)?.episode?.id).toBe('5');
  });
});

describe('recent searches', () => {
  it('keeps the newest eight queries, moves a repeated one to the front and ignores short text', () => {
    for (const query of ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']) library.rememberSearch(query);
    library.rememberSearch('  ТРИ  '); library.rememberSearch('я'); library.rememberSearch('   ');
    expect(library.readRecentSearches()).toEqual(['ТРИ', 'девять', 'восемь', 'семь', 'шесть', 'пять', 'четыре', 'два']);
  });

  it('forgets queries and account marks together with the viewing history', () => {
    library.rememberSearch('маяк'); library.writeAccountMark(title.url, { voice: '1' }); library.saveProgress(local('1', '2'));
    library.clearHistory();
    expect(library.readRecentSearches()).toEqual([]);
    expect(library.readAccountMark(title.url)).toBeUndefined();
    expect(library.latestProgress(title.url)).toBeUndefined();
  });

  it('keeps working in memory when storage refuses to write', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
    library.rememberSearch('станция');
    expect(library.readRecentSearches()).toEqual(['станция']);
  });
});
