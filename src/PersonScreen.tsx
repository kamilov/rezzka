import { useEffect, useRef, useState } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { PersonDetails, TitlePerson, TitleSummary } from '../shared/source';
import { getProviderGeneration } from './provider';
import { loadPerson } from './provider-person';
import { TVButton, TVFocusScope } from './navigation';
import { PosterImage } from './TitleScreen';
import KinopoiskPersonDetails from './KinopoiskPersonDetails';
import './person.css';

interface Result { details?: PersonDetails; loading: boolean; error: string }
const empty = (): Result => ({ loading: false, error: '' });

export default function PersonScreen({ person, visitId, kinopoiskFilmId, active, onOpen, onBack }: {
  person: TitlePerson; visitId: string; kinopoiskFilmId?: string; active: boolean; onOpen: (title: TitleSummary) => void; onBack: () => void;
}) {
  const [result, setResult] = useState<Result>(empty);
  const [photoFailed, setPhotoFailed] = useState(false);
  const generation = getProviderGeneration(), identity = JSON.stringify([generation, person.url]);
  const snapshot = useRef({ active, identity, generation, person, visitId }); snapshot.current = { active, identity, generation, person, visitId };
  const owner = useRef(''), attempted = useRef(''), pending = useRef<object | null>(null), alive = useRef(true);
  const focusTimer = useRef<number | undefined>(undefined);

  const fetchPerson = async (initiator?: string) => {
    const state = snapshot.current;
    if (!state.active || pending.current) return;
    attempted.current = state.identity;
    if (!state.person.url) { setResult({ loading: false, error: 'Источник не указал адрес страницы персоны.' }); return; }
    const request = {}; pending.current = request;
    window.clearTimeout(focusTimer.current);
    setResult(previous => ({ ...previous, loading: true, error: '' }));
    const current = () => alive.current && snapshot.current.identity === state.identity && getProviderGeneration() === state.generation && pending.current === request;
    try {
      const details = await loadPerson(state.person.url);
      if (!current()) return;
      setResult({ details, loading: false, error: '' });
      if (initiator) focusTimer.current = window.setTimeout(() => {
        if (alive.current && snapshot.current.active && snapshot.current.identity === state.identity && getProviderGeneration() === state.generation && getCurrentFocusKey() === initiator) {
          const hasFilms = details.filmography.some(group => group.items.length);
          void setFocus(hasFilms ? `${state.visitId}-title-0-0` : `${state.visitId}-back`);
        }
      }, 40);
    } catch (reason) {
      if (current()) setResult(previous => ({ ...previous, loading: false, error: reason instanceof Error ? reason.message : 'Не удалось загрузить страницу персоны.' }));
    } finally { if (pending.current === request) pending.current = null; }
  };

  useEffect(() => {
    if (owner.current !== identity) {
      owner.current = identity; attempted.current = ''; pending.current = null;
      window.clearTimeout(focusTimer.current); setResult(empty());
    }
    if (active && attempted.current !== identity) void fetchPerson();
  }, [active, identity]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pending.current = null; window.clearTimeout(focusTimer.current); };
  }, []);

  const shownResult = owner.current === identity ? result : empty(), details = shownResult.details;
  const name = details?.name || person.name, photo = details?.photo || person.photo;
  const groups = details?.filmography.filter(group => group.items.length) ?? [];
  useEffect(() => { setPhotoFailed(false); }, [photo]);

  return <TVFocusScope active={active}><section className="person-screen" data-testid={`${visitId}-screen`}>
    <header className="person-header">
      <div className="person-portrait">{photo && !photoFailed ? <img src={photo} alt="" referrerPolicy="no-referrer" onError={() => setPhotoFailed(true)} /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}</div>
      <div className="person-heading">
        <p className="eyebrow">Актёры и авторы</p>
        <h1>{name}</h1>
        {details?.originalName && <p className="original-title">{details.originalName}</p>}
        {!!details?.facts.length && <dl className="person-facts">{details.facts.map((fact, index) => <div key={`${fact.label}-${index}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
        <div className="actions"><TVButton id={`${visitId}-back`} onPress={onBack}>Назад</TVButton></div>
      </div>
    </header>
    {shownResult.loading && <p className="section-note" role="status">Загружаем сведения и фильмографию…</p>}
    {shownResult.error && <div className="inline-error" role="alert"><p>{shownResult.error}</p>{person.url && <TVButton id={`${visitId}-retry`} onPress={() => void fetchPerson(`${visitId}-retry`)}>Повторить</TVButton>}</div>}
    {details && <KinopoiskPersonDetails person={details} filmId={kinopoiskFilmId} profession={person.job} visitId={visitId} active={active} />}
    {groups.map((group, groupIndex) => <section className="person-filmography" key={`${group.role}-${groupIndex}`} aria-labelledby={`${visitId}-group-${groupIndex}`}>
      <h2 id={`${visitId}-group-${groupIndex}`}>{group.role}</h2>
      <div className="poster-grid">{group.items.map((title, index) => <TVButton key={title.url} id={`${visitId}-title-${groupIndex}-${index}`} className="poster-button" label={`Открыть ${title.title}`} onPress={() => onOpen(title)}>
        <PosterImage title={title} /><span className="card-title">{title.title}</span><span className="card-subtitle">{title.meta || title.year}</span>
      </TVButton>)}</div>
    </section>)}
    {details && !shownResult.loading && !shownResult.error && !groups.length && <p className="empty-state" role="status">Источник пока не добавил фильмы с участием этой персоны.</p>}
  </section></TVFocusScope>;
}
