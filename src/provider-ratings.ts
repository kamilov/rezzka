import type { SourceDocument, TitleRating, TitleSummary } from '../shared/source';
import { documentFrom, ProviderError, sourceData } from './provider';
import { safeHttpUrl } from './provider-codec';

const markupError = () => new ProviderError('markup', 'Не удалось распознать оценки фильма.');
const titleId = (url: URL): string | undefined => url.pathname.match(/\/([1-9]\d{0,11})(?:-[^/]+)?\.html$/)?.[1];
function titleAddress(title: TitleSummary): URL {
  const safe = safeHttpUrl(title.url);
  if (!safe || !/^[1-9]\d{0,11}$/.test(title.id)) throw markupError();
  const url = new URL(safe);
  if (url.search || url.hash || titleId(url) !== title.id) throw markupError();
  return url;
}
function ratingValue(value: string | null): string | undefined {
  const normalized = value?.trim().replace(',', '.');
  return normalized && /^(?:\d(?:\.\d{1,3})?|10(?:\.0{1,3})?)$/.test(normalized) && Number(normalized) > 0 ? normalized : undefined;
}

/** What the source's short card says about a title: its ratings and a brief description. */
export interface CardBrief { ratings: TitleRating[]; description?: string }

export function parseCardRatings(source: SourceDocument, title: TitleSummary): TitleRating[] {
  return parseCardBrief(source, title).ratings;
}

export function parseCardBrief(source: SourceDocument, title: TitleSummary): CardBrief {
  const expected = titleAddress(title), safe = safeHttpUrl(source.url), doc = documentFrom(source.body);
  if (!safe) throw markupError();
  const response = new URL(safe);
  if (response.origin !== expected.origin || !response.pathname.endsWith('/engine/ajax/quick_content.php') || response.search || response.hash) throw markupError();
  // The endpoint returns a fragment; the website adds the outer bubble wrappers itself.
  const wrappers = doc.querySelectorAll('.b-content__bubble_content');
  if (wrappers.length > 1) throw markupError();
  const bubbles = wrappers.length ? [] : doc.querySelectorAll('.b-content__bubble');
  if (bubbles.length > 1) throw markupError();
  const scope = wrappers[0] ?? bubbles[0] ?? doc.body;
  const titles = scope.querySelectorAll(':scope > .b-content__bubble_title > a[href]');
  if (titles.length !== 1 || !titles[0].textContent?.trim() ||
      !scope.querySelector(':scope > .b-content__bubble_rates, :scope > .b-content__bubble_text, :scope > .b-content__bubble_rating, :scope > .b-content__catlabel')) throw markupError();
  const address = safeHttpUrl(titles[0].getAttribute('href'), response.href);
  if (!address) throw markupError();
  const actual = new URL(address);
  if (actual.origin !== expected.origin || actual.search || actual.hash || titleId(actual) !== title.id) throw markupError();
  const result: TitleRating[] = [];
  for (const [className, source] of [['kp', 'Кинопоиск'], ['imdb', 'IMDb']] as const) {
    const nodes = scope.querySelectorAll(`:scope > .b-content__bubble_rates > span.${className} > b`);
    if (nodes.length !== 1) continue;
    const value = ratingValue(nodes[0].textContent);
    if (value) result.push({ source, value });
  }
  const description = (scope.querySelector(':scope > .b-content__bubble_text')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { ratings: result, ...(description ? { description } : {}) };
}

export async function loadCardBrief(title: TitleSummary): Promise<CardBrief> {
  const url = titleAddress(title).href;
  return sourceData({ operation: 'ratings', url, id: title.id }, source => parseCardBrief(source, title));
}

export async function loadCardRatings(title: TitleSummary): Promise<TitleRating[]> {
  return (await loadCardBrief(title)).ratings;
}
