import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { SeriesUpdate, TitleSummary } from '../shared/source';
import { loadContinue, orderContinue, type ContinueItem } from './provider-continue';
import { PosterImage } from './TitleScreen';
import { TVButton } from './navigation';
import { LoadMoreTrigger } from './LoadMoreTrigger';

const batchSize = 28;
/**
 * The account's «Досмотреть» list. Series with a released episode the viewer has
 * not reached come first and carry a mark; `revision` rereads the list.
 */
export default function ContinueScreen({ active, authenticated, updates, revision = 0, onOpen, onSignIn }: {
  active: boolean; authenticated: boolean; updates?: SeriesUpdate[]; revision?: number; onOpen: (title: TitleSummary) => void; onSignIn: () => void;
}) {
  const [items, setItems] = useState<ContinueItem[]>([]);
  const [limit, setLimit] = useState(batchSize);
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const ticket = useRef(0), inFlight = useRef(false);
  const activeRef = useRef(active); activeRef.current = active;
  const refresh = useCallback(async () => {
    if (!authenticated || inFlight.current) return;
    const current = ++ticket.current;
    inFlight.current = true; setLoading(true); setError('');
    try {
      const next = await loadContinue();
      if (current === ticket.current) {
        const focus = getCurrentFocusKey();
        setItems(next); setLoaded(true);
        if (/^history-\d+$/.test(focus) && !next.some((item) => `history-${item.saveId}` === focus)) {
          window.setTimeout(() => {
            if (current === ticket.current && activeRef.current && getCurrentFocusKey() === focus) void setFocus(next[0] ? `history-${next[0].saveId}` : 'mine-tab-continue');
          }, 40);
        }
      }
    } catch (reason) {
      if (current === ticket.current) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить список из аккаунта.');
    } finally {
      if (current === ticket.current) { inFlight.current = false; setLoading(false); }
    }
  }, [authenticated]);
  useEffect(() => { if (active) void refresh(); }, [active, refresh, revision]);
  useEffect(() => () => { ticket.current++; inFlight.current = false; }, []);
  const ordered = useMemo(() => orderContinue(items, updates), [items, updates]);
  const more = () => { if (active) setLimit((count) => Math.min(ordered.length, count + batchSize)); };
  return <section className="history-screen">
    {!authenticated ? <div className="empty-state"><h2>Войдите в аккаунт</h2><p>«Досмотреть» хранится в аккаунте источника. После входа список появится здесь и на главной.</p><TVButton id="history-signin" className="primary" onPress={onSignIn}>Войти в аккаунт</TVButton></div>
      : <>
        {loading && !loaded && <p role="status" className="section-note">Загружаем ваши просмотры…</p>}
        {error && <div className="inline-error" role="alert"><p>{error}</p><TVButton id="history-retry" onPress={() => void refresh()}>Повторить</TVButton></div>}
        <div className="poster-grid" data-anchor-items="top">{ordered.slice(0, limit).map((item, index) => <TVButton key={item.saveId} id={`history-${item.saveId}`} className="poster-button" label={`Открыть ${item.title.title}${item.fresh ? `, вышла новая серия: ${item.fresh}` : ''}`} onPress={() => onOpen(item.title)} onFocused={index >= limit - 7 ? more : undefined}>
          <span className="card-art"><PosterImage title={item.title} />{item.fresh && <span className="card-badge">Новая серия</span>}</span>
          <span className="card-title">{item.title.title}</span>
          {item.info && <span className="card-subtitle">{item.info}</span>}
          <span className="card-subtitle">{item.fresh ? `Новое: ${item.fresh.toLocaleLowerCase('ru')}` : item.watched ? 'Просмотрено' : item.dateLabel}</span>
        </TVButton>)}</div>
        {limit < ordered.length && <LoadMoreTrigger enabled={active} onLoad={more} />}
        {!loading && !error && loaded && !items.length && <div className="empty-state"><h2>Вы пока ничего не смотрели</h2><p>Начатые фильмы и сериалы появятся здесь вместе с озвучкой и серией, на которой вы остановились.</p></div>}
      </>}
  </section>;
}
