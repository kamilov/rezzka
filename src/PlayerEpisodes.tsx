import { useEffect, useRef, useState } from 'react';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import type { Episode } from '../shared/source';
import { centerInRow, TVButton } from './navigation';
import Icon from './Icon';
import './player-episodes.css';

/** Seasons as tabs and the episodes of the chosen one as a list. A season opens as soon as its tab takes focus. */
export default function PlayerEpisodes({ episodes, current, onSelect }: {
  episodes: Episode[]; current?: Episode; onSelect: (episode: Episode) => void;
}) {
  const seasons = [...new Set(episodes.map((episode) => episode.season))];
  const [season, setSeason] = useState(() => current && seasons.includes(current.season) ? current.season : seasons[0]);
  // The index in the whole list names the button, so the opener can focus the current episode.
  const strip = useRef<HTMLDivElement>(null);
  // The list opens with focus on the current episode, so its season's tab is brought into sight separately.
  useEffect(() => centerInRow(strip.current?.querySelector<HTMLElement>('[aria-pressed="true"]')), []);
  const shown = episodes.map((episode, index) => ({ episode, index })).filter((entry) => entry.episode.season === season);
  return <div className="player-seasons" data-testid="player-seasons">
    {seasons.length > 1 && <div ref={strip} className="chips" data-row="tabs" role="group" aria-label="Сезоны">{seasons.map((value, index) =>
      <TVButton key={value} id={`player-season-${index}`} selected={value === season} onPress={() => setSeason(value)} onFocused={() => setSeason(value)}>Сезон {value}</TVButton>)}</div>}
    <div className="sheet-options" role="group" aria-label={`Серии сезона ${season}`}>{shown.map(({ episode, index }, position) => {
      const selected = episode.season === current?.season && episode.id === current.id;
      return <TVButton key={`${episode.season}-${episode.id}`} id={`player-episode-${index}`} selected={selected} label={`${episode.title}${selected ? ' · Сейчас на экране' : ''}`} onPress={() => onSelect(episode)}
        // Up from the list returns to the open season: any other tab would replace the list on focus.
        onArrow={(direction) => { if (direction !== 'up' || position > 0 || seasons.length < 2) return true; void setFocus(`player-season-${seasons.indexOf(season)}`); return false; }}>
        <Icon name="check" className="option-mark" /><span>{episode.title}</span>{selected && <span className="option-note player-episode-current" aria-hidden="true">Сейчас</span>}
      </TVButton>;
    })}</div>
  </div>;
}
