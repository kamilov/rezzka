import { useEffect, useRef, useState } from 'react';
import { doesFocusableExist, getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { PersonDetails } from '../shared/source';
import type { KinopoiskResult } from '../shared/kinopoisk';
import { getKinopoiskPerson } from './platform';
import { getProviderGeneration } from './provider';
import { TVButton } from './navigation';
import { ReadingRegion } from './TitleInformation';

function plainText(value: string): string {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, img, video, audio, source').forEach(node => node.remove());
  doc.querySelectorAll('br').forEach(node => node.replaceWith(' '));
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export default function KinopoiskPersonDetails({ person, filmId, profession, visitId, active }: {
  person: PersonDetails; filmId?: string; profession?: string; visitId: string; active: boolean;
}) {
  const [result, setResult] = useState<KinopoiskResult>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [open, setOpen] = useState(false);
  const generation = getProviderGeneration();
  const identity = JSON.stringify([generation, person.url, filmId, person.name, person.originalName, person.birthDate, profession]);
  const state = useRef({ active, identity, generation, open }); state.current = { active, identity, generation, open };
  const owner = useRef(''), attempted = useRef(''), pending = useRef<object | null>(null), alive = useRef(true), focusTimer = useRef<number | undefined>(undefined);
  const toggleId = `${visitId}-kinopoisk-toggle`, contentId = `${visitId}-kinopoisk-content`, retryId = `${visitId}-kinopoisk-retry`;
  const load = async (initiator?: string) => {
    if (!state.current.active || pending.current) return;
    const request = {}; pending.current = request; attempted.current = identity; setLoading(true); setError('');
    const current = () => alive.current && state.current.identity === identity && getProviderGeneration() === generation && pending.current === request;
    try {
      const next = await getKinopoiskPerson({ name: person.name, ...(person.originalName ? { originalName: person.originalName } : {}),
        ...(filmId ? { filmId } : {}), ...(profession ? { profession } : {}), ...(person.birthDate ? { birthDate: person.birthDate } : {}) });
      if (!current()) return;
      setResult(next);
      if (initiator) focusTimer.current = window.setTimeout(() => {
        if (alive.current && state.current.active && state.current.identity === identity && getProviderGeneration() === generation && getCurrentFocusKey() === initiator) {
          void setFocus(next.status === 'matched' ? toggleId : `${visitId}-back`);
        }
      }, 40);
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить сведения Кинопоиска.'); }
    finally { if (current()) setLoading(false); if (pending.current === request) pending.current = null; }
  };
  useEffect(() => {
    if (owner.current !== identity) {
      owner.current = identity; attempted.current = ''; pending.current = null;
      window.clearTimeout(focusTimer.current); setResult(undefined); setOpen(false); setError(''); setLoading(false);
    }
    if (active && attempted.current !== identity) void load();
  }, [active, identity]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = null; window.clearTimeout(focusTimer.current); }; }, []);
  if (owner.current !== identity || result?.status === 'disabled') return null;
  const matched = result?.status === 'matched' ? result.person : undefined;
  return <section className="kinopoisk-person" data-testid={`${visitId}-kinopoisk`} aria-label="Сведения Кинопоиска">
    {loading && <p className="section-note" role="status">Загружаем сведения Кинопоиска…</p>}
    {error && <div className="inline-error" role="alert"><p>{error}</p><TVButton id={retryId} disabled={loading} onPress={() => void load(retryId)}>Повторить</TVButton></div>}
    {matched && <>
      <TVButton id={toggleId} selected={open} onPress={() => {
        window.clearTimeout(focusTimer.current);
        setOpen(previous => !previous);
        if (!open) focusTimer.current = window.setTimeout(() => {
          if (alive.current && state.current.active && state.current.open && state.current.identity === identity && getCurrentFocusKey() === toggleId && doesFocusableExist(contentId)) void setFocus(contentId);
        }, 40);
      }}>{open ? 'Скрыть сведения Кинопоиска' : 'Сведения Кинопоиска'}</TVButton>
      {open && <ReadingRegion id={contentId} label="Дополнительные сведения о персоне" returnFocus={toggleId}>
        <p className="section-note">Кинопоиск · Kinopoisk API Unofficial</p>
        {matched.facts.length > 0 && <dl className="person-facts">{matched.facts.map((fact, index) => <div key={`${fact.label}-${index}`}><dt>{plainText(fact.label)}</dt><dd>{plainText(fact.value)}</dd></div>)}</dl>}
        {matched.trivia.length > 0 && <ul className="person-trivia">{matched.trivia.map((fact, index) => <li key={index}>{plainText(fact)}</li>)}</ul>}
        {!matched.facts.length && !matched.trivia.length && <p className="section-note">Дополнительные сведения пока не опубликованы.</p>}
      </ReadingRegion>}
    </>}
    {result && ['unmatched', 'ambiguous'].includes(result.status) && <p className="section-note">Не удалось однозначно сопоставить персону с Кинопоиском. Показаны сведения основного источника.</p>}
  </section>;
}
