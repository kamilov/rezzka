import type { ComponentType, ReactNode } from 'react';
import { doesFocusableExist, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { TitleDetails, TitlePerson, TitleSummary } from '../shared/source';
import { TVButton, useTVFocusEnabled } from './navigation';
import './title-information.css';

const initials = (name: string) => name.split(/\s+/).map(word => word[0] ?? '').join('').slice(0, 2).toLocaleUpperCase('ru');

/** Long text inside a page: Up and Down scroll the page until the text ends, then move focus. */
export function ReadingRegion({ id, label, children, returnFocus, className = '' }: { id: string; label: string; children: ReactNode; returnFocus?: string; className?: string }) {
  const enabled = useTVFocusEnabled();
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: enabled,
    onFocus: () => ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
    onArrowPress: direction => {
      const element = ref.current as HTMLElement | undefined;
      if (!element || !['up', 'down'].includes(direction)) return true;
      const page = element.closest('main');
      if (page) {
        const bounds = element.getBoundingClientRect(), viewport = page.getBoundingClientRect();
        const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
        const hidden = direction === 'up' ? viewport.top + margin - bounds.top : bounds.bottom - viewport.bottom + margin;
        if (hidden > 1) {
          const previous = page.scrollTop, step = Math.min(hidden, Math.max(100, page.clientHeight * .65));
          page.scrollTop += direction === 'up' ? -step : step;
          if (Math.abs(page.scrollTop - previous) > .5) return false;
        }
      }
      if (direction === 'up' && returnFocus && doesFocusableExist(returnFocus)) { void setFocus(returnFocus); return false; }
      return true;
    },
  });
  return <div ref={ref} role="region" aria-label={label} tabIndex={enabled ? 0 : -1} data-testid={id} data-focused={focused || undefined}
    className={`details-reading ${focused ? 'is-focused' : ''} ${className}`} onFocus={event => { if (event.target === event.currentTarget && enabled) focusSelf(); }}
    onClick={() => { if (enabled) focusSelf(); }}>{children}</div>;
}

function PersonTile({ person, index, onOpen }: { person: TitlePerson; index: number; onOpen: (person: TitlePerson) => void }) {
  // A person without a page on the source is still shown and reachable, but opens nothing.
  return <TVButton id={`details-person-${index}`} className="person-tile" label={`${person.name}${person.job ? `, ${person.job}` : ''}`}
    onPress={() => { if (person.url) onOpen(person); }}>
    <span className="person-photo">{person.photo
      ? <img src={person.photo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />
      : null}<span aria-hidden="true">{initials(person.name)}</span></span>
    <span className="person-name">{person.name}</span>{person.job && <span className="person-job">{person.job}</span>}
  </TVButton>;
}

/** The rows under a title's header: people, other parts of the franchise and similar titles. */
export default function TitleInformation({ title, onOpen, onOpenPerson, Poster }: {
  title: TitleDetails; onOpen: (title: TitleSummary) => void; onOpenPerson: (person: TitlePerson, kinopoiskFilmId?: string) => void;
  Poster: ComponentType<{ title: TitleSummary }>;
}) {
  return <>
    {!!title.people?.length && <section className="title-section" data-anchor aria-label="Актёры и авторы">
      <h2>Актёры и авторы</h2>
      <div className="poster-row" data-row data-testid="details-people-content">{title.people.map((person, index) =>
        <PersonTile key={`${person.id ?? person.name}-${index}`} person={person} index={index} onOpen={item => onOpenPerson(item, title.kinopoiskFilmId)} />)}</div>
    </section>}
    {!!title.franchise?.length && <section className="title-section" data-anchor aria-label="Части и продолжения">
      <h2>Части и продолжения</h2>
      <div className="poster-row" data-row data-testid="details-franchise-content">{title.franchise.map((part, index) => {
        const content = <><strong>{part.title}</strong><span className="episode-name">{part.year}</span></>;
        if (part.url && part.id && part.id !== title.id) {
          return <TVButton key={`${part.title}-${index}`} id={`details-franchise-${index}`} className="episode-tile wide"
            onPress={() => onOpen({ id: part.id!, url: part.url!, title: part.title, year: part.year, rating: part.rating, ratings: part.rating ? [{ source: 'Кинопоиск', value: part.rating }] : undefined, poster: '', kind: 'unknown' })}>
            {content}<span className="episode-date">{part.rating ? `КП ${part.rating}` : ''}</span></TVButton>;
        }
        const current = part.id === title.id || (!part.url && part.title === title.title);
        return <div key={`${part.title}-${index}`} className={`episode-tile wide ${current ? 'is-current' : 'is-upcoming'}`} data-testid={`details-franchise-${index}`}>
          {content}<span className="episode-date">{current ? 'Вы здесь' : 'Недоступна на источнике'}</span></div>;
      })}</div>
    </section>}
    {!!title.related.length && <section className="title-section" data-anchor aria-label="Похожие">
      <h2>Возможно, вас заинтересует</h2>
      <div className="poster-row" data-row>{title.related.map((item, index) =>
        <TVButton key={item.url} id={`related-${index}`} className="poster-button" label={`Открыть ${item.title}`} onPress={() => onOpen(item)}>
          <Poster title={item} /><span className="card-title">{item.title}</span></TVButton>)}</div>
    </section>}
  </>;
}
