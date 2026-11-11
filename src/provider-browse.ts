import type { BrowseFilters, BrowsePage, FilterOption, SourceDocument } from '../shared/source';
import { documentFrom, parseCatalog, ProviderError, sourceData } from './provider';

const text = (node: Element) => (node.textContent ?? '').replace(/\s+/g, ' ').trim();

export function parseBrowse(source: SourceDocument, filters: BrowseFilters, page = 1): BrowsePage {
  const doc = documentFrom(source.body), origin = new URL(source.url).origin;
  const prefix = `/${filters.type}/best/`;
  const category = [...doc.querySelectorAll('li.b-topnav__item:not(.single)')].find(item => {
    try {
      const url = new URL(item.querySelector('a.b-topnav__item-link')?.getAttribute('href') ?? '', source.url);
      return url.origin === origin && url.pathname === `/${filters.type}/`;
    } catch { return false; }
  });
  const genres = new Map<string, FilterOption>();
  for (const option of (category ?? doc).querySelectorAll('select.select-category option')) {
    try {
      const url = new URL(option.getAttribute('value') ?? '', source.url);
      if (url.origin !== origin || url.search || url.hash || !url.pathname.startsWith(prefix)) continue;
      const suffix = url.pathname.slice(prefix.length);
      if (suffix && !suffix.endsWith('/')) continue;
      const value = suffix.replace(/\/$/, '');
      if (value.length > 64 || (value && !/^[a-z]+(?:-[a-z]+)*$/.test(value))) continue;
      const label = value ? text(option) : 'Все жанры';
      if (label) genres.set(value, { value, label });
    } catch { /* Ignore links outside the source's supported category routes. */ }
  }
  const years = new Map<string, FilterOption>();
  for (const option of (category ?? doc).querySelectorAll('select.select-year option')) {
    const raw = option.getAttribute('value')?.trim() ?? text(option);
    if (raw !== '0' && !/^(?:18|19|20)\d{2}$/.test(raw)) continue;
    const value = raw === '0' ? '' : raw;
    years.set(value, { value, label: value || 'Все годы' });
  }
  if (!genres.size || !years.size) throw new ProviderError('markup', 'Источник не предоставил фильтры каталога. Повторите загрузку или проверьте зеркало.');
  return { ...parseCatalog(source, page), genres: [...genres.values()], years: [...years.values()] };
}

export function loadBrowse(filters: BrowseFilters, page = 1): Promise<BrowsePage> {
  return sourceData({ operation: 'browse', ...filters, page }, source => parseBrowse(source, filters, page));
}
