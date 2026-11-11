import type { Playback, TitleDetails, TitleSummary } from '../shared/source';

const entries = [
  ['orbit', 'Sintel', '2010', 'sintel.jpg'],
  ['coast', 'Spring', '2019', 'spring.jpg'],
  ['city', 'Tears of Steel', '2012', 'tears-of-steel.png'],
  ['forest', 'Sprite Fright', '2021', 'sprite-fright.jpg'],
  ['sand', 'Big Buck Bunny', '2008', 'big-buck-bunny.jpg'],
] as const;
export const demoCatalog: TitleSummary[] = entries.map(([id, title, year, file]) => ({
  id, title, year, url: `demo://${id}`, poster: `${import.meta.env.BASE_URL}assets/posters/${file}`, kind: 'film', meta: `${year} · Blender Open Movie`,
}));
export const isDemoTitle = (title: TitleSummary) => title.url.startsWith('demo://');
export function demoDetails(title: TitleSummary): TitleDetails {
  return { ...title, description: 'Демонстрация интерфейса с постерами Blender Open Movies. Кнопка просмотра запускает локальный тестовый ролик на 12 секунд, а не сам фильм.', voices: [{ id: 'demo', label: 'Тестовый ролик' }], episodes: [], related: [], isSeries: false };
}
export function demoPlayback(): Playback {
  return { streams: [{ quality: '720p', url: `${import.meta.env.BASE_URL}demo/sample.mp4` }], subtitles: [] };
}
