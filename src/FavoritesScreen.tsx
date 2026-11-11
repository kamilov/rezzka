import { useEffect, useRef, useState } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { FavoritesPage, TitleSummary } from '../shared/source';
import { loadFavorites } from './provider-favorites';
import { PosterImage } from './TitleScreen';
import { TVButton } from './navigation';
import { LoadMoreTrigger } from './LoadMoreTrigger';

type Result = FavoritesPage & { loaded: boolean; loading: boolean; error: string };
const empty = (): Result => ({ collections: [], items: [], loaded: false, loading: false, error: '' });
const merge = (items: TitleSummary[]) => [...new Map(items.map(item => [item.url, item])).values()];
export default function FavoritesScreen({ active, authenticated, revision, onOpen, onSignIn }: {
  active: boolean; authenticated: boolean; revision: number; onOpen: (title: TitleSummary) => void; onSignIn: () => void;
}) {
  const [result, setResult] = useState<Result>(empty);
  const epoch = useRef(0), lastPage = useRef(1), loadedRevision = useRef(-1);
  const pending = useRef<object | null>(null);
  const failed = useRef({ page: 1, refresh: true, collectionId: undefined as string | undefined });
  const snapshot = useRef({ active, authenticated, result }); snapshot.current = { active, authenticated, result };

  const fetchPage = async (page: number, refresh: boolean, collectionId?: string) => {
    const state = snapshot.current;
    if (!state.active || !state.authenticated || pending.current) return;
    const ticket = epoch.current, request = {}; pending.current = request;
    failed.current = { page, refresh, collectionId };
    setResult(previous => ({ ...previous, loading: true, error: '' }));
    try {
      // Recheck loaded pages after an edit, keeping the previous list visible until complete.
      const pages = refresh ? lastPage.current : page;
      let next = await loadFavorites({ collectionId, page });
      if (ticket !== epoch.current) return;
      let items = merge([...(refresh ? [] : state.result.items), ...next.items]);
      let fetchedPage = page;
      if (!refresh && items.length === state.result.items.length) next.nextPage = undefined;
      while (refresh && next.nextPage && next.nextPage > fetchedPage && fetchedPage < pages) {
        fetchedPage = next.nextPage;
        const following = await loadFavorites({ collectionId: next.selectedCollectionId, page: fetchedPage });
        if (ticket !== epoch.current) return;
        const combined = merge([...items, ...following.items]);
        next = { ...following, nextPage: combined.length > items.length ? following.nextPage : undefined };
        items = combined;
      }
      const focused = getCurrentFocusKey();
      lastPage.current = fetchedPage;
      setResult({ ...next, items, loaded: true, loading: false, error: '' });
      const missingCard = focused.startsWith('favorite-') && !items.some(item => `favorite-${item.id}` === focused);
      const missingCollection = focused.startsWith('favorites-collection-') && !next.collections.some(item => `favorites-collection-${item.id}` === focused);
      if (missingCard || missingCollection || focused === 'favorites-retry' || focused === 'favorites-reload') {
        const target = focused === 'favorites-retry' && !refresh ? items[Math.min(state.result.items.length, items.length - 1)] : items[0];
        window.setTimeout(() => {
          if (ticket === epoch.current && snapshot.current.active && getCurrentFocusKey() === focused) {
            void setFocus(target ? `favorite-${target.id}` : next.selectedCollectionId ? `favorites-collection-${next.selectedCollectionId}` : 'mine-tab-favorites');
          }
        }, 40);
      }
    } catch (reason) {
      if (ticket === epoch.current) setResult(previous => ({ ...previous, loading: false, error: reason instanceof Error ? reason.message : 'Не удалось загрузить избранное.' }));
    } finally { if (pending.current === request) pending.current = null; }
  };
  useEffect(() => {
    if (!active || !authenticated || loadedRevision.current === revision) return;
    loadedRevision.current = revision; epoch.current++; pending.current = null;
    void fetchPage(1, true, snapshot.current.result.selectedCollectionId);
  }, [active, authenticated, revision]);
  useEffect(() => () => { epoch.current++; pending.current = null; }, []);
  const select = (collectionId?: string) => {
    if (collectionId === result.selectedCollectionId && !result.error) return;
    epoch.current++; pending.current = null; lastPage.current = 1;
    setResult(previous => ({ ...empty(), collections: previous.collections, selectedCollectionId: collectionId }));
    void fetchPage(1, true, collectionId);
  };
  const more = () => {
    const state = snapshot.current;
    if (state.active && state.result.nextPage && !state.result.loading && !state.result.error) void fetchPage(state.result.nextPage, false, state.result.selectedCollectionId);
  };
  return <section className="favorites-screen">
    {!authenticated ? <div className="empty-state"><h2>Войдите в аккаунт</h2><p>Списки избранного хранятся в аккаунте источника. После входа они появятся здесь.</p><TVButton id="favorites-signin" className="primary" onPress={onSignIn}>Войти в аккаунт</TVButton></div>
      : <>
        {!!result.collections.length && <div className="chips collection-tabs" role="group" aria-label="Коллекции избранного">{result.collections.map(collection => <TVButton key={collection.id} id={`favorites-collection-${collection.id}`} selected={collection.id === result.selectedCollectionId} onPress={() => select(collection.id)}>{collection.name}{collection.count !== undefined && <span className="favorite-count"> · {collection.count}</span>}</TVButton>)}</div>}
        {result.loading && <p role="status" className="section-note">{result.items.length ? 'Обновляем избранное…' : 'Загружаем избранное…'}</p>}
        {result.error && <div className="inline-error" role="alert"><p>{result.error}</p><div className="actions"><TVButton id="favorites-retry" onPress={() => { const request = failed.current; void fetchPage(request.page, request.refresh, request.collectionId); }}>Повторить</TVButton><TVButton id="favorites-reload" onPress={() => select(undefined)}>Обновить коллекции</TVButton></div></div>}
        <div className="poster-grid" data-anchor-items="top">{result.items.map((title, index) => <TVButton key={title.url} id={`favorite-${title.id}`} className="poster-button" label={`Открыть ${title.title}`} onPress={() => onOpen(title)} onFocused={index >= result.items.length - 7 ? more : undefined}><PosterImage title={title} /><span className="card-title">{title.title}</span><span className="card-subtitle">{title.meta || title.year}</span></TVButton>)}</div>
        {result.nextPage && <LoadMoreTrigger enabled={active && !result.loading && !result.error} onLoad={more} />}
        {result.loaded && !result.loading && !result.error && !result.items.length && <p className="empty-state">{result.collections.length ? 'В этой коллекции пока нет фильмов. Добавьте их через «Избранное» в карточке.' : 'В аккаунте пока нет коллекций. Создайте список через «Избранное» в карточке фильма.'}</p>}
      </>}
  </section>;
}
