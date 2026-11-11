import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doesFocusableExist, getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { defaultSettings, type SettingsEnvelope } from '../shared/settings';
import type { SourceSession } from '../shared/auth';
import type { CatalogPage, CatalogSort, CatalogType, TitlePerson, TitleSummary } from '../shared/source';
import { TVButton, TVField, TVFocusScope, focusSoon, isBack } from './navigation';
import { getSettings, getSourceSession, sourceLogout, leaveApp, isTelevision } from './platform';
import { loadCatalog, loadEpisodes, loadPlayback, searchTitles, resetProviderSession, subscribeToSourceAuth } from './provider';
import { loadContinue, orderContinue, type ContinueItem } from './provider-continue';
import { demoCatalog, demoPlayback, isDemoTitle } from './demo-source';
import { readLibrary, readRecentSearches, rememberSearch, type HistoryItem } from './library';
import SettingsScreen from './Settings';
import Player from './Player';
import TitleScreen, { PosterImage, type Viewing } from './TitleScreen';
import AuthScreen from './AuthScreen';
import BrowseScreen from './BrowseScreen';
import MineScreen from './MineScreen';
import PersonScreen from './PersonScreen';
import MainContent, { TopbarTools } from './MainContent';
import Spotlight from './Spotlight';
import { LoadMoreTrigger } from './LoadMoreTrigger';

type Page = 'catalog' | 'browse' | 'search' | 'library' | 'details' | 'person' | 'settings' | 'player';
type DetailReturn = { page: 'details'; title: TitleSummary; history?: HistoryItem; focusKey: string }
  | { page: 'person'; visitId: string; focusKey: string };
type Row = CatalogPage & { loading: boolean; error: string; notice?: string };
type SourceAccess = { mirror: string; status: 'checking' | 'ready' | 'login' | 'error'; error?: string };
const rows = [{ sort: 'last', label: 'Последние поступления' }, { sort: 'popular', label: 'Популярное' }] as const;
const filters: { id: CatalogType; label: string }[] = [{ id: '0', label: 'Всё' }, { id: '1', label: 'Фильмы' }, { id: '2', label: 'Сериалы' }, { id: '3', label: 'Мультфильмы' }, { id: '82', label: 'Аниме' }];
const sections = [{ id: 'catalog', label: 'Главная' }, { id: 'browse', label: 'Каталог' }, { id: 'search', label: 'Поиск' }, { id: 'library', label: 'Моё' }, { id: 'settings', label: 'Настройки' }] as const;
const emptyRow = (): Row => ({ items: [], loading: false, error: '' });
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось получить ответ источника.';
const mergeTitles = (items: TitleSummary[]) => [...new Map(items.map((item) => [item.url, item])).values()];
const focusLoaded = (key: string, initiator: string, stillCurrent: () => boolean) => window.setTimeout(() => {
  if (stillCurrent() && getCurrentFocusKey() === initiator) void setFocus(key);
}, 40);

function NavIcon({ name }: { name: string }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'catalog' ? <path d="m3 10.5 9-7 9 7V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
      : name === 'browse' ? <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>
        : name === 'search' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>
          : name === 'library' ? <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1Z" />
            : <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" /></>}
  </svg>;
}

export default function App() {
  const [page, setPage] = useState<Page>('catalog');
  const [demo, setDemo] = useState(false);
  const [settings, setSettings] = useState<SettingsEnvelope>({ revision: 0, values: defaultSettings });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [serviceError, setServiceError] = useState('');
  const [clock, setClock] = useState(new Date());
  const [type, setType] = useState<CatalogType>('0');
  const [catalog, setCatalog] = useState<Record<string, Row>>({ last: emptyRow(), popular: emptyRow() });
  // The title under focus on the home screen and, for a continued one, where the viewer stopped.
  const [hero, setHero] = useState<TitleSummary>();
  const [heroNote, setHeroNote] = useState('');
  const [selected, setSelected] = useState<TitleSummary>();
  const [selectedHistory, setSelectedHistory] = useState<HistoryItem>();
  const [detailFocusOnLoad, setDetailFocusOnLoad] = useState<string>();
  const [detailTrail, setDetailTrail] = useState<DetailReturn[]>([]);
  const [personVisits, setPersonVisits] = useState<{ id: string; person: TitlePerson; kinopoiskFilmId?: string }[]>([]);
  const [activePerson, setActivePerson] = useState('');
  const personSequence = useRef(0), activePersonRef = useRef(activePerson); activePersonRef.current = activePerson;
  const [viewing, setViewing] = useState<Viewing>();
  const [origin, setOrigin] = useState<Page>('catalog');
  const [returnFocus, setReturnFocus] = useState('nav-catalog');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(readRecentSearches);
  const [results, setResults] = useState<Row>(emptyRow);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [library, setLibrary] = useState(readLibrary);
  const [access, setAccess] = useState<SourceAccess>({ mirror: '', status: 'checking' });
  const [session, setSession] = useState<SourceSession>();
  const [authAttempt, setAuthAttempt] = useState(0);
  const [gateSettings, setGateSettings] = useState(false);
  const [manualLogin, setManualLogin] = useState(false);
  const loginReturnFocus = useRef('settings-signin');
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  // The account's «Досмотреть» for the home row; `settled` tells that the first answer has come.
  const [saved, setSaved] = useState<{ items: ContinueItem[]; settled: boolean }>({ items: [], settled: false });
  const [sessionKnown, setSessionKnown] = useState(false);
  const [continueRevision, setContinueRevision] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => { try { return localStorage.getItem('rezzka.theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const sourceEpoch = useRef(0);
  const searchEpoch = useRef(0);
  const catalogRef = useRef(catalog); catalogRef.current = catalog;
  const resultsRef = useRef(results); resultsRef.current = results;
  const pageRef = useRef(page); pageRef.current = page;
  const rowRequests = useRef(new Map<CatalogSort, { epoch: number }>());
  const searchRequest = useRef<{ epoch: number } | undefined>(undefined);
  // The session starts with focus in the content, not in the menu; `homeFocus` asks for it once the rows are known.
  const homeFocus = useRef(true);
  const mirror = settings.values.mirrorUrl;
  const ready = demo || !!mirror;
  const gated = loadingSettings || manualLogin || (!demo && !!mirror && (access.mirror !== mirror || access.status !== 'ready'));
  const signedIn = !demo && !!session?.authenticated;
  const belongs = useCallback((title: TitleSummary) => {
    if (demo) return isDemoTitle(title);
    try { return new URL(title.url).origin === new URL(mirror).origin; } catch { return false; }
  }, [demo, mirror]);
  const updateTheme = (value: 'dark' | 'light') => { setTheme(value); try { localStorage.setItem('rezzka.theme', value); } catch { /* Theme remains usable without storage. */ } };
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const loadSettings = useCallback(async () => {
    setLoadingSettings(true); setServiceError('');
    try { setSettings(await getSettings()); } catch (error) { setServiceError(message(error)); }
    finally { setLoadingSettings(false); }
  }, []);
  useEffect(() => {
    void loadSettings();
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [loadSettings]);
  useEffect(() => { if (!loadingSettings && !gated && !ready) focusSoon('configure-source'); }, [loadingSettings]);

  useEffect(() => subscribeToSourceAuth(() => {
    // Invalidate every request from the expired session before mounting login.
    resetProviderSession(); sourceEpoch.current++; searchEpoch.current++;
    setAccess({ mirror, status: 'login' }); setSession(undefined);
    setGateSettings(false); setManualLogin(false); setPage('catalog'); setViewing(undefined);
    setHero(undefined); setHeroNote(''); setCatalog({ last: emptyRow(), popular: emptyRow() }); setResults(emptyRow());
  }), [mirror]);

  const fetchRow = useCallback(async (sort: CatalogSort, nextPage = 1, epoch = sourceEpoch.current, initiator?: string): Promise<string | undefined> => {
    if (rowRequests.current.get(sort)?.epoch === epoch) return;
    const request = { epoch }; rowRequests.current.set(sort, request);
    const previous = nextPage > 1 ? catalogRef.current[sort]?.items ?? [] : [];
    setCatalog((current) => ({ ...current, [sort]: { ...(current[sort] ?? emptyRow()), loading: true, error: '', notice: undefined } }));
    try {
      const next = await loadCatalog({ page: nextPage, sort, type });
      if (epoch !== sourceEpoch.current) return;
      const items = mergeTitles([...previous, ...next.items]);
      const repeated = nextPage > 1 && items.length === previous.length && next.items.length > 0;
      setCatalog((current) => ({ ...current, [sort]: {
        items, nextPage: !repeated && next.nextPage && next.nextPage > nextPage ? next.nextPage : undefined,
        updates: nextPage === 1 ? next.updates : current[sort]?.updates,
        loading: false, error: '', notice: repeated ? 'Источник повторил предыдущую страницу.' : undefined,
      } }));
      if (sort === 'last' && nextPage === 1) setHero((current) => current ?? next.items[0]);
      if (initiator && items.length) focusLoaded(`title-${sort}-${Math.min(previous.length, items.length - 1)}`, initiator, () => pageRef.current === 'catalog' && sourceEpoch.current === epoch);
    } catch (error) {
      if (epoch === sourceEpoch.current) setCatalog((current) => ({ ...current, [sort]: { ...current[sort], loading: false, error: message(error) } }));
      return message(error);
    } finally { if (rowRequests.current.get(sort) === request) rowRequests.current.delete(sort); }
  }, [type]);
  const moreCatalog = (sort: CatalogSort) => {
    const row = catalogRef.current[sort];
    if (!demo && row?.nextPage && !row.loading && !row.error) void fetchRow(sort, row.nextPage);
  };
  useEffect(() => { resetProviderSession(); setDetailTrail([]); setPersonVisits([]); }, [mirror, demo, authAttempt]);
  useEffect(() => {
    const epoch = ++sourceEpoch.current;
    const entering = access.mirror !== mirror || access.status !== 'ready';
    setHero(undefined); setHeroNote(''); setCatalog({ last: emptyRow(), popular: emptyRow() });
    if (demo) {
      setAccess({ mirror, status: 'ready' });
      setHero(demoCatalog[0]); setCatalog({ last: { ...emptyRow(), items: demoCatalog }, popular: { ...emptyRow(), items: [...demoCatalog].reverse() } });
    } else if (mirror) {
      if (entering) setAccess({ mirror, status: 'checking' });
      setSessionKnown(false);
      void getSourceSession().then((next) => { if (epoch === sourceEpoch.current) setSession(next); }).catch(() => { if (epoch === sourceEpoch.current) setSession(undefined); })
        .finally(() => { if (epoch === sourceEpoch.current) setSessionKnown(true); });
      void Promise.all(rows.map((row) => fetchRow(row.sort, 1, epoch))).then((errors) => {
        if (epoch !== sourceEpoch.current) return;
        if (errors.every(Boolean)) { setAccess({ mirror, status: 'error', error: errors[0] }); focusSoon('gate-retry'); }
        else { setAccess({ mirror, status: 'ready' }); if (entering) { setPage('catalog'); homeFocus.current = true; } }
      });
    } else setAccess({ mirror, status: 'ready' });
    return () => { sourceEpoch.current++; };
  }, [mirror, demo, type, fetchRow, authAttempt]);

  // The home row of the account's saved titles. A failure only leaves the row out.
  useEffect(() => {
    if (!signedIn || !mirror || access.mirror !== mirror || access.status !== 'ready') { setSaved({ items: [], settled: false }); return; }
    let alive = true;
    void loadContinue().then((items) => { if (alive) setSaved({ items, settled: true }); })
      .catch(() => { if (alive) setSaved((previous) => ({ ...previous, settled: true })); });
    return () => { alive = false; };
  }, [signedIn, mirror, access.mirror, access.status, continueRevision]);
  // Without an account there is no list to wait for.
  const savedSettled = saved.settled || demo || !mirror || (sessionKnown && !session?.authenticated);

  useEffect(() => {
    const epoch = ++searchEpoch.current;
    const text = query.trim();
    if (text.length < 2 || !ready || gated) { setResults(emptyRow()); return; }
    if (demo) { setResults({ ...emptyRow(), items: demoCatalog.filter((item) => item.title.toLocaleLowerCase('ru').includes(text.toLocaleLowerCase('ru'))) }); return; }
    setResults({ ...emptyRow(), loading: true });
    const timer = window.setTimeout(() => {
      void searchTitles(text).then((next) => { if (epoch === searchEpoch.current) setResults({ ...next, loading: false, error: '' }); })
        .catch((error) => { if (epoch === searchEpoch.current) setResults({ ...emptyRow(), error: message(error) }); });
    }, 400);
    return () => { clearTimeout(timer); searchEpoch.current++; };
  }, [query, mirror, demo, ready, gated, searchAttempt]);
  const moreSearch = async (initiator?: string) => {
    const previous = resultsRef.current;
    if (!previous.nextPage || previous.loading || (!initiator && previous.error)) return;
    const epoch = searchEpoch.current;
    if (searchRequest.current?.epoch === epoch) return;
    const request = { epoch }; searchRequest.current = request;
    setResults((current) => ({ ...current, loading: true, error: '' }));
    try {
      const next = await searchTitles(query.trim(), previous.nextPage);
      if (epoch !== searchEpoch.current) return;
      const items = mergeTitles([...previous.items, ...next.items]);
      const repeated = items.length === previous.items.length && next.items.length > 0;
      setResults({ items, nextPage: !repeated && next.nextPage && next.nextPage > previous.nextPage ? next.nextPage : undefined,
        loading: false, error: '', notice: repeated ? 'Источник повторил предыдущую страницу.' : undefined });
      if (initiator && items.length) focusLoaded(`search-result-${Math.min(previous.items.length, items.length - 1)}`, initiator, () => pageRef.current === 'search' && searchEpoch.current === epoch);
    }
    catch (error) { if (epoch === searchEpoch.current) setResults((current) => ({ ...current, loading: false, error: message(error) })); }
    finally { if (searchRequest.current === request) searchRequest.current = undefined; }
  };

  const history = library.history.filter((item) => belongs(item.title));
  const favorites = library.favorites.filter(belongs);
  // What the home row shows: the account's list for a signed-in viewer, otherwise what was watched on this device.
  const continued = useMemo(() => orderContinue(saved.items, catalog.last?.updates).slice(0, 24), [saved.items, catalog.last?.updates]);
  const watchedHere = useMemo(() => { const seen = new Set<string>(); return history.filter((item) => !seen.has(item.title.url) && !!seen.add(item.title.url)).slice(0, 24); }, [library, belongs]);
  const homeStart = () => signedIn && continued.length ? `continue-${continued[0].saveId}` : !signedIn && watchedHere.length ? 'continue-local-0'
    : demo || catalogRef.current.last?.items.length ? 'title-last-0' : ready ? 'nav-catalog' : 'configure-source';
  // With no source yet the address field is the reason to open settings; otherwise start from the list of sections.
  const pageStart = (target: Page) => target === 'settings' ? (mirror ? 'settings-tab-source' : 'settings-mirror') : target === 'search' ? 'search-query' : target === 'browse' ? (demo ? 'nav-browse' : 'browse-type-films')
    : target === 'library' ? 'mine-tab-continue' : homeStart();
  useEffect(() => {
    if (!homeFocus.current || gated || !ready || page !== 'catalog') return;
    const settled = demo || (!catalog.last.loading && (catalog.last.items.length > 0 || !!catalog.last.error));
    if (!settled) return;
    // Focus counts as not yet chosen by the viewer while it is nowhere or on the first card the app put it on.
    const parked = () => { const key = getCurrentFocusKey(); return !key || key === 'SN:ROOT' || key === 'MAIN_CONTENT' || key === 'title-last-0' || !doesFocusableExist(key); };
    // The catalog is ready first: focus waits there until the account's list answers, then moves to it.
    if (!parked()) { homeFocus.current = false; return; }
    const target = homeStart(), final = savedSettled;
    // The move is deferred until the rows are in the page. If the rows change meanwhile it is replaced
    // by a fresh one, and if the viewer has gone elsewhere by the time it runs it is dropped.
    const timer = window.setTimeout(() => {
      if (final) homeFocus.current = false;
      if (parked() && target !== getCurrentFocusKey()) setFocus(target);
    }, 40);
    return () => clearTimeout(timer);
  }, [gated, ready, page, demo, catalog.last, saved, savedSettled, continued, watchedHere, session]);
  // The account may answer late; after a few seconds focus stays where it is.
  useEffect(() => { if (gated || !ready) return; const timer = window.setTimeout(() => { homeFocus.current = false; }, 3000); return () => clearTimeout(timer); }, [gated, ready, authAttempt, demo]);

  const navigate = (next: Page) => {
    setDetailTrail([]); setPersonVisits([]);
    // The list of what is being watched rereads itself whenever its tab is shown.
    if (next === 'library') setFavoritesRevision(value => value + 1);
    if (next === 'search') setRecent(readRecentSearches());
    setPage(next); setLibrary(readLibrary());
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' });
    // Focus enters the section once it is shown. A viewer who has already moved somewhere is left there.
    const initiator = getCurrentFocusKey(), start = pageStart(next);
    window.setTimeout(() => { const focused = getCurrentFocusKey(); if (focused === initiator || !doesFocusableExist(focused)) void setFocus(start); }, 40);
  };
  const startLogin = (returnKey: string) => {
    if (!mirror) { navigate('settings'); return; }
    loginReturnFocus.current = returnKey;
    resetProviderSession(); sourceEpoch.current++; searchEpoch.current++;
    setManualLogin(true);
  };
  const cancelLogin = useCallback(() => {
    if (loginReturnFocus.current === 'details-favorite') setDetailFocusOnLoad('details-favorite');
    setManualLogin(false); focusSoon(loginReturnFocus.current);
  }, []);
  const openTitle = (title: TitleSummary, progress?: HistoryItem) => {
    const initiator = getCurrentFocusKey();
    if (page === 'search' && query.trim().length >= 2) { rememberSearch(query); setRecent(readRecentSearches()); }
    if (page === 'person') setDetailTrail(previous => [...previous, { page: 'person', visitId: activePerson, focusKey: initiator }]);
    // A part or a similar title opened from a card: Back returns to that card and to the tile it was opened from.
    else if (page === 'details') { if (selected) setDetailTrail(previous => [...previous, { page: 'details', title: selected, history: selectedHistory, focusKey: initiator }]); }
    else { setDetailTrail([]); setPersonVisits([]); setReturnFocus(initiator || 'nav-catalog'); setOrigin(page); }
    setSelected(title); setSelectedHistory(progress); setDetailFocusOnLoad(undefined); setPage('details');
    window.setTimeout(() => {
      const focused = getCurrentFocusKey();
      if (pageRef.current === 'details' && (focused === initiator || !doesFocusableExist(focused))) void setFocus('details-favorite');
    }, 40);
  };
  const openPerson = (person: TitlePerson, kinopoiskFilmId?: string) => {
    if (!person.url || !selected) return;
    const focusKey = getCurrentFocusKey(), visitId = `person-${++personSequence.current}`;
    setDetailTrail(previous => [...previous, { page: 'details', title: selected, history: selectedHistory, focusKey }]);
    setPersonVisits(previous => [...previous, { id: visitId, person, kinopoiskFilmId }]); setActivePerson(visitId); setPage('person');
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' });
    window.setTimeout(() => {
      const focused = getCurrentFocusKey();
      if (pageRef.current === 'person' && activePersonRef.current === visitId && (focused === focusKey || !doesFocusableExist(focused))) void setFocus(`${visitId}-back`);
    }, 40);
  };
  const restoreDetailVisit = useCallback(() => {
    const previous = detailTrail.at(-1);
    if (!previous) return false;
    setDetailTrail(trail => trail.slice(0, -1));
    if (previous.page === 'details') {
      setSelected(previous.title); setSelectedHistory(previous.history);
      setDetailFocusOnLoad(previous.focusKey); setPage('details');
    } else {
      const initiator = getCurrentFocusKey();
      setActivePerson(previous.visitId); setPage('person');
      window.setTimeout(() => {
        const focused = getCurrentFocusKey();
        if (pageRef.current === 'person' && activePersonRef.current === previous.visitId && (focused === initiator || !doesFocusableExist(focused))) {
          void setFocus(doesFocusableExist(previous.focusKey) ? previous.focusKey : `${previous.visitId}-back`);
        }
      }, 40);
    }
    return true;
  }, [detailTrail]);
  const closePerson = useCallback(() => {
    setPersonVisits(previous => previous.filter(visit => visit.id !== activePerson));
    if (!restoreDetailVisit()) { setPage('catalog'); homeFocus.current = true; }
  }, [activePerson, restoreDetailVisit]);
  const closeDetails = useCallback(() => {
    if (restoreDetailVisit()) return;
    const current = readLibrary();
    const key = returnFocus, section = origin === 'details' || origin === 'person' || origin === 'player' ? 'catalog' : origin;
    setPage(section); setLibrary(current);
    const initiator = getCurrentFocusKey();
    // The list the title was opened from may have been reread meanwhile: return to the card if it is still there.
    window.setTimeout(() => {
      const focused = getCurrentFocusKey();
      if (pageRef.current !== section || !([initiator, key].includes(focused) || !doesFocusableExist(focused))) return;
      if (doesFocusableExist(key)) void setFocus(key);
      else if (section === 'catalog') void setFocus(homeStart());
      else void setFocus(doesFocusableExist(pageStart(section)) ? pageStart(section) : `nav-${section}`);
    }, 40);
  }, [origin, returnFocus, restoreDetailVisit, signedIn, continued, watchedHere, demo, ready]);
  const closePlayer = useCallback(() => {
    const currentLibrary = readLibrary();
    setSelectedHistory(undefined);
    setDetailFocusOnLoad(undefined);
    setPage('details'); setLibrary(currentLibrary); setViewing(undefined); setContinueRevision(value => value + 1); focusSoon('details-favorite');
  }, []);
  const afterSignIn = () => {
    setManualLogin(false); setGateSettings(false); setPage('catalog');
    setAccess({ mirror, status: 'checking' }); setAuthAttempt((value) => value + 1);
  };
  const signOut = async () => {
    const next = await sourceLogout(mirror);
    resetProviderSession(); sourceEpoch.current++; searchEpoch.current++;
    setSession(next); setAccess({ mirror, status: 'checking' });
    setGateSettings(false); setPage('catalog'); setViewing(undefined); setAuthAttempt((value) => value + 1);
  };
  const openSourceSettings = () => { setGateSettings(true); focusSoon('settings-mirror'); };
  const closeSourceSettings = () => { setGateSettings(false); focusSoon(access.status === 'login' || manualLogin ? 'auth-username' : 'gate-retry'); };
  useEffect(() => {
    const back = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isBack(event)) return;
      if (gated) {
        event.preventDefault();
        if (gateSettings) { setGateSettings(false); focusSoon(access.status === 'login' || manualLogin ? 'auth-username' : 'gate-retry'); }
        else if (manualLogin) cancelLogin();
        return;
      }
      if (page === 'player') return;
      event.preventDefault();
      if (page === 'details') { closeDetails(); return; }
      if (page === 'person') { closePerson(); return; }
      // Back leads out step by step: to the top of the page, to the menu, then out of the app.
      const main = document.querySelector('main'), focused = getCurrentFocusKey();
      if (focused.startsWith('nav-')) { if (isTelevision()) leaveApp(); }
      else if (main && main.scrollTop > 4) { main.scrollTo({ top: 0, behavior: 'instant' }); focusSoon(doesFocusableExist(pageStart(page)) ? pageStart(page) : `nav-${page}`); }
      else focusSoon(ready ? `nav-${page}` : 'configure-source');
    };
    window.addEventListener('keydown', back); return () => window.removeEventListener('keydown', back);
  }, [page, closeDetails, closePerson, ready, gated, gateSettings, manualLogin, access.status, cancelLogin, signedIn, continued, watchedHere, demo]);

  const focusTitle = (title: TitleSummary, note = '') => { setHero(title); setHeroNote(note); };
  const progressNote = (progress: HistoryItem) => progress.episode ? `Вы остановились: сезон ${progress.episode.season}, серия ${progress.episode.id}` : 'Вы остановились';
  const card = (title: TitleSummary, id: string, progress?: HistoryItem, onNearEnd?: () => void) => <TVButton key={id} id={id} className="poster-button" label={`Открыть ${title.title}${progress?.episode ? ` · Сезон ${progress.episode.season}, серия ${progress.episode.id}` : ''}`} onPress={() => openTitle(title, progress)} onFocused={() => { focusTitle(title, progress ? progressNote(progress) : ''); onNearEnd?.(); }}>
    <span className="card-art"><PosterImage title={title} />
      {progress && progress.duration > 0 && <span className="card-progress"><i style={{ width: `${Math.min(100, progress.position / progress.duration * 100)}%` }} /></span>}
    </span>
    <span className="card-title">{title.title}</span>
    {progress ? <span className="card-subtitle">{progress.episode ? `Сезон ${progress.episode.season}, серия ${progress.episode.id}` : progress.duration > 0 && progress.position >= progress.duration - 2 ? 'Просмотрено' : progress.duration > 0 ? `Осталось ${Math.max(1, Math.ceil((progress.duration - progress.position) / 60))} мин` : `${Math.floor(progress.position / 60)} мин просмотрено`}</span>
      : pageRef.current !== 'catalog' && <span className="card-subtitle">{title.meta || title.year}</span>}
  </TVButton>;
  const clockText = clock.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (gated) {
    if (gateSettings) return <main className="auth-screen source-settings-screen" data-testid="screen-source-settings">
      <header className="auth-header"><img className="auth-logo" src={`${import.meta.env.BASE_URL}assets/rezzka-logo.svg`} alt="Rezzka" /><time>{clockText}</time></header>
      <SettingsScreen current={settings} onUpdate={setSettings} onLeave={closeSourceSettings} theme={theme} onTheme={updateTheme} standalone />
    </main>;
    if (!loadingSettings && (access.status === 'login' || manualLogin) && access.mirror === mirror) return <AuthScreen key={mirror} mirrorUrl={mirror} clock={clockText} onSuccess={afterSignIn} onChangeSource={openSourceSettings}
      onCancel={manualLogin ? cancelLogin : undefined} />;
    return <main className="auth-screen" data-testid="screen-access">
      <header className="auth-header"><img className="auth-logo" src={`${import.meta.env.BASE_URL}assets/rezzka-logo.svg`} alt="Rezzka" /><time>{clockText}</time></header>
      <section className="auth-card access-card"><h1>{access.status === 'error' && access.mirror === mirror ? 'Источник недоступен' : 'Открываем ваш кинозал'}</h1>
        {access.status === 'error' && access.mirror === mirror ? <><p role="alert">{access.error}</p><div className="auth-actions"><TVButton id="gate-retry" className="primary" onPress={() => { setAccess({ mirror, status: 'checking' }); setAuthAttempt((value) => value + 1); }}>Повторить</TVButton><TVButton id="gate-settings" onPress={openSourceSettings}>Изменить источник</TVButton></div></>
          : <p role="status">{loadingSettings ? 'Загружаем настройки…' : 'Проверяем доступ к источнику…'}</p>}
      </section>
    </main>;
  }
  const home = page === 'catalog' && ready;
  const pageTitle = page === 'details' ? selected?.title ?? '' : page === 'person' ? '' : sections.find((item) => item.id === page)?.label ?? '';
  return <>{page === 'player' && viewing && <Player {...viewing} authenticated={session?.authenticated} resume={settings.values.resumePlayback} preferredQuality={settings.values.preferredQuality} subtitles={settings.values.subtitles} autoNext={settings.values.autoNext}
    onClose={closePlayer} onResolve={(voice, episode) => isDemoTitle(viewing.title) ? Promise.resolve(demoPlayback()) : loadPlayback(viewing.title, voice, episode)}
    onLoadEpisodes={(voice) => loadEpisodes(viewing.title, voice)} />}
  <TVFocusScope active={page !== 'player'}><div className="app-shell" hidden={page === 'player'}>
    <aside className="sidebar">
      <div className="brand" role="img" aria-label="Rezzka"><img className="brand-compact" src={`${import.meta.env.BASE_URL}assets/rezzka-mark.svg`} alt="" /><img className="brand-full" src={`${import.meta.env.BASE_URL}assets/rezzka-logo.svg`} alt="" /></div>
      <nav aria-label="Главное меню">{sections.map((item) => <TVButton key={item.id} id={`nav-${item.id}`} className={`nav-button ${item.id === 'settings' ? 'nav-last' : ''}`} label={item.label} selected={page === item.id || ((page === 'details' || page === 'person') && origin === item.id)} onPress={() => navigate(item.id)}
        onArrow={direction => {
          if (direction !== 'right') return true;
          // The expanded menu overlaps the page's bounds. Enter its focus scope
          // explicitly instead of choosing a target by animated coordinates.
          void setFocus('MAIN_CONTENT'); return false;
        }}><NavIcon name={item.id} /><span className="nav-label">{item.label}</span></TVButton>)}</nav>
    </aside>
    <MainContent active={page !== 'player'} page={page}>
      <header className="topbar" data-pinned>
        <span className={`topbar-title ${page === 'details' ? 'when-scrolled' : ''}`} data-testid="page-title">{pageTitle}</span>
        <div className="topbar-tools" id="topbar-tools" />
        <div className="topbar-right">{demo && <span className="demo-badge">Демо</span>}<time>{clockText}</time></div>
      </header>
      {home && <TopbarTools><div className="chips" role="group" aria-label="Тип каталога">
        {demo ? <TVButton id="exit-demo" onPress={() => { setDemo(false); homeFocus.current = true; if (!mirror) focusSoon('configure-source'); }}>Выйти из демо</TVButton>
          : filters.map((item) => <TVButton key={item.id} id={`filter-${item.id}`} selected={type === item.id} disabled={type !== item.id && rows.some((row) => catalog[row.sort].loading)} onPress={() => setType(item.id)}>{item.label}</TVButton>)}
      </div></TopbarTools>}
      <TVFocusScope active={page === 'browse' && ready}><div hidden={page !== 'browse' || !ready}><BrowseScreen key={`${mirror}|${demo}`} active={page === 'browse' && ready} demo={demo} onOpen={openTitle} /></div></TVFocusScope>
      <TVFocusScope active={page === 'library' && ready}><div hidden={page !== 'library' || !ready}><MineScreen key={`${mirror}|${demo}`} active={page === 'library' && ready} demo={demo} authenticated={signedIn} favoritesRevision={favoritesRevision} continueRevision={continueRevision}
        updates={catalog.last?.updates} onOpenSaved={(title) => openTitle(title)} onOpenFavorite={(title) => openTitle(title)} onSignIn={startLogin}
        localHistory={<section className="history-screen"><div className="poster-grid" data-anchor-items="top">{history.map((item, index) => card(item.title, `history-${index}`, item))}</div>{!history.length && <div className="empty-state"><h2>Вы пока ничего не смотрели</h2><p>Здесь появятся фильмы и серии, которые вы смотрели. Мы запомним озвучку и место остановки.</p></div>}</section>}
        localFavorites={<section><div className="poster-grid" data-anchor-items="top">{favorites.map((title, index) => card(title, `favorite-${index}`))}</div>{!favorites.length && <div className="empty-state"><h2>В избранном пока пусто</h2><p>Добавьте фильм или сериал в избранное на странице описания.</p></div>}</section>} /></div></TVFocusScope>
      {personVisits.map(visit => <TVFocusScope key={visit.id} active={page === 'person' && activePerson === visit.id}><div hidden={page !== 'person' || activePerson !== visit.id}><PersonScreen visitId={visit.id} person={visit.person} kinopoiskFilmId={visit.kinopoiskFilmId} active={page === 'person' && activePerson === visit.id} onOpen={openTitle} onBack={closePerson} /></div></TVFocusScope>)}
      {page === 'person' || ((page === 'browse' || page === 'library') && ready) ? null : page === 'settings' ? <SettingsScreen current={settings} onUpdate={setSettings} onLeave={() => navigate('catalog')} theme={theme} onTheme={updateTheme} session={session}
        onSignIn={() => startLogin('settings-signin')} onSignOut={signOut} />
        : page === 'details' && selected ? <TitleScreen key={selected.url} summary={selected} history={selectedHistory} focusOnLoad={detailFocusOnLoad} settings={settings.values} authenticated={session?.authenticated} onOpen={openTitle} onOpenPerson={openPerson} onSignIn={() => startLogin('details-favorite')} onFavoritesChanged={() => setFavoritesRevision(value => value + 1)} onPlay={(next) => { setViewing(next); setPage('player'); }} />
          : loadingSettings ? <div className="empty-state" role="status"><h1>Rezzka</h1><p>Загружаем настройки…</p></div>
            : !ready ? <section className="welcome"><p className="eyebrow">Ваш домашний кинозал</p><h1>Хороший вечер<br />начинается с выбора.</h1><p>Укажите адрес источника. Настройки доступны здесь и с телефона в домашней сети.</p><div className="actions"><TVButton id="configure-source" className="primary" onPress={() => navigate('settings')}>Настроить источник</TVButton><TVButton id="demo-start" onPress={() => { setDemo(true); setPage('catalog'); focusSoon('title-last-0'); }}>Открыть демо</TVButton></div><p className="welcome-footnote">Источник не настроен · демо работает без сети</p>{serviceError && <div className="inline-error" role="alert"><p>{serviceError}</p><TVButton id="service-retry" onPress={() => void loadSettings()}>Повторить</TVButton></div>}</section>
              : page === 'search' ? <section className="search-screen"><div className="search-head" data-pinned><TVField id="search-query" label="Название фильма или сериала" value={query} onChange={setQuery} placeholder={demo ? 'Поиск в демо' : 'Введите не менее двух символов'} /></div>
                {!query.trim() && recent.length > 0 && <div className="search-recent"><h2>Недавние запросы</h2><div className="chips" role="group" aria-label="Недавние запросы">{recent.map((text, index) => <TVButton key={text} id={`search-recent-${index}`} onPress={() => { setQuery(text); focusSoon('search-query'); }}>{text}</TVButton>)}</div></div>}
                {results.loading && !results.items.length && <p role="status" className="section-note">Ищем…</p>}{results.error && <div className="inline-error" role="alert"><p>{results.error}</p><TVButton id="search-retry" onPress={() => results.items.length && results.nextPage ? void moreSearch('search-retry') : setSearchAttempt((value) => value + 1)}>Повторить</TVButton></div>}
                {!results.loading && !results.error && query.trim().length >= 2 && !results.items.length && <p className="empty-state">Ничего не найдено. Попробуйте другое название.</p>}
                <div className="poster-grid" data-anchor-items="top">{results.items.map((title, index) => card(title, `search-result-${index}`, undefined, index >= results.items.length - 7 ? () => void moreSearch() : undefined))}</div>
                {results.nextPage && <LoadMoreTrigger enabled={!results.loading && !results.error} onLoad={() => void moreSearch()} />}{results.loading && !!results.items.length && <p className="section-note" role="status">Загружаем следующие результаты…</p>}
                {results.notice && <p className="section-note" role="status">{results.notice}</p>}
                <div className="page-end" />
              </section> : <section className="catalog" data-testid="home">
                  <Spotlight title={hero} note={heroNote} placeholder={demo ? 'Знакомство с Rezzka' : 'Выбирайте кино'} />
                  {signedIn && continued.length > 0 && <section className="catalog-row" data-anchor="top" data-testid="home-continue"><div className="rail-heading"><h2>Продолжить просмотр</h2></div>
                    <div className="poster-row" data-row>{continued.map((item) => <TVButton key={item.saveId} id={`continue-${item.saveId}`} className="poster-button" label={`Открыть ${item.title.title}${item.fresh ? `, вышла новая серия: ${item.fresh}` : ''}`} onPress={() => openTitle(item.title)}
                      onFocused={() => focusTitle(item.title, [item.info ? `Вы остановились: ${item.info}` : 'Вы смотрели', item.fresh ? `новое: ${item.fresh.toLocaleLowerCase('ru')}` : ''].filter(Boolean).join(' · '))}>
                      <span className="card-art"><PosterImage title={item.title} />{item.fresh && <span className="card-badge">Новая серия</span>}</span>
                      <span className="card-title">{item.title.title}</span><span className="card-subtitle">{item.info || item.dateLabel}</span>
                    </TVButton>)}</div></section>}
                  {!signedIn && watchedHere.length > 0 && <section className="catalog-row" data-anchor="top" data-testid="home-continue"><div className="rail-heading"><h2>Продолжить просмотр</h2></div>
                    <div className="poster-row" data-row>{watchedHere.map((item, index) => card(item.title, `continue-local-${index}`, item))}</div></section>}
                  {rows.map(({ sort, label }) => <section className="catalog-row" data-anchor="top" key={sort}><div className="rail-heading"><h2>{label}</h2></div>
                    {catalog[sort].loading && !catalog[sort].items.length && <><p role="status" className="sr-only">Загружаем каталог…</p><div className="skeleton-row" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index} className="skeleton-card" />)}</div></>}
                    {catalog[sort].error && <div className="inline-error" role="alert"><p>{catalog[sort].error}</p><div className="actions"><TVButton id={`catalog-retry-${sort}`} onPress={() => void fetchRow(sort, catalog[sort].nextPage ?? 1, sourceEpoch.current, `catalog-retry-${sort}`)}>Повторить</TVButton><TVButton id={`catalog-source-${sort}`} onPress={() => navigate('settings')}>Изменить источник</TVButton>{sort === 'last' && <TVButton id="demo-start" onPress={() => { setDemo(true); focusSoon('title-last-0'); }}>Открыть демо</TVButton>}</div></div>}
                    <div className="poster-row" data-row>{catalog[sort].items.map((title, index) => card(title, `title-${sort}-${index}`, undefined, index >= catalog[sort].items.length - 2 ? () => moreCatalog(sort) : undefined))}{catalog[sort].nextPage && <LoadMoreTrigger enabled={!catalog[sort].loading && !catalog[sort].error} onLoad={() => moreCatalog(sort)} />}</div>
                    {catalog[sort].loading && !!catalog[sort].items.length && <p className="sr-only" role="status">Загружаем…</p>}
                    {catalog[sort].notice && <p className="section-note" role="status">{catalog[sort].notice}</p>}
                    {!catalog[sort].loading && !catalog[sort].error && !catalog[sort].items.length && <p className="section-note">В этом разделе пока нет фильмов.</p>}
                  </section>)}
                  <div className="page-end" />
                </section>}
    </MainContent>
  </div></TVFocusScope></>;
}
