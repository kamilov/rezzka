import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleSummary } from '../../shared/source';

const title: TitleSummary = { id: '7', url: 'https://mirror-a.example/films/7.html', title: 'Фильм', poster: '/cover.jpg', kind: 'film' };
const voice = { id: '1', label: 'Оригинал' };
const episode = { id: '2', season: '1', title: 'Серия 2' };
const progress = (overrides: object = {}) => ({ title, voice, position: 30, duration: 100, updatedAt: 1000, ...overrides });
let store: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
let library: typeof import('../../src/library');

beforeEach(async () => {
  vi.resetModules(); store = new Map();
  storage = { getItem: vi.fn((key: string) => store.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { store.set(key, value); }) };
  vi.stubGlobal('window', { localStorage: storage });
  library = await import('../../src/library');
});
afterEach(() => vi.unstubAllGlobals());

describe('local library', () => {
  it('isolates progress by complete source URL, voice, season and episode', () => {
    const anotherMirror = { ...title, url: title.url.replace('mirror-a', 'mirror-b') };
    library.saveProgress(progress({ episode }));
    library.saveProgress(progress({ title: anotherMirror, episode, position: 55 }));
    library.saveProgress(progress({ voice: { ...voice, id: '2' }, episode, position: 70 }));
    library.saveProgress(progress({ episode: { ...episode, season: '2' }, position: 80 }));
    expect(library.getProgress(title.url, '1', episode)).toBe(30);
    expect(library.getProgress(anotherMirror.url, '1', episode)).toBe(55);
    expect(library.getProgress(title.url, '2', episode)).toBe(70);
    expect(library.getProgress(title.url, '1', { ...episode, season: '2' })).toBe(80);
    expect(library.getProgress(title.url, '1')).toBe(0);
    expect(library.getProgress('demo://7', '1', episode)).toBe(0);
  });

  it('replaces one progress record, retains other episodes and bounds positions', () => {
    library.saveProgress(progress({ episode }));
    library.saveProgress(progress({ episode: { ...episode, id: '3' } }));
    library.saveProgress(progress({ episode, position: 999, updatedAt: 2000 }));
    const result = library.readLibrary();
    expect(result.history).toHaveLength(2);
    expect(result.history[0].position).toBe(100);
    expect(result.history[0].updatedAt).toBe(2000);
    expect(library.getProgress(title.url, voice.id, episode)).toBe(100);
  });

  it('toggles favorites by URL, preserves source isolation and returns detached summaries', () => {
    expect(library.toggleFavorite(title)).toBe(true);
    const other = { ...title, url: title.url.replace('mirror-a', 'mirror-b') };
    expect(library.isFavorite(other)).toBe(false);
    library.toggleFavorite(other);
    const read = library.readLibrary(); read.favorites[0].title = 'Изменено';
    expect(library.readLibrary().favorites[0].title).toBe('Фильм');
    expect(library.toggleFavorite({ ...title, url: title.url + '#player' })).toBe(false);
    expect(library.isFavorite(other)).toBe(true);
  });

  it('rejects damaged records and invalid JSON without losing valid records', () => {
    store.set('rezzka.library.v1', JSON.stringify({ favorites: [null, title, { ...title, kind: 'invalid' }], history: [progress(), progress({ position: -1 }), progress({ episode: {} })] }));
    expect(library.readLibrary()).toEqual({ favorites: [title], history: [progress()] });
    store.set('rezzka.library.v1', '{broken');
    expect(() => library.readLibrary()).not.toThrow();
    expect(library.readLibrary().history).toHaveLength(1);
    library.saveProgress(progress({ position: Number.NaN }));
    expect(library.getProgress(title.url, voice.id)).toBe(30);
  });

  it('handles unavailable or full storage using a safe session fallback', () => {
    storage.getItem.mockImplementation(() => { throw new Error('denied'); });
    storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    expect(() => library.saveProgress(progress())).not.toThrow();
    expect(library.getProgress(title.url, voice.id)).toBe(30);
    expect(library.toggleFavorite(title)).toBe(true);
    expect(library.isFavorite(title)).toBe(true);
    library.clearHistory();
    expect(library.readLibrary()).toEqual({ favorites: [title], history: [] });
  });

  it('caps both lists and keeps the most recently updated history', () => {
    const favorites = Array.from({ length: 205 }, (_, index) => ({ ...title, url: title.url + '?item=' + index }));
    const history = favorites.map((item, index) => progress({ title: item, updatedAt: index }));
    store.set('rezzka.library.v1', JSON.stringify({ favorites, history }));
    const read = library.readLibrary();
    expect(read.favorites).toHaveLength(200); expect(read.history).toHaveLength(200);
    expect(read.history[0].updatedAt).toBe(204); expect(read.history.at(-1)?.updatedAt).toBe(5);
    library.clearHistory();
    expect(library.readLibrary().history).toEqual([]); expect(library.readLibrary().favorites).toHaveLength(200);
  });
});
