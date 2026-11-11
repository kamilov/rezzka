import { useState, type ReactNode } from 'react';
import type { SeriesUpdate, TitleSummary } from '../shared/source';
import { TVButton, TVFocusScope } from './navigation';
import { TopbarTools } from './MainContent';
import ContinueScreen from './ContinueScreen';
import FavoritesScreen from './FavoritesScreen';

type Tab = 'continue' | 'favorites';
/**
 * Everything the viewer keeps: what is being watched and the lists of favorites.
 * In the demo both come from this device and are passed in ready to show.
 */
export default function MineScreen({ active, demo, authenticated, favoritesRevision, continueRevision, updates, localHistory, localFavorites, onOpenSaved, onOpenFavorite, onSignIn }: {
  active: boolean; demo: boolean; authenticated: boolean; favoritesRevision: number; continueRevision: number; updates?: SeriesUpdate[];
  localHistory: ReactNode; localFavorites: ReactNode;
  onOpenSaved: (title: TitleSummary) => void; onOpenFavorite: (title: TitleSummary) => void; onSignIn: (returnFocus: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('continue');
  return <section className="mine-screen" data-testid="mine-screen">
    {active && <TopbarTools><div className="chips" role="group" aria-label="Мои списки">
      <TVButton id="mine-tab-continue" selected={tab === 'continue'} onPress={() => setTab('continue')}>Досмотреть</TVButton>
      <TVButton id="mine-tab-favorites" selected={tab === 'favorites'} onPress={() => setTab('favorites')}>Избранное</TVButton>
    </div></TopbarTools>}
    <TVFocusScope active={tab === 'continue'}><div hidden={tab !== 'continue'}>
      {demo ? localHistory : <ContinueScreen active={active && tab === 'continue'} authenticated={authenticated} updates={updates} revision={continueRevision} onOpen={onOpenSaved} onSignIn={() => onSignIn('history-signin')} />}
    </div></TVFocusScope>
    <TVFocusScope active={tab === 'favorites'}><div hidden={tab !== 'favorites'}>
      {demo ? localFavorites : <FavoritesScreen active={active && tab === 'favorites'} authenticated={authenticated} revision={favoritesRevision} onOpen={onOpenFavorite} onSignIn={() => onSignIn('favorites-signin')} />}
    </div></TVFocusScope>
    <div className="page-end" />
  </section>;
}
