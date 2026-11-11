import type { SeriesUpdate } from '../shared/source';
import { safeHttpUrl } from './provider-codec';

const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const ownText = (node: Element | null | undefined): string =>
  [...(node?.childNodes ?? [])].filter(child => child.nodeType === 3).map(child => child.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();

/**
 * Reads the «series updates» block that the source shows on its catalog pages:
 * released episodes grouped by day. Rows with the `tracked` class belong to
 * series the signed-in account follows.
 */
export function parseSeriesUpdates(doc: ParentNode, base: string): SeriesUpdate[] {
  const origin = safeHttpUrl(base);
  if (!origin) return [];
  const result: SeriesUpdate[] = [], seen = new Set<string>();
  for (const block of doc.querySelectorAll('.b-seriesupdate__block')) {
    const date = text(block.querySelector('.b-seriesupdate__block_date')).replace(/\s*развернуть\s*$/i, '') || undefined;
    for (const row of block.querySelectorAll('li.b-seriesupdate__block_list_item')) {
      const link = row.querySelector('a.b-seriesupdate__block_list_link');
      const safe = safeHttpUrl(link?.getAttribute('href'), base), title = text(link);
      if (!safe || !title) continue;
      const url = new URL(safe);
      const id = url.pathname.match(/\/([1-9]\d{0,11})(?:-[^/]+)?\.html$/)?.[1];
      if (url.origin !== new URL(origin).origin || !id) continue;
      url.search = ''; url.hash = '';
      const cell = row.querySelector('span.cell');
      const season = text(row.querySelector('span.season')).replace(/^\(|\)$/g, ''), episode = ownText(cell), voice = text(cell?.querySelector('i')).replace(/^\(|\)$/g, '');
      const key = JSON.stringify([url.href, season, episode, voice]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ url: url.href, id, title, season, episode, ...(voice ? { voice } : {}), ...(date ? { date } : {}), tracked: row.classList.contains('tracked') });
    }
  }
  return result;
}

const number = (label: string): string | undefined => label.match(/\d+/)?.[0];
/** «Сезон 2, серия 5» from the source labels, or the labels themselves when they carry no numbers. */
export function updateLabel(update: Pick<SeriesUpdate, 'season' | 'episode'>): string {
  const season = number(update.season), episode = number(update.episode);
  if (season && episode) return `Сезон ${season}, серия ${episode}`;
  return [update.season, update.episode].filter(Boolean).join(', ');
}
