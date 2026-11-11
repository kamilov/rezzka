import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { doesFocusableExist, getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { Settings } from '../shared/settings';
import type { Episode, Playback, TitleDetails, TitlePerson, TitleSummary, Voice } from '../shared/source';
import { loadDetails, loadEpisodes } from './provider';
import { demoDetails, demoPlayback, isDemoTitle } from './demo-source';
import { latestProgress, readAccountMark, readLibrary, resumeSource, toggleFavorite, writeAccountMark, type AccountMark, type HistoryItem } from './library';
import { centerInRow, TVButton, TVFocusScope } from './navigation';
import FavoritesPanel from './FavoritesPanel';
import { useCardRatings } from './useCardRatings';
import TitleInformation from './TitleInformation';
import Sheet, { SheetReading } from './Sheet';
import CommentsPanel from './CommentsPanel';
import Icon from './Icon';

export interface Viewing { title: TitleDetails; voice: Voice; episode?: Episode; playback?: Playback; episodes?: Episode[] }
type Panel = 'favorites' | 'voice' | 'about' | 'comments';
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось загрузить данные.';
const same = (a?: Episode, b?: Episode) => !!a && !!b && a.id === b.id && a.season === b.season;
const minutes = (seconds: number) => {
  const total = Math.max(1, Math.ceil(seconds / 60)), hours = Math.floor(total / 60);
  return hours ? `${hours} ч ${total % 60} мин` : `${total} мин`;
};
const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10, tens = count % 100;
  return last === 1 && tens !== 11 ? one : last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many;
};
const shortSource: Record<string, string> = { 'Кинопоиск': 'КП', IMDb: 'IMDb', HDrezka: 'HDrezka', 'World Art': 'World Art' };

export default function TitleScreen({ summary, history: requestedHistory, settings, onPlay, onOpen, onOpenPerson, authenticated = false, onFavoritesChanged, onSignIn, focusOnLoad }: {
  summary: TitleSummary; settings: Settings; onPlay: (viewing: Viewing) => void; onOpen: (title: TitleSummary) => void;
  onOpenPerson: (person: TitlePerson, kinopoiskFilmId?: string) => void;
  history?: HistoryItem;
  authenticated?: boolean;
  onFavoritesChanged?: () => void;
  onSignIn?: () => void;
  focusOnLoad?: string;
}) {
  const [title, setTitle] = useState<TitleDetails>();
  const [voiceId, setVoiceId] = useState('');
  // The episodes of the chosen voice, the one «Смотреть» starts, and whether it continues saved progress.
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode>();
  const [resumed, setResumed] = useState(false);
  const [season, setSeason] = useState('');
  const [loadingVoice, setLoadingVoice] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [favorite, setFavorite] = useState(() => readLibrary().favorites.some((item) => item.url === summary.url));
  const [panel, setPanel] = useState<Panel | null>(null);
  // The discussion stays loaded after its first opening, so returning to it asks the source for nothing.
  const [discussed, setDiscussed] = useState(false);
  const screen = useRef<HTMLElement>(null);
  const panelOpen = useRef(false), alive = useRef(true), episodeTicket = useRef(0);
  const detailFocusTimer = useRef<number | undefined>(undefined);
  const returnFocusTimer = useRef<number | undefined>(undefined);
  const observedAccount = useRef<AccountMark | undefined>(undefined);
  const demo = isDemoTitle(summary);
  const voice = title?.voices.find((item) => item.id === voiceId);
  const series = !!title && (title.isSeries ?? title.kind === 'series');
  const locked = !!voice?.premium && !authenticated;
  useLayoutEffect(() => {
    const scroller = screen.current?.closest('main');
    if (scroller) scroller.scrollTop = 0;
  }, [summary.url]);
  useEffect(() => {
    let cancelled = false;
    const initialFocus = getCurrentFocusKey();
    const focusDetails = (key: string) => {
      window.clearTimeout(detailFocusTimer.current);
      detailFocusTimer.current = window.setTimeout(() => {
        const focused = getCurrentFocusKey();
        if (!cancelled && !panelOpen.current && (focused === focusOnLoad || focused === initialFocus || (!focusOnLoad && focused === 'details-favorite') || !doesFocusableExist(focused))) void setFocus(focusOnLoad && doesFocusableExist(focusOnLoad) ? focusOnLoad : key);
      }, 40);
    };
    const ticket = ++episodeTicket.current;
    setLoading(true); setError(''); setNotice(''); setLoadingVoice('');
    void (isDemoTitle(summary) ? Promise.resolve(demoDetails(summary)) : loadDetails(summary)).then((next) => {
      if (cancelled) return;
      const available = next.voices.filter((item) => !item.premium || authenticated);
      const byId = (id?: string) => available.find((item) => item.id === id);
      const preferred = available.find((item) => item.id === settings.preferredVoice || item.label.toLocaleLowerCase('ru') === settings.preferredVoice.toLocaleLowerCase('ru'));
      const requested = requestedHistory?.title.url === next.url ? requestedHistory : undefined;
      const local = requested ?? latestProgress(next.url);
      // What the account holds for this title is visible on its page only for a signed-in viewer.
      const account: AccountMark | undefined = authenticated && !isDemoTitle(next) && next.selectedVoiceId
        ? { voice: next.selectedVoiceId, season: next.selectedEpisode?.season, episode: next.selectedEpisode?.id } : undefined;
      observedAccount.current = account;
      const from = requested ? 'local' : resumeSource(account, readAccountMark(next.url), local);
      const resumeVoice = from === 'local' ? byId(local?.voice.id) : from === 'account' ? byId(account?.voice) : undefined;
      const selected = resumeVoice ?? preferred ?? byId(next.selectedVoiceId) ?? available[0] ?? next.voices[0];
      const wanted = !resumeVoice ? undefined : from === 'local' ? local?.episode : next.selectedEpisode;
      const isSeries = next.isSeries ?? next.kind === 'series';
      const settle = (list: Episode[]) => {
        const found = list.find((item) => same(item, wanted)), start = found ?? list[0];
        setEpisodes(list); setEpisode(start); setSeason(start?.season ?? next.schedule?.find((item) => item.season)?.season ?? '');
        // «Вы остановились» only when there is saved progress beyond the very first episode.
        setResumed(!!found && (from === 'local' || !same(found, list[0])));
        if (wanted && !found && list.length) setNotice(`В этой озвучке нет сезона ${wanted.season}, серии ${wanted.id}.`);
      };
      setTitle(next); setVoiceId(selected?.id ?? '');
      if (!isSeries) { setEpisodes([]); setEpisode(undefined); setSeason(''); setResumed(from === 'local' && !!resumeVoice); }
      else if (!selected || selected.id === next.selectedVoiceId) settle(next.episodes);
      else {
        // The card arrived with the episodes of another voice: read the list of the one that resumes.
        setEpisodes([]); setEpisode(undefined); setLoadingVoice(selected.label);
        void loadEpisodes(next, selected).then((list) => { if (!cancelled && ticket === episodeTicket.current) settle(list); })
          .catch(() => { if (!cancelled && ticket === episodeTicket.current) { settle([]); setNotice(`Не удалось загрузить серии для озвучки «${selected.label}».`); } })
          .finally(() => { if (!cancelled && ticket === episodeTicket.current) setLoadingVoice(''); });
      }
      focusDetails(selected && (!selected.premium || authenticated) ? 'details-play' : 'details-favorite');
    }).catch((failure) => { if (!cancelled) { setError(message(failure)); focusDetails('details-retry'); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; episodeTicket.current++; window.clearTimeout(detailFocusTimer.current); };
  }, [summary, settings.preferredVoice, requestedHistory, attempt, authenticated, focusOnLoad]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(returnFocusTimer.current); }; }, []);
  const seasonTabs = useRef<HTMLDivElement>(null);
  // The chosen season stays in sight when it was chosen for the viewer (on opening, after a voice change) rather than by focus.
  useEffect(() => { if (season && getCurrentFocusKey() !== `details-season-${season}`) centerInRow(seasonTabs.current?.querySelector<HTMLElement>('[aria-pressed="true"]')); }, [season, voiceId, loadingVoice, title?.url]);

  const shown = title ?? summary;
  const progress = useMemo(() => readLibrary().history.filter((item) => item.title.url === (title?.url ?? '') && item.voice.id === voiceId), [title?.url, voiceId]);
  const progressOf = (target?: Episode) => progress.find((item) => target ? same(item.episode, target) : !item.episode);
  const startProgress = progressOf(series ? episode : undefined);
  const startRatio = resumed && startProgress && startProgress.duration > 0 ? Math.min(1, startProgress.position / startProgress.duration) : 0;
  const play = (target: Episode | undefined = episode) => {
    if (loading || !title || !voice || locked || loadingVoice) return;
    // Remember what the account held before this device plays, so a later change made elsewhere can be told apart.
    if (observedAccount.current && !readAccountMark(title.url)) writeAccountMark(title.url, observedAccount.current);
    onPlay({ title, voice, episode: series ? target : undefined, playback: isDemoTitle(title) ? demoPlayback() : undefined, episodes: series && episodes.length ? episodes : undefined });
  };
  const openPanel = (next: Panel) => {
    if (next === 'favorites') {
      if (isDemoTitle(shown)) { setFavorite(toggleFavorite(shown)); return; }
      if (!authenticated) { onSignIn?.(); return; }
    }
    window.clearTimeout(detailFocusTimer.current); window.clearTimeout(returnFocusTimer.current);
    panelOpen.current = true; setPanel(next);
    if (next === 'comments') setDiscussed(true);
  };
  const closePanel = () => {
    const previousFocus = getCurrentFocusKey(), opener = panel === 'favorites' ? 'details-favorite' : `details-${panel}`;
    panelOpen.current = false; setPanel(null);
    returnFocusTimer.current = window.setTimeout(() => {
      const currentFocus = getCurrentFocusKey();
      if (alive.current && !panelOpen.current && (currentFocus === previousFocus || !doesFocusableExist(currentFocus))) void setFocus(doesFocusableExist(opener) ? opener : 'details-favorite');
    }, 40);
  };
  const chooseVoice = (next: Voice) => {
    if (next.premium && !authenticated) { setNotice('Для этой озвучки нужен аккаунт Premium.'); closePanel(); return; }
    closePanel();
    if (!title || next.id === voiceId) return;
    if (!series) { setVoiceId(next.id); setNotice(''); return; }
    // Each voice has its own list of episodes. The current choice stays until the new list arrives.
    const ticket = ++episodeTicket.current, wanted = episode;
    setLoadingVoice(next.label); setNotice('');
    void loadEpisodes(title, next).then((list) => {
      if (ticket !== episodeTicket.current || !alive.current) return;
      if (!list.length) { setNotice(`Для озвучки «${next.label}» пока нет серий. Осталась прежняя.`); return; }
      const found = list.find((item) => same(item, wanted)), start = found ?? list[0];
      setVoiceId(next.id); setEpisodes(list); setEpisode(start); setSeason(start.season);
      if (wanted && !found) { setResumed(false); setNotice(`В этой озвучке нет сезона ${wanted.season}, серии ${wanted.id}.`); }
    }).catch(() => {
      if (ticket === episodeTicket.current && alive.current) setNotice(`Не удалось загрузить серии для озвучки «${next.label}». Осталась прежняя.`);
    }).finally(() => { if (ticket === episodeTicket.current && alive.current) setLoadingVoice(''); });
  };

  const seasons = useMemo(() => {
    const all = new Set<string>(episodes.map((item) => item.season));
    for (const item of title?.schedule ?? []) if (item.season) all.add(item.season);
    return [...all].sort((a, b) => Number(a) - Number(b));
  }, [episodes, title]);
  const schedule = title?.schedule?.find((item) => item.season === season);
  const playable = episodes.filter((item) => item.season === season);
  // Schedule rows without a playable episode: not released yet, or absent in this voice.
  const pending = (schedule?.episodes ?? []).filter((row) => row.number && !playable.some((item) => item.id === row.number));
  const episodeKey = (item: Episode) => `details-episode-${item.season}-${item.id}`;
  const firstInSeason = () => { const target = playable.find((item) => same(item, episode)) ?? playable[0]; return target ? episodeKey(target) : undefined; };
  const fromHeader = (direction: string) => {
    if (direction !== 'down' || !series || !season || !doesFocusableExist(`details-season-${season}`)) return true;
    void setFocus(`details-season-${season}`); return false;
  };
  const facts = new Map((title?.facts ?? []).map((fact) => [fact.label.toLocaleLowerCase('ru'), fact.value]));
  const ratings = (shown.ratings?.length ? shown.ratings : shown.rating ? [{ source: 'Кинопоиск' as const, value: shown.rating }] : []).filter((item) => item.source === 'Кинопоиск' || item.source === 'IMDb');
  const kind = isDemoTitle(shown) ? 'Локальная демонстрация' : !title ? '' : series
    ? `Сериал${seasons.length ? ` · ${seasons.length} ${plural(seasons.length, 'сезон', 'сезона', 'сезонов')}` : ''}` : 'Фильм';
  const about = series ? 'О сериале' : 'О фильме';
  const status = () => {
    if (loadingVoice) return <span>Загружаем серии для озвучки «{loadingVoice}»…</span>;
    if (!title) return loading ? <span>Загружаем описание…</span> : null;
    if (!title.voices.length) return <span>Источник не предоставил доступных озвучек.</span>;
    if (locked) return <span className="warning">Для этой озвучки нужен аккаунт Premium. Войдите в аккаунт через настройки.</span>;
    const left = startRatio && startProgress ? ` · осталось ${minutes(startProgress.duration - startProgress.position)}` : '';
    const warning = notice ? <><span className="warning">{notice}</span>{' '}</> : null;
    if (series && episode) return <>{warning}{resumed ? 'Вы остановились: ' : notice ? 'Начнём с: ' : 'Начнём с начала: '}<em>сезон {episode.season}, серия {episode.id}</em><span> · {voice?.label}{left}</span></>;
    if (series) return <>{warning}<span>Озвучка: {voice?.label}</span></>;
    return resumed && startRatio ? <>{warning}<em>Просмотрено {Math.round(startRatio * 100)} %</em><span>{left} · {voice?.label}</span></> : <>{warning}<span>Озвучка: </span>{voice?.label}</>;
  };
  return <><TVFocusScope active={!panel}><section ref={screen} className="title-screen">
    <div className="title-head" data-anchor="start">
      <div className="title-cover"><PosterImage title={shown} showRating={false} /></div>
      <div className="title-copy">
        <p className="title-kind">{kind}{' '}</p>
        <h1>{shown.title}</h1>
        {title?.originalTitle && <p className="title-original">{title.originalTitle}</p>}
        <div className="title-facts" aria-label="Сведения">
          {ratings.map((item) => <span className="score" key={item.source} aria-label={`${item.source}: ${item.value}`}><span>{shortSource[item.source]}</span>{item.value}</span>)}
          {shown.year && <span>{shown.year}</span>}{facts.get('страна') && <span>{facts.get('страна')}</span>}
          {(facts.get('жанр') ?? shown.meta) && <span>{facts.get('жанр') ?? shown.meta}</span>}
          {title?.duration && <span>{title.duration}</span>}{facts.get('возраст') && <span className="demo-badge">{facts.get('возраст')}</span>}
        </div>
        {title?.description && <p className="title-description">{title.description}</p>}
        <p className="title-status" role="status" data-testid="details-status">{status()}</p>
        <div className="title-actions">
          {title && <TVButton id="details-play" className="primary" disabled={loading || !voice || locked || !!loadingVoice} onArrow={fromHeader} onPress={() => play()}>
            <Icon name="play" />{isDemoTitle(title) ? 'Тестовый ролик' : resumed ? 'Продолжить' : 'Смотреть'}
            {startRatio > 0 && <span className="button-progress" aria-hidden="true"><i style={{ width: `${startRatio * 100}%` }} /></span>}
          </TVButton>}
          {title && title.voices.length > 1 && <TVButton id="details-voice" disabled={!!loadingVoice} onArrow={fromHeader} onPress={() => openPanel('voice')}><Icon name="voice" />Озвучка</TVButton>}
          <TVButton id="details-favorite" selected={isDemoTitle(shown) ? favorite : undefined} onArrow={fromHeader} onPress={() => openPanel('favorites')}>
            <Icon name="heart" />{isDemoTitle(shown) ? favorite ? 'В избранном' : 'В избранное' : 'Избранное'}</TVButton>
          {title && <TVButton id="details-about" onArrow={fromHeader} onPress={() => openPanel('about')}><Icon name="info" />{about}</TVButton>}
          {title && !isDemoTitle(title) && <TVButton id="details-comments" onArrow={fromHeader} onPress={() => openPanel('comments')}>
            <Icon name="comments" />Комментарии{title.commentCount !== undefined ? ` · ${title.commentCount}` : ''}</TVButton>}
        </div>
        {error && <div className="inline-error" role="alert"><p>{error}</p>{!title && <TVButton id="details-retry" onPress={() => setAttempt((value) => value + 1)}>Повторить</TVButton>}</div>}
      </div>
    </div>
    {title && series && seasons.length > 0 && <section className="title-section" data-anchor aria-label="Серии" data-testid="details-episodes">
      <h2>Серии</h2>
      <div ref={seasonTabs} className="chips season-tabs" data-row="tabs" role="tablist" aria-label="Сезоны">{seasons.map((value) =>
        // A season opens as soon as its tab takes focus: the list is already loaded.
        <TVButton key={value} id={`details-season-${value}`} selected={value === season} disabled={!!loadingVoice} onPress={() => setSeason(value)} onFocused={() => setSeason(value)}
          onArrow={(direction) => { const target = direction === 'down' && value === season ? firstInSeason() : undefined; if (!target) return true; void setFocus(target); return false; }}>Сезон {value}</TVButton>)}</div>
      {/* A new season or voice starts its row from the beginning. */}
      <div className="poster-row" data-row key={`${voiceId}-${season}`}>
        {loadingVoice ? Array.from({ length: 6 }, (_, index) => <div key={index} className="episode-tile is-loading" />) : <>
          {playable.map((item) => {
            const row = schedule?.episodes.find((entry) => entry.number === item.id), saved = progressOf(item);
            const finished = !!saved && saved.duration > 0 && saved.position >= saved.duration - 2, start = same(item, episode);
            const name = row?.title ?? (/^серия\s*\d+$/i.test(item.title.trim()) ? '' : item.title);
            return <TVButton key={episodeKey(item)} id={episodeKey(item)} className={`episode-tile ${start ? 'is-current' : ''}`}
              label={`Сезон ${item.season}, серия ${item.id}${name ? `, ${name}` : ''}${row?.watched || finished ? ', просмотрена' : ''}`} onPress={() => play(item)}
              onArrow={(direction) => { if (direction !== 'up') return true; void setFocus(`details-season-${season}`); return false; }}>
              <strong>Серия {item.id}{(row?.watched || finished) && <Icon name="check" />}</strong>
              <span className="episode-name">{name}{' '}</span>
              <span className="episode-date">{start ? resumed ? 'Вы остановились здесь' : 'Начнём отсюда' : row?.date ?? ' '}</span>
              {start && startRatio > 0 && <span className="card-progress" aria-hidden="true"><i style={{ width: `${startRatio * 100}%` }} /></span>}
            </TVButton>;
          })}
          {pending.map((row) => <div key={`pending-${row.number}`} className="episode-tile is-upcoming" data-testid={`details-pending-${season}-${row.number}`}>
            <strong>Серия {row.number}</strong><span className="episode-name">{row.title ?? ' '}</span>
            <span className="episode-date">{row.watched || row.relative === '✓' ? 'Нет в этой озвучке' : [row.date, row.relative].filter(Boolean).join(' · ') || 'Ещё не вышла'}</span></div>)}
        </>}
      </div>
    </section>}
    {title && <TitleInformation key={title.url} title={title} onOpen={onOpen} onOpenPerson={onOpenPerson} Poster={PosterImage} />}
    <div className="page-end" />
  </section></TVFocusScope>
  {panel === 'favorites' && <FavoritesPanel title={shown} onClose={closePanel} onChanged={() => onFavoritesChanged?.()} />}
  {panel === 'voice' && title && <Sheet id="details-voices" title="Озвучка" note={title.title} onClose={closePanel} initialFocus={`details-voice-${Math.max(0, title.voices.findIndex((item) => item.id === voiceId))}`}>
    <div className="sheet-options" role="radiogroup" aria-label="Озвучка">{title.voices.map((item, index) =>
      <TVButton key={item.id} id={`details-voice-${index}`} selected={item.id === voiceId} label={`${item.label}${item.premium && !authenticated ? ', нужен аккаунт Premium' : ''}`} onPress={() => chooseVoice(item)}>
        <Icon name="check" className="option-mark" /><span>{item.label}</span>{item.premium && !authenticated && <span className="option-note">Нужен Premium</span>}
      </TVButton>)}</div>
  </Sheet>}
  {panel === 'about' && title && <Sheet id="details-info" title={about} note={title.title} wide onClose={closePanel} initialFocus="details-about-content">
    <SheetReading id="details-about-content" label="Описание и сведения">
      {title.description ? <p>{title.description}</p> : <p>Описание пока не добавлено.</p>}
      {!!title.facts?.length && <><h3>Сведения</h3><dl className="title-facts-list">{title.facts.map((fact, index) => [<dt key={`label-${index}`}>{fact.label}</dt>, <dd key={`value-${index}`}>{fact.value}</dd>])}</dl></>}
      {!!title.ratings?.length && <><h3>Оценки</h3><dl className="title-facts-list" aria-label="Оценки зрителей">{title.ratings.map((rating) =>
        [<dt key={`source-${rating.source}`}>{rating.source}</dt>, <dd key={`value-${rating.source}`}>{rating.value} из 10{rating.votes ? ` · голосов: ${rating.votes}` : ''}</dd>])}</dl></>}
    </SheetReading>
  </Sheet>}
  {discussed && title && <Sheet id="details-discussion" title="Комментарии" note={`${title.title} · только чтение`} wide hidden={panel !== 'comments'} onClose={closePanel}>
    <TVFocusScope active={panel === 'comments'}><CommentsPanel title={title} active={panel === 'comments'} /></TVFocusScope>
  </Sheet>}
  </>;
}

export function PosterImage({ title, showRating = true }: { title: TitleSummary; showRating?: boolean }) {
  const poster = useRef<HTMLDivElement>(null);
  const ratings = useCardRatings(title, poster, showRating && !isDemoTitle(title));
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [title.poster]);
  const rating = ratings?.[0];
  const value = rating?.value ?? title.rating;
  return <div ref={poster} className="poster-image">{title.poster && !failed ? <img src={title.poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="poster-fallback" aria-hidden="true">{title.title}</span>}
    {showRating && value && <span className="poster-rating" aria-label={`${rating?.source ?? 'Рейтинг'}: ${value}`}>
      <span>{rating?.source === 'Кинопоиск' ? 'КП' : rating?.source ?? '★'}</span><strong>{value}</strong>
    </span>}
  </div>;
}
