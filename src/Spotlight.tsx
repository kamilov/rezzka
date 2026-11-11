import type { TitleRating, TitleSummary } from '../shared/source';
import { isDemoTitle } from './demo-source';
import { useCardBrief } from './useCardRatings';

const kinds: Record<TitleSummary['kind'], string> = { film: 'Фильм', series: 'Сериал', cartoon: 'Мультфильм', anime: 'Аниме', unknown: '' };
const short: Record<string, string> = { 'Кинопоиск': 'КП', IMDb: 'IMDb' };

/**
 * Tells what is under focus on the home screen: its name in full, ratings and a
 * short description, so a title can be judged without opening its card.
 * `note` replaces the kind line, for example with where the viewer stopped.
 */
export default function Spotlight({ title, note, placeholder }: { title?: TitleSummary; note?: string; placeholder: string }) {
  const brief = useCardBrief(title, !!title && !isDemoTitle(title));
  const ratings = new Map<string, TitleRating>();
  for (const rating of [...(title?.ratings ?? []), ...(brief?.ratings ?? [])]) if (short[rating.source] && !ratings.has(rating.source)) ratings.set(rating.source, rating);
  if (title?.rating && !ratings.has('Кинопоиск')) ratings.set('Кинопоиск', { source: 'Кинопоиск', value: title.rating });
  return <section className="spotlight" data-pinned aria-label="Под фокусом" data-testid="spotlight">
    <p className="spotlight-kind">{title ? note || kinds[title.kind] : ''}{' '}</p>
    <h2 className="spotlight-title" data-testid="spotlight-title">{title?.title ?? placeholder}</h2>
    <div className="spotlight-meta">
      {[...ratings.values()].map(rating => <span className="score" key={rating.source} aria-label={`${rating.source}: ${rating.value}`}><span>{short[rating.source]}</span>{rating.value}</span>)}
      {title && <span>{title.meta || title.year}</span>}
    </div>
    <p className="spotlight-description" data-testid="spotlight-description">{brief?.description}</p>
  </section>;
}
