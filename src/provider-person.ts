import type { PersonDetails, PersonFilmography, SourceDocument, TitleFact } from '../shared/source';
import { documentFrom, parseCatalog, ProviderError, sourceData } from './provider';
import { safeHttpUrl } from './provider-codec';

function text(node: Element | null): string {
  if (!node) return '';
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll('script, style, form, button, input, select, textarea').forEach(element => element.remove());
  copy.querySelectorAll('br').forEach(element => element.replaceWith(' '));
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function parsePerson(source: SourceDocument): PersonDetails {
  const doc = documentFrom(source.body), safe = safeHttpUrl(source.url);
  const url = safe ? new URL(safe) : undefined;
  const id = url?.pathname.match(/^\/person\/([1-9]\d{0,11})(?:-[^/]+)?(?:\/|\.html)$/)?.[1];
  const name = text(doc.querySelector('.b-post__title h1 [itemprop="name"], .b-post__title h1 .t1'));
  if (!url || !id || url.search || url.hash || /%2f|%5c/i.test(url.pathname) || !name) {
    throw new ProviderError('markup', 'Не удалось распознать страницу актёра или автора.');
  }
  const originalName = text(doc.querySelector('.b-post__title h1 [itemprop="alternativeHeadline"], .b-post__title h1 .t2'));
  const photo = safeHttpUrl(doc.querySelector('.b-sidecover img[itemprop="image"]')?.getAttribute('src'), url.href);
  const rawBirthDate = doc.querySelector('.b-post__info [itemprop="birthDate"][datetime]')?.getAttribute('datetime')?.trim();
  const birthDate = rawBirthDate && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(rawBirthDate) && Number.isFinite(Date.parse(rawBirthDate)) &&
    new Date(rawBirthDate).toISOString().slice(0, 10) === rawBirthDate ? rawBirthDate : undefined;
  const facts: TitleFact[] = [];
  for (const row of doc.querySelectorAll('table.b-post__info tr')) {
    const cells = row.querySelectorAll(':scope > td');
    if (cells.length !== 2) continue;
    const label = text(cells[0]).replace(/\s*:\s*$/, ''), value = text(cells[1]);
    if (label && value && !facts.some(fact => fact.label === label && fact.value === value)) facts.push({ label, value });
  }
  const filmography: PersonFilmography[] = [];
  for (const group of doc.querySelectorAll('.b-person__career')) {
    const role = text(group.querySelector('h2'));
    if (!role) continue;
    const items = group.querySelector('.b-content__inline_item') ? parseCatalog({ body: group.outerHTML, url: url.href }).items.filter(item => {
      const film = new URL(item.url);
      return film.origin === url.origin && !film.search && !film.hash && /^\/(?:films|series|cartoons|animation)\/(?:[^/]+\/)*[1-9]\d{0,11}(?:-[^/]+)?\.html$/.test(film.pathname);
    }) : [];
    const existing = filmography.find(item => item.role === role);
    if (existing) existing.items.push(...items.filter(item => !existing.items.some(previous => previous.url === item.url)));
    else filmography.push({ role, items });
  }
  return { id, url: url.href, name, ...(originalName ? { originalName } : {}),
    ...(photo && !photo.includes('nopersonphoto') ? { photo } : {}), ...(birthDate ? { birthDate } : {}), facts, filmography };
}

export function loadPerson(url: string): Promise<PersonDetails> {
  return sourceData({ operation: 'person', url }, parsePerson);
}
