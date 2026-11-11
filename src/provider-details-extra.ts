import type { FranchisePart, ScheduleEpisode, ScheduleSeason, TitleDetails, TitleFact, TitlePerson } from '../shared/source';
import { safeHttpUrl } from './provider-codec';

function text(node: Element | null | undefined): string {
  if (!node) return '';
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll('script, style, form, button, input, select, textarea').forEach(element => element.remove());
  copy.querySelectorAll('br').forEach(element => element.replaceWith(' '));
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}
const attr = (node: Element | null, name: string): string => node?.getAttribute(name)?.trim() ?? '';
const positiveId = (value: string): string | undefined => /^[1-9]\d{0,11}$/.test(value) ? value : undefined;
function sameSourceLink(value: string, base: string, person = false): string | undefined {
  const safe = safeHttpUrl(value, base);
  if (!safe) return undefined;
  const url = new URL(safe);
  const path = person ? /^\/person\/[1-9]\d{0,11}(?:-[^/]+)?(?:\/|\.html)$/ : /\/[1-9]\d{0,11}(?:-[^/]+)?\.html$/;
  return url.origin === new URL(base).origin && !url.search && !url.hash && !/%2f|%5c/i.test(url.pathname) && path.test(url.pathname) ? url.href : undefined;
}

function factsFrom(doc: Document): TitleFact[] {
  const facts: TitleFact[] = [];
  for (const row of doc.querySelectorAll('.b-post__info tr')) {
    const cells = row.querySelectorAll(':scope > td');
    if (cells.length !== 2 || row.querySelector('.persons-list-holder, .person-name-item, .imdb, .kp, .wa')) continue;
    const label = text(cells[0]).replace(/\s*:\s*$/, ''), value = text(cells[1]);
    if (!label || !value || /^Рейтинги?$/i.test(label)) continue;
    if (!facts.some(item => item.label === label && item.value === value)) facts.push({ label, value });
  }
  return facts;
}

function peopleFrom(doc: Document, base: string): TitlePerson[] {
  const people: TitlePerson[] = [], keys = new Set<string>();
  for (const holder of doc.querySelectorAll('.persons-list-holder')) {
    const group = text(holder.querySelector('span.inline h2, h2')).replace(/\s*:\s*$/, '');
    for (const node of holder.querySelectorAll('.person-name-item')) {
      const name = text(node.querySelector('[itemprop="name"]')) || text(node.querySelector('a')) || text(node);
      if (!name) continue;
      const id = positiveId(attr(node, 'data-id'));
      const url = sameSourceLink(attr(node.querySelector('a'), 'href'), base, true);
      const photo = safeHttpUrl(attr(node, 'data-photo') || attr(node.querySelector('img'), 'src'), base);
      const job = attr(node, 'data-job') || group || undefined;
      const key = `${id ?? url ?? name}|${job ?? ''}`;
      if (keys.has(key)) continue;
      keys.add(key);
      people.push({ name, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(job ? { job } : {}),
        ...(photo && !photo.includes('nopersonphoto') ? { photo } : {}) });
    }
  }
  return people;
}

function scheduleFrom(doc: Document, titleName: string): ScheduleSeason[] {
  const schedule: ScheduleSeason[] = [];
  for (const block of doc.querySelectorAll('.b-post__schedule .b-post__schedule_block')) {
    const header = text(block.querySelector('.b-post__schedule_block_title .title'));
    const prefix = `${titleName} - даты выхода серий`;
    let title = (header.startsWith(prefix) ? header.slice(prefix.length).trim() : header).replace(/:\s*$/, '').trim();
    if (title.startsWith('(') && title.endsWith(')')) title = title.slice(1, -1).trim();
    if (!title) continue;
    const episodes: ScheduleEpisode[] = [];
    for (const row of block.querySelectorAll('.b-post__schedule_list tr')) {
      if (row.matches('.admin-schedule-row') || row.querySelector('.load-more')) continue;
      const episode = text(row.querySelector(':scope > .td-1')), dateCell = row.querySelector(':scope > .td-4');
      if (!episode || !dateCell) continue;
      const title = text(row.querySelector(':scope > .td-2 b')) || undefined;
      const relative = text(row.querySelector(':scope > .td-5')) || undefined;
      const watch = row.querySelector(':scope > .td-3 i');
      const date = text(dateCell);
      const number = episode.match(/\d+/)?.[0];
      episodes.push({ episode, ...(number ? { number } : {}), date, ...(title ? { title } : {}), ...(relative ? { relative } : {}),
        ...(watch ? { watched: watch.classList.contains('watched') } : {}) });
    }
    // The numbers let the card match these rows with the playable episodes of a voice.
    const season = title.match(/(\d+)\s*сезон/i)?.[1];
    if (episodes.length) schedule.push({ title, ...(season ? { season } : {}), episodes });
  }
  return schedule;
}

function franchiseFrom(doc: Document, base: string): FranchisePart[] {
  const franchise: FranchisePart[] = [], keys = new Set<string>();
  for (const row of doc.querySelectorAll('.b-post__partcontent_item')) {
    const title = text(row.querySelector('.title'));
    if (!title) continue;
    const url = sameSourceLink(attr(row.querySelector('.title a'), 'href'), base);
    const id = url ? new URL(url).pathname.match(/\/([1-9]\d{0,11})(?:-[^/]+)?\.html$/)?.[1] : undefined;
    const year = text(row.querySelector('.year')) || undefined;
    const rawRating = text(row.querySelector('.rating i')).replace(',', '.');
    const rating = /^(?:\d(?:\.\d{1,3})?|10(?:\.0{1,3})?)$/.test(rawRating) && Number(rawRating) > 0 ? rawRating : undefined;
    const key = url ?? `${title}|${year ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    franchise.push({ title, ...(url ? { url, id } : {}), ...(year ? { year } : {}), ...(rating ? { rating } : {}) });
  }
  return franchise;
}

export function parseDetailsExtra(doc: Document, base: string, titleName: string): Pick<TitleDetails, 'facts' | 'people' | 'schedule' | 'franchise'> {
  return { facts: factsFrom(doc), people: peopleFrom(doc, base), schedule: scheduleFrom(doc, titleName), franchise: franchiseFrom(doc, base) };
}
