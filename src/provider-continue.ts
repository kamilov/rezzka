import type { ContentKind, Episode, SeriesUpdate, SourceDocument, TitleSummary, Voice } from '../shared/source';
import { documentFrom, getProviderGeneration, ProviderError, sourceData } from './provider';
import { sourceRequest } from './platform';
import { safeHttpUrl } from './provider-codec';
import { updateLabel } from './provider-updates';

/** Account entries identify a saved title; exact playback time is not exposed by this page. */
export interface ContinueItem {
  saveId: string;
  title: TitleSummary;
  dateLabel: string;
  info: string;
  watched: boolean;
}
/** An entry with `fresh` has an episode the viewer has not reached yet. */
export type OrderedContinueItem = ContinueItem & { fresh?: string };

const text = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const attr = (node: Element | null, name: string): string => node?.getAttribute(name)?.trim() ?? '';
const markupError = () => new ProviderError('markup', 'Не удалось распознать историю аккаунта. Разметка источника могла измениться.');
const categories: Record<string, ContentKind> = { films: 'film', series: 'series', cartoons: 'cartoon', animation: 'anime' };

function titleAddress(value: string, base: URL): { url: string; id: string; kind: ContentKind } | undefined {
  const safe = safeHttpUrl(value, base.href);
  if (!safe) return;
  const url = new URL(safe);
  if (url.origin !== base.origin || url.search || (url.hash && url.hash !== '#continue')) return;
  const id = url.pathname.match(/\/([1-9]\d*)(?:-[^/]+)?\.html$/)?.[1];
  if (!id) return;
  url.hash = '';
  return { url: url.href, id, kind: categories[url.pathname.split('/')[1]] ?? 'unknown' };
}

export function parseContinue(source: SourceDocument): ContinueItem[] {
  const doc = documentFrom(source.body);
  const safeBase = safeHttpUrl(source.url);
  if (!safeBase) throw markupError();
  const base = new URL(safeBase);
  const list = doc.querySelector('#videosaves-list, .b-videosaves__list');
  const notice = [text(list), ...[...doc.querySelectorAll('.b-info__message, .b-videosaves__empty, #videosaves-empty')].map(text)].join(' ');
  const items: ContinueItem[] = [], ids = new Set<string>();
  let candidates = 0;
  for (const row of list?.querySelectorAll('.b-videosaves__list_item') ?? []) {
    // The first row is a table heading on the website, not always the first saved title.
    if (!row.id && row.querySelector('.th')) continue;
    candidates++;
    const saveId = row.id.match(/^videosave-([1-9]\d*)$/)?.[1];
    const link = row.querySelector('.title a[href]');
    const address = titleAddress(attr(link, 'href'), base), name = text(link);
    if (!saveId || !address || !name || ids.has(saveId)) continue;
    const meta = text(row.querySelector('.title small'));
    const infoNode = row.querySelector('.info')?.cloneNode(true) as Element | undefined;
    infoNode?.querySelectorAll('.info-holder').forEach((node) => node.remove());
    items.push({
      saveId,
      title: {
        ...address, title: name,
        poster: safeHttpUrl(attr(link, 'data-cover_url') || attr(row.querySelector('a[data-cover_url]'), 'data-cover_url'), base.href) ?? '',
        year: meta.match(/\b(?:19|20)\d{2}\b/)?.[0], meta: meta || undefined,
      },
      dateLabel: text(row.querySelector('.date')),
      info: text(infoNode ?? null),
      watched: row.classList.contains('watched-row') || Boolean(row.querySelector('.view.watched')),
    });
    ids.add(saveId);
  }
  if (items.length) return items;
  if (!candidates && /авторизуйтесь|необходимо\s+(?:авторизоваться|войти)|войдите\s+(?:в|под)|только\s+для\s+зарегистрированных/i.test(notice)) {
    throw new ProviderError('authentication', 'Войдите в аккаунт источника, чтобы открыть историю просмотра.');
  }
  if (!candidates && /(?:нет|не найдено)\s+(?:сохранений|сохраненных|сохранённых|записей)|(?:история|список)\s+(?:просмотра\s+)?пуст|ничего\s+не\s+сохран|(?:ещ[её]\s+)?не\s+сохраняли/i.test(notice)) return [];
  throw markupError();
}

export function loadContinue(): Promise<ContinueItem[]> {
  return sourceData({ operation: 'continue' }, parseContinue);
}

/** Season and episode numbers from a label such as «Сезон 2, серия 3» or «2 сезон 3 серия». */
export function episodeNumbers(label: string): { season: number; episode: number } | undefined {
  const season = label.match(/(\d+)\s*сезон|сезон\s*(\d+)/i), episode = label.match(/(\d+)\s*серия|серия\s*(\d+)/i);
  if (!season || !episode) return;
  return { season: Number(season[1] ?? season[2]), episode: Number(episode[1] ?? episode[2]) };
}

/**
 * The latest episode the source's updates block lists for a series that is further than the one saved in the account.
 * Only a series can have one: a film has no episodes, and an entry without a saved season and episode has nothing to compare.
 * The block lists only series that are still releasing, so a finished series never appears in it.
 */
function releasedAfter(item: ContinueItem, updates: SeriesUpdate[]): SeriesUpdate | undefined {
  const saved = episodeNumbers(item.info);
  if (item.title.kind === 'film' || !saved) return;
  let latest: { update: SeriesUpdate; season: number; episode: number } | undefined;
  for (const update of updates) {
    if (update.url !== item.title.url) continue;
    const next = episodeNumbers(`${update.season} сезон ${update.episode}`);
    if (!next || next.season < saved.season || (next.season === saved.season && next.episode <= saved.episode)) continue;
    if (!latest || next.season > latest.season || (next.season === latest.season && next.episode > latest.episode)) latest = { update, ...next };
  }
  return latest?.update;
}

/**
 * Puts series with a newly released episode first and keeps the source order otherwise.
 * A mark needs the series updates block to list a later episode than the one saved in the account;
 * nothing the account's list says about an entry on its own is taken for news.
 */
export function orderContinue(items: ContinueItem[], updates: SeriesUpdate[] = []): OrderedContinueItem[] {
  const marked = items.map((item): OrderedContinueItem => {
    const released = releasedAfter(item, updates);
    return released ? { ...item, fresh: updateLabel(released) } : item;
  });
  return [...marked.filter(item => item.fresh), ...marked.filter(item => !item.fresh)];
}

/**
 * Tells the account which film, voice and episode is being watched, the way the
 * source's own clients do. The exact position is not sent: it stays on this device.
 */
export async function saveContinue(title: Pick<TitleSummary, 'id' | 'url'>, voice: Voice, episode?: Episode): Promise<void> {
  // Sent in the background while a video plays. A refusal, even an expired sign-in,
  // must not interrupt watching, so it does not go through the shared sign-in check.
  const generation = getProviderGeneration();
  const source = await sourceRequest({ operation: 'continueSave', id: title.id, url: title.url, voice, ...(episode ? { season: episode.season, episode: episode.id } : {}) });
  if (generation !== getProviderGeneration()) throw new ProviderError('unavailable', 'Сессия источника изменилась.');
  let reply: unknown;
  try { reply = JSON.parse(source.body); } catch { throw new ProviderError('markup', 'Источник вернул неизвестный ответ на запись просмотра.'); }
  if (!reply || typeof reply !== 'object' || (reply as { success?: unknown }).success !== true) throw new ProviderError('unavailable', 'Источник не записал просмотр в аккаунт.');
}
