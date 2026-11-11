import { useEffect, useRef, useState } from 'react';
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { BrowseFilters, BrowsePage, BrowseType, FilterOption, TitleSummary } from '../shared/source';
import { loadBrowse } from './provider-browse';
import { focusSoon, isBack, TVButton } from './navigation';
import { PosterImage } from './TitleScreen';
import Icon from './Icon';
import { LoadMoreTrigger } from './LoadMoreTrigger';
import { TopbarTools } from './MainContent';
import './browse.css';

const types: { value: BrowseType; label: string }[] = [
  { value: 'films', label: 'Фильмы' }, { value: 'series', label: 'Сериалы' },
  { value: 'cartoons', label: 'Мультфильмы' }, { value: 'animation', label: 'Аниме' },
];
const defaults: BrowseFilters = { type: 'films', genre: '', year: '' };
interface Results extends BrowsePage { loading: boolean; loaded: boolean; error: string; failedPage?: number }
const empty = (): Results => ({ items: [], genres: [], years: [], loading: false, loaded: false, error: '' });
type Filter = 'genre' | 'year';

function FilterDialog({ filter, options, value, onChoose, onClose }: {
  filter: Filter; options: FilterOption[]; value: string; onChoose: (value: string) => void; onClose: () => void;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: 'BROWSE_FILTER', isFocusBoundary: true, focusBoundaryDirections: ['left', 'right', 'up', 'down'] });
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const selected = options.findIndex(option => option.value === value);
    focusSoon(selected >= 0 ? `browse-${filter}-option-${selected}` : 'browse-filter-close');
    const key = (event: KeyboardEvent) => {
      if (isBack(event)) { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="browse-filter-dialog"] button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return <div className="sheet-backdrop" onClick={event => { if (event.currentTarget === event.target) onClose(); }}>
    <FocusContext.Provider value={focusKey}><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="browse-filter-heading" data-testid="browse-filter-dialog" className="sheet">
      <div className="sheet-heading"><h2 id="browse-filter-heading">{filter === 'genre' ? 'Жанр' : 'Год выхода'}</h2><TVButton id="browse-filter-close" className="sheet-close" onPress={onClose}>Закрыть</TVButton></div>
      <div className="sheet-body"><div className={`sheet-options browse-filter-options-${filter}`}>{options.map((option, index) => <TVButton key={option.value} id={`browse-${filter}-option-${index}`} selected={value === option.value} onPress={() => onChoose(option.value)}><Icon name="check" className="option-mark" /><span>{option.label}</span></TVButton>)}</div></div>
    </section></FocusContext.Provider>
  </div>;
}

export default function BrowseScreen({ onOpen, active, demo }: { onOpen: (title: TitleSummary) => void; active: boolean; demo: boolean }) {
  const [filters, setFilters] = useState<BrowseFilters>(defaults);
  const [results, setResults] = useState<Results>(empty);
  const [panel, setPanel] = useState<Filter | null>(null);
  const generation = useRef(0), loadedKey = useRef('');
  const pending = useRef<{ generation: number; page: number } | null>(null);
  const snapshot = useRef({ filters, results, active, demo, panel });
  snapshot.current = { filters, results, active, demo, panel };

  const fetchPage = async (page: number, replace = false, initiator?: string) => {
    const state = snapshot.current, epoch = generation.current;
    if (!state.active || state.demo || pending.current?.generation === epoch) return;
    const request = { generation: epoch, page }; pending.current = request;
    setResults(previous => ({ ...previous, loading: true, error: '', failedPage: undefined }));
    try {
      const next = await loadBrowse(state.filters, page);
      if (epoch !== generation.current) return;
      const previous = replace ? [] : state.results.items;
      const items = [...new Map([...previous, ...next.items].map(item => [item.url, item])).values()];
      const nextPage = items.length > previous.length && next.nextPage && next.nextPage > page ? next.nextPage : undefined;
      setResults({ ...next, items, nextPage, loading: false, loaded: true, error: '' });
      if (initiator && items.length) window.setTimeout(() => {
        if (epoch === generation.current && snapshot.current.active && !snapshot.current.panel && getCurrentFocusKey() === initiator) {
          void setFocus(`browse-title-${Math.min(previous.length, items.length - 1)}`);
        }
      }, 40);
    } catch (reason) {
      if (epoch === generation.current) setResults(previous => ({ ...previous, loaded: true, loading: false, failedPage: page, error: reason instanceof Error ? reason.message : 'Не удалось загрузить каталог.' }));
    } finally { if (pending.current === request) pending.current = null; }
  };
  useEffect(() => {
    if (!active || demo) return;
    const key = JSON.stringify(filters);
    if (loadedKey.current === key) return;
    loadedKey.current = key; generation.current++; pending.current = null;
    void fetchPage(1, true);
  }, [active, demo, filters]);
  useEffect(() => { if (!active) setPanel(null); }, [active]);
  useEffect(() => () => { generation.current++; pending.current = null; }, []);

  const closePanel = () => { if (panel && active) focusSoon(`browse-${panel}`); setPanel(null); };
  const changeFilters = (next: BrowseFilters) => {
    if (JSON.stringify(next) === JSON.stringify(filters)) { closePanel(); return; }
    generation.current++; pending.current = null; loadedKey.current = '';
    setFilters(next);
    setResults({ ...empty(), genres: next.type === filters.type ? results.genres : [], years: next.type === filters.type ? results.years : [] });
    closePanel();
  };
  const more = () => {
    const state = snapshot.current;
    if (state.active && !state.panel && !state.results.loading && !state.results.error && state.results.nextPage) void fetchPage(state.results.nextPage);
  };
  const choose = (name: Filter, value: string) => {
    const options = name === 'genre' ? results.genres : results.years;
    if (options.some(option => option.value === value)) changeFilters({ ...filters, [name]: value });
  };
  const genre = (filters.genre && results.genres.find(option => option.value === filters.genre)?.label) || 'любой';
  const year = (filters.year && results.years.find(option => option.value === filters.year)?.label) || 'любой';
  return <section className="browse-screen" data-testid="browse-screen">
    {demo && <div className="empty-state"><h2>Каталог недоступен в деморежиме</h2><p>Каталог источника с жанрами и годами откроется после выхода из деморежима.</p></div>}
    {!demo && <>
      {active && <TopbarTools><div className="chips" role="group" aria-label="Фильтры каталога">
        {types.map(type => <TVButton id={`browse-type-${type.value}`} key={type.value} selected={filters.type === type.value} onPress={() => changeFilters({ type: type.value, genre: '', year: '' })}>{type.label}</TVButton>)}
        <span className="chips-divider" aria-hidden="true" />
        <TVButton id="browse-genre" className="choice" disabled={!results.genres.length} onPress={() => setPanel('genre')}>Жанр: {genre}<Icon name="chevronDown" /></TVButton>
        <TVButton id="browse-year" className="choice" disabled={!results.years.length} onPress={() => setPanel('year')}>Год: {year}<Icon name="chevronDown" /></TVButton>
        {(filters.genre || filters.year) && <TVButton id="browse-reset" onPress={() => changeFilters({ ...filters, genre: '', year: '' })}>Сбросить</TVButton>}
      </div></TopbarTools>}
      <div className="poster-grid browse-grid" data-anchor-items="top">{results.items.map((title, index) => <TVButton key={title.url} id={`browse-title-${index}`} className="poster-button" label={`Открыть ${title.title}`} onPress={() => onOpen(title)} onFocused={index >= results.items.length - 7 ? more : undefined}><PosterImage title={title} /><span className="card-title">{title.title}</span><span className="card-subtitle">{title.meta || title.year}</span></TVButton>)}</div>
      {results.error && <div className="inline-error" role="alert"><p>{results.error}</p><TVButton id="browse-retry" onPress={() => void fetchPage(results.failedPage ?? 1, results.failedPage === 1, 'browse-retry')}>Повторить</TVButton></div>}
      {results.loading && <p className="section-note" role="status">{results.items.length ? 'Загружаем следующие фильмы…' : 'Загружаем каталог…'}</p>}
      {results.loaded && !results.loading && !results.error && !results.items.length && <div className="empty-state" role="status"><h2>Ничего не нашлось</h2><p>Для этих фильтров ничего не найдено. Попробуйте другой жанр или год.</p></div>}
      {results.nextPage && <LoadMoreTrigger enabled={active && !panel && !results.loading && !results.error} onLoad={more} />}
      {active && panel && <FilterDialog filter={panel} options={panel === 'genre' ? results.genres : results.years} value={filters[panel]} onChoose={value => choose(panel, value)} onClose={closePanel} />}
    </>}
  </section>;
}
