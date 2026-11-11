import { useEffect, useRef, useState, type ReactNode } from 'react';
import { doesFocusableExist, FocusContext, getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { Episode, Playback, SeekFrame, TitleDetails, Voice } from '../shared/source';
import { getProgress, saveProgress, writeAccountMark } from './library';
import { focusSoon, isBack, TVButton } from './navigation';
import { isTelevision } from './platform';
import { clampPosition, formatTime, isHlsStream, nativeStreams, selectStream } from './player-utils';
import PlayerEpisodes from './PlayerEpisodes';
import Icon from './Icon';
import { frameAt, loadSeekFrames } from './provider-thumbnails';
import { saveContinue } from './provider-continue';
import { isDemoTitle } from './demo-source';

interface PlayerProps {
  title: TitleDetails; voice: Voice; episode?: Episode; playback?: Playback; resume: boolean;
  preferredQuality: 'auto' | '1080p' | '720p'; subtitles: boolean; onClose: () => void;
  onResolve: (voice: Voice, episode?: Episode) => Promise<Playback>;
  onLoadEpisodes?: (voice: Voice) => Promise<Episode[]>;
  authenticated?: boolean;
  /** Episodes of the chosen voice when the card has already loaded them. */
  episodes?: Episode[];
  /** Start the next episode by itself when the current one ends. */
  autoNext?: boolean;
}
type Panel = 'quality' | 'voice' | 'subtitles' | 'episodes';
const panelNames: Record<Panel, string> = { quality: 'Качество', voice: 'Озвучка', subtitles: 'Субтитры', episodes: 'Серии' };
const sameEpisode = (a?: Episode, b?: Episode) => a?.id === b?.id && a?.season === b?.season;

function PlayerPanel({ name, children, onClose, initialFocus = 'player-panel-close' }: { name: string; children: ReactNode; onClose: () => void; initialFocus?: string }) {
  const { ref, focusKey } = useFocusable({ focusKey: 'PLAYER_PANEL', isFocusBoundary: true, focusBoundaryDirections: ['left', 'right', 'up', 'down'] });
  const firstFocus = useRef(initialFocus);
  useEffect(() => {
    // Children have registered by this effect. Cancelling the callback on close
    // prevents a quick Back from focusing a panel that has already disappeared.
    const timer = window.setTimeout(() => {
      if (!ref.current?.querySelector('[data-focused="true"]') && doesFocusableExist(firstFocus.current)) void setFocus(firstFocus.current);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="player-panel-title" className="sheet" data-testid="player-panel">
        <div className="sheet-heading"><h2 id="player-panel-title">{name}</h2><TVButton id="player-panel-close" className="sheet-close" onPress={onClose}>Закрыть</TVButton></div>
        <div className="sheet-body">{children}</div>
      </section>
    </FocusContext.Provider>
  </div>;
}

export default function Player(props: PlayerProps) {
  const { title, onClose } = props;
  const { ref: container, focusKey } = useFocusable({ focusKey: 'PLAYER', isFocusBoundary: true });
  const video = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState({ voice: props.voice, episode: props.episode, playback: props.playback });
  const [episodes, setEpisodes] = useState(props.episodes ?? (props.voice.id === props.title.selectedVoiceId ? props.title.episodes : []));
  const [quality, setQuality] = useState<string>(props.preferredQuality);
  const [subtitle, setSubtitle] = useState<string | null>(props.subtitles ? props.playback?.subtitles[0]?.url ?? null : null);
  const [nativeHls, setNativeHls] = useState(isTelevision);
  const [capabilitiesReady, setCapabilitiesReady] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [visible, setVisible] = useState(true), [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0), [duration, setDuration] = useState(0), [seek, setSeek] = useState<number | null>(null);
  const [loading, setLoading] = useState(true), [resolving, setResolving] = useState(!props.playback);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [frames, setFrames] = useState<SeekFrame[]>([]);
  // The offer of the next episode near the end: hidden until then, and gone for this episode once declined.
  const [nextUp, setNextUp] = useState<'hidden' | 'shown' | 'declined'>('hidden');
  const stream = selectStream(current.playback?.streams ?? [], quality, nativeHls);
  const subtitleLabel = current.playback?.subtitles.find((track) => track.url === subtitle)?.label;
  const qualities = [...new Set(nativeStreams(current.playback?.streams ?? [], nativeHls).map((item) => item.quality))];
  const episodeIndex = episodes.findIndex((item) => sameEpisode(item, current.episode));
  const nextEpisode = episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const pendingStart = useRef({ position: props.resume ? getProgress(title.url, props.voice.id, props.episode) : 0, play: true, fromSaved: true });
  const request = useRef(0), alive = useRef(true), started = useRef(false), lastSaved = useRef(0), lastInteraction = useRef(Date.now());
  const revealFocus = useRef<number | undefined>(undefined);
  const retryTarget = useRef<{ voice: Voice; episode?: Episode } | null>(null);
  const snapshot = useRef({ current, title, episodes, visible, paused, seek, loading, resolving, error, panel, position, duration, nextUp });
  snapshot.current = { current, title, episodes, visible, paused, seek, loading, resolving, error, panel, position, duration, nextUp };
  const recorded = useRef('');
  const propsRef = useRef(props); propsRef.current = props;

  const interact = () => { lastInteraction.current = Date.now(); };
  const save = () => {
    const media = video.current, state = snapshot.current;
    const savedPosition = media?.currentTime ?? state.position, savedDuration = media?.duration ?? state.duration;
    if (!started.current || !Number.isFinite(savedPosition)) return;
    saveProgress({ title: state.title, voice: state.current.voice, episode: state.current.episode, position: savedPosition,
      duration: Number.isFinite(savedDuration) ? savedDuration : 0, updatedAt: Date.now() });
    lastSaved.current = Date.now();
  };
  const close = () => { save(); alive.current = false; request.current++; video.current?.pause(); onClose(); };
  // Once an episode really plays, the account learns which one, so «Досмотреть» follows what is watched here.
  // The exact position is not sent: it stays on this device. One attempt per episode, never repeated by itself.
  const recordWatching = () => {
    const { voice, episode } = snapshot.current.current;
    const key = JSON.stringify([voice.id, episode?.season ?? null, episode?.id ?? null]);
    if (!propsRef.current.authenticated || isDemoTitle(title) || recorded.current === key) return;
    recorded.current = key;
    void saveContinue(title, voice, episode).then(() => writeAccountMark(title.url, { voice: voice.id, season: episode?.season, episode: episode?.id })).catch(() => { /* «Досмотреть» keeps its previous entry. */ });
  };
  const declineNext = () => { setNextUp('declined'); interact(); if (snapshot.current.visible) focusSoon('player-toggle'); };
  const show = () => {
    interact();
    if (!snapshot.current.visible) {
      setVisible(true);
      clearTimeout(revealFocus.current);
      const initiator = getCurrentFocusKey();
      revealFocus.current = window.setTimeout(() => {
        const state = snapshot.current;
        if (!alive.current || !state.visible || state.panel) return;
        const focused = container.current?.querySelector('[data-focused="true"]');
        if (getCurrentFocusKey() !== initiator && focused?.getClientRects().length) return;
        if (doesFocusableExist('player-toggle')) void setFocus('player-toggle');
      }, 0);
    }
  };
  const play = () => {
    const media = video.current;
    if (!media || snapshot.current.error || snapshot.current.resolving) return;
    setMessage(''); interact();
    void media.play().catch((reason: unknown) => {
      if (!alive.current || media !== video.current || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      setVisible(true); setLoading(false); setMessage('Нажмите «Воспроизвести», чтобы начать.'); focusSoon('player-toggle');
    });
  };
  const toggle = () => { interact(); if (video.current?.paused) play(); else video.current?.pause(); };
  const beginSeek = (delta: number) => {
    const media = video.current; interact();
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0 || snapshot.current.resolving || snapshot.current.error) return;
    setSeek(clampPosition((snapshot.current.seek ?? media.currentTime) + delta, media.duration)); setVisible(true);
  };
  const commitSeek = () => {
    const media = video.current, target = snapshot.current.seek;
    if (media && target !== null) {
      try { media.currentTime = clampPosition(target, media.duration); setPosition(media.currentTime); save(); }
      catch { setMessage('Эта позиция пока недоступна.'); }
    }
    setSeek(null); interact(); focusSoon('player-timeline');
  };
  const closePanel = () => { const opener = snapshot.current.panel; setPanel(null); interact(); if (opener) focusSoon('player-' + opener); };
  const openPanel = (name: Panel) => { setSeek(null); setPanel(name); setVisible(true); interact(); };
  const switchQuality = (value: string) => {
    save(); request.current++; setResolving(false); retryTarget.current = null;
    pendingStart.current = { position: video.current?.currentTime ?? position, play: !(video.current?.paused ?? paused), fromSaved: false };
    started.current = false; setQuality(value); setError(''); setLoading(true); setEpoch((value) => value + 1); closePanel();
  };
  const resolve = async (voice: Voice, requestedEpisode?: Episode, autoplay?: boolean) => {
    save();
    const ticket = ++request.current, old = snapshot.current;
    const initial = !old.current.playback;
    const previousPosition = video.current?.currentTime ?? old.position, shouldPlay = !(video.current?.paused ?? old.paused);
    video.current?.pause(); setResolving(true); setError(''); setMessage(''); setSeek(null); setVisible(true);
    retryTarget.current = { voice, episode: requestedEpisode }; if (old.panel) closePanel();
    try {
      let episode = requestedEpisode, choices = old.episodes;
      if ((initial || voice.id !== old.current.voice.id) && (title.isSeries ?? title.kind === 'series')) {
        // The card may have handed over the episodes of the starting voice: then there is nothing to read again.
        const known = initial && voice.id === old.current.voice.id && old.episodes.length > 0;
        choices = known ? old.episodes : propsRef.current.onLoadEpisodes ? await propsRef.current.onLoadEpisodes(voice) : choices;
        if (!alive.current || ticket !== request.current) return;
        episode = choices.find((item) => sameEpisode(item, requestedEpisode)) ?? choices[0];
        if (!episode) throw new Error('Для этой озвучки пока нет доступных серий.');
      }
      // Keep the initial episode choices usable even when obtaining its stream fails.
      if (initial) { setCurrent({ voice, episode, playback: undefined }); setEpisodes(choices); }
      retryTarget.current = { voice, episode };
      const playback = await propsRef.current.onResolve(voice, episode);
      if (!alive.current || ticket !== request.current) return;
      const unchangedEpisode = sameEpisode(old.current.episode, episode);
      pendingStart.current = initial
        ? { position: propsRef.current.resume ? getProgress(title.url, voice.id, episode) : 0, play: true, fromSaved: true }
        : { position: unchangedEpisode ? previousPosition : 0, play: autoplay ?? (unchangedEpisode ? shouldPlay : true), fromSaved: false };
      started.current = false; retryTarget.current = null;
      setCurrent({ voice, episode, playback }); setEpisodes(choices); setEpoch((value) => value + 1); setLoading(true);
      if (initial || subtitle !== null) setSubtitle(playback.subtitles.find((item) => item.label === subtitleLabel)?.url ?? (propsRef.current.subtitles ? playback.subtitles[0]?.url ?? null : null));
      if (initial && !snapshot.current.panel) focusSoon('player-toggle');
    } catch (reason) {
      if (!alive.current || ticket !== request.current) return;
      setError(reason instanceof Error ? reason.message : 'Не удалось получить поток. Повторите попытку.'); setLoading(false);
      if (!snapshot.current.panel) focusSoon('player-retry');
    } finally { if (alive.current && ticket === request.current) setResolving(false); }
  };
  const retry = () => {
    if (retryTarget.current) { const target = retryTarget.current; void resolve(target.voice, target.episode, true); return; }
    pendingStart.current = { position: video.current?.currentTime || position, play: true, fromSaved: false };
    setError(''); setLoading(true); setEpoch((value) => value + 1);
  };
  const syncTracks = () => {
    const media = video.current;
    if (!media) return;
    for (let index = 0; index < media.textTracks.length; index++) media.textTracks[index].mode = current.playback?.subtitles[index]?.url === subtitle ? 'showing' : 'disabled';
  };
  const handlers = useRef({ close, closePanel, show, play, toggle, beginSeek, commitSeek, save, declineNext });
  handlers.current = { close, closePanel, show, play, toggle, beginSeek, commitSeek, save, declineNext };
  useEffect(() => {
    setFrames([]);
    const playback = current.playback;
    if (!playback?.thumbnails) return;
    let active = true;
    // The preview is optional: without it seeking shows only the time.
    void loadSeekFrames(playback).then((next) => { if (active) setFrames(next); }).catch(() => { /* No preview for this stream. */ });
    return () => { active = false; };
  }, [current.playback?.thumbnails]);
  useEffect(() => { setNextUp('hidden'); }, [current.episode?.id, current.episode?.season, current.voice.id]);
  useEffect(() => {
    if (!nextEpisode || duration < 9 || seek !== null || resolving || error || nextUp === 'declined') return;
    // The last 20 seconds, or the last third of a very short video.
    const left = duration - position, lead = Math.min(20, duration / 3);
    if (nextUp === 'hidden' && left <= lead) {
      setNextUp('shown');
      // With the controls hidden nothing else holds focus: the offer takes it, so OK accepts.
      if (!snapshot.current.visible && !snapshot.current.panel) focusSoon('player-next-now');
    } else if (nextUp === 'shown' && left > lead + 5) setNextUp('hidden');
  }, [position, duration, nextEpisode, nextUp, seek, resolving, error]);

  useEffect(() => {
    const media = video.current;
    setNativeHls(isTelevision() || Boolean(media?.canPlayType('application/vnd.apple.mpegurl') || media?.canPlayType('application/x-mpegURL')));
    setCapabilitiesReady(true);
  }, []);
  useEffect(() => {
    if (!capabilitiesReady || !current.playback) return;
    if (!stream) {
      setLoading(false); setVisible(true);
      setError(current.playback.streams.some((item) => isHlsStream(item.url)) && !nativeHls
        ? 'Доступен только HLS. Этот браузер не воспроизводит его встроенным плеером. Проверьте воспроизведение на телевизоре.'
        : 'Для выбранной озвучки нет доступного видеопотока.');
      focusSoon('player-retry'); return;
    }
    setError(''); setMessage(''); setLoading(true); setDuration(0); setPosition(pendingStart.current.position); setSeek(null);
    video.current?.load();
  }, [stream?.url, epoch, capabilitiesReady, nativeHls]);
  useEffect(syncTracks, [subtitle, current.playback?.subtitles, epoch]);
  useEffect(() => {
    alive.current = true; focusSoon(props.playback ? 'player-toggle' : 'player-voice');
    const key = (event: KeyboardEvent) => {
      const state = snapshot.current, actions = handlers.current;
      const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (isBack(event)) {
        consume();
        if (state.panel) actions.closePanel();
        else if (state.seek !== null) { setSeek(null); focusSoon('player-timeline'); }
        else if (state.nextUp === 'shown' && getCurrentFocusKey().startsWith('player-next-')) actions.declineNext();
        else if (state.visible && !state.error) setVisible(false);
        else actions.close();
        return;
      }
      if (state.panel) {
        if (event.key === 'Tab') {
          consume(); const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="player-panel"] button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }
        return;
      }
      if (event.keyCode === 415 || event.key === 'MediaPlay') { consume(); actions.play(); return; }
      if (event.keyCode === 19 || event.key === 'MediaPause') { consume(); video.current?.pause(); return; }
      if (event.key === 'MediaPlayPause' || event.code === 'Space') { consume(); actions.toggle(); return; }
      // The offer of the next episode keeps its own keys even while the controls are hidden.
      if (state.nextUp === 'shown' && !state.visible && state.seek === null && getCurrentFocusKey().startsWith('player-next-') && ['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) { lastInteraction.current = Date.now(); return; }
      if (state.seek !== null && ['ArrowLeft', 'ArrowRight', 'Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        consume(); if (event.key === 'Enter') actions.commitSeek();
        else if (event.key === 'ArrowLeft') actions.beginSeek(-10); else if (event.key === 'ArrowRight') actions.beginSeek(10);
      } else if (!state.visible && ['ArrowLeft', 'ArrowRight', 'Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        consume(); if (event.key === 'Enter') { actions.toggle(); actions.show(); }
        else if (event.key === 'ArrowLeft') actions.beginSeek(-10); else if (event.key === 'ArrowRight') actions.beginSeek(10); else actions.show();
      } else if (event.key.startsWith('Arrow') || event.key === 'Enter') lastInteraction.current = Date.now();
    };
    const timer = window.setInterval(() => {
      const state = snapshot.current;
      if (!state.paused && !state.loading && !state.resolving && !state.panel && state.seek === null && !state.error && Date.now() - lastInteraction.current > 4500) setVisible(false);
    }, 500);
    const hidden = () => { if (document.hidden) { handlers.current.save(); video.current?.pause(); } };
    const pagehide = () => handlers.current.save();
    window.addEventListener('keydown', key, true); window.addEventListener('pagehide', pagehide); document.addEventListener('visibilitychange', hidden);
    return () => {
      handlers.current.save(); alive.current = false; request.current++;
      clearInterval(timer); clearTimeout(revealFocus.current); window.removeEventListener('keydown', key, true); window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  useEffect(() => {
    if (!props.playback) void resolve(props.voice, props.episode, true);
  }, []);

  const blocked = Boolean(panel);
  const ratio = (time: number) => duration ? clampPosition(time, duration) / duration * 100 : 0;
  const frame = seek !== null ? frameAt(frames, seek) : undefined;
  // A frame is a region of a sprite; it is drawn at its own size and scaled to the preview width of 14rem.
  const frameScale = frame ? 14 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 20) / frame.width : 1;
  const named = current.episode && !/^серия\s*\d+$/i.test(current.episode.title.trim()) ? ` · ${current.episode.title}` : '';
  const context = current.episode ? `Сезон ${current.episode.season}, серия ${current.episode.id}${named}` : title.year ?? '';
  const mark = <Icon name="check" className="option-mark" />;
  return <FocusContext.Provider value={focusKey}><div ref={container} className="player" data-testid="player" onPointerMove={show}>
    <video key={epoch} ref={video} data-testid="video" src={stream?.url} crossOrigin={subtitle !== null ? 'anonymous' : undefined} playsInline preload="auto" aria-label={title.title}
      onLoadedMetadata={(event) => {
        const media = event.currentTarget; if (media !== video.current) return;
        const length = Number.isFinite(media.duration) ? media.duration : 0, start = pendingStart.current;
        setDuration(length); started.current = true;
        if (start.position > 0 && (!start.fromSaved || !length || start.position < length - 2)) {
          try { media.currentTime = clampPosition(start.position, length); } catch { setMessage('Сохранённая позиция пока недоступна.'); }
        }
        setPosition(media.currentTime); syncTracks(); if (start.play) play(); else { setPaused(true); setLoading(false); }
      }}
      onTimeUpdate={(event) => { if (event.currentTarget !== video.current) return; setPosition(event.currentTarget.currentTime); if (Date.now() - lastSaved.current > 5000) save(); }}
      onDurationChange={(event) => { if (event.currentTarget === video.current && Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
      onPause={(event) => { if (event.currentTarget !== video.current) return; setPaused(true); show(); save(); }}
      onPlay={(event) => { if (event.currentTarget !== video.current) return; started.current = true; setPaused(false); interact(); recordWatching(); }}
      onPlaying={(event) => { if (event.currentTarget === video.current) { setLoading(false); setMessage(''); } }}
      onWaiting={(event) => { if (event.currentTarget === video.current) setLoading(true); }}
      onCanPlay={(event) => { if (event.currentTarget === video.current) setLoading(false); }}
      onEnded={() => {
        save();
        // The next episode starts by itself unless the viewer declined it or the setting is off.
        if (nextEpisode && propsRef.current.autoNext !== false && snapshot.current.nextUp !== 'declined' && !snapshot.current.panel) { void resolve(current.voice, nextEpisode, true); return; }
        setPaused(true); setVisible(true); if (!snapshot.current.panel) focusSoon(nextEpisode ? 'player-next' : 'player-toggle');
      }}
      onError={(event) => {
        if (event.currentTarget !== video.current || !stream) return;
        setError(event.currentTarget.error?.code === 4
          ? 'Формат или кодек этого потока не поддерживается встроенным плеером. Попробуйте другое качество или озвучку.'
          : 'Не удалось воспроизвести поток. Проверьте соединение и повторите попытку.');
        setLoading(false); setVisible(true); focusSoon('player-retry');
      }}>
      {current.playback?.subtitles.map((track, index) => <track key={track.url + '-' + index} kind="subtitles" label={track.label} srcLang="und" src={track.url}
        onLoad={syncTracks} onError={() => { if (subtitle === track.url) { setSubtitle(null); setMessage('Не удалось загрузить субтитры. Нужны доступный WebVTT и разрешение сервера на загрузку.'); setVisible(true); } }} />)}
    </video>
    {(visible || panel) && <div className="player-shade">
      <div className="player-top"><div><h1>{title.title}</h1><p className="player-context">{context}</p></div></div>
      <div className="player-controls">
        {error && <div role="alert" className="player-error"><p>{error}</p><TVButton id="player-retry" className="primary" disabled={blocked || resolving} onPress={retry}><Icon name="retry" />Повторить</TVButton></div>}
        <TVButton id="player-timeline" disabled={blocked || resolving || Boolean(error)} className={`timeline ${seek !== null ? 'is-seeking' : ''}`} label={'Позиция ' + formatTime(seek ?? position) + ' из ' + formatTime(duration)}
          onPress={() => seek !== null ? commitSeek() : beginSeek(0)} onArrow={(direction) => {
            if (direction === 'left' || direction === 'right') { beginSeek(direction === 'left' ? -10 : 10); return false; } return true;
          }}>
          {seek !== null && <span className="seek-bubble" style={{ left: `${Math.min(92, Math.max(8, ratio(seek)))}%` }}>
            {frame && <span className="seek-frame" data-testid="seek-frame" style={{ width: frame.width * frameScale, height: frame.height * frameScale }}>
              <span style={{ display: 'block', width: frame.width, height: frame.height, backgroundImage: `url("${frame.image}")`, backgroundPosition: `-${frame.x}px -${frame.y}px`, backgroundRepeat: 'no-repeat', transform: `scale(${frameScale})`, transformOrigin: '0 0' }} /></span>}
            <strong>{formatTime(seek)}</strong><span className="seek-hint">OK — перейти · Назад — отмена</span>
          </span>}
          <span className="timeline-track">
            <span className="timeline-played" style={{ width: `${ratio(position)}%` }} />
            {seek !== null && <span className="timeline-target" style={{ left: `${ratio(Math.min(position, seek))}%`, width: `${Math.abs(ratio(seek) - ratio(position))}%` }} />}
            <span className="timeline-knob" style={{ left: `${ratio(seek ?? position)}%` }} />
          </span>
        </TVButton>
        <div className="timeline-time"><span>{formatTime(seek ?? position)}</span><span>{formatTime(duration)}</span></div>
        <div className="player-actions">
          <TVButton id="player-toggle" className="player-button" disabled={blocked || resolving || Boolean(error)} onPress={toggle}><Icon name={paused ? 'play' : 'pause'} />{paused ? 'Воспроизвести' : 'Пауза'}</TVButton>
          {nextEpisode && <TVButton id="player-next" className="player-button" label="Следующая серия" disabled={blocked || resolving} onPress={() => void resolve(current.voice, nextEpisode)}><Icon name="next" />Следующая</TVButton>}
          <span className="spacer" />
          {episodes.length > 0 && <TVButton id="player-episodes" className="player-button" disabled={blocked} onPress={() => openPanel('episodes')}><Icon name="episodes" />Серии</TVButton>}
          <TVButton id="player-voice" className="player-button" label={`Озвучка: ${current.voice.label}`} disabled={blocked || !title.voices.length} onPress={() => openPanel('voice')}><Icon name="voice" /><span>Озвучка: <b>{current.voice.label}</b></span></TVButton>
          <TVButton id="player-subtitles" className="player-button" label={`Субтитры: ${subtitleLabel || 'выключены'}`} disabled={blocked || !current.playback?.subtitles.length} onPress={() => openPanel('subtitles')}><Icon name="subtitles" /><span>Субтитры: <b>{subtitleLabel ? subtitleLabel.toLocaleLowerCase('ru') : 'выкл.'}</b></span></TVButton>
          <TVButton id="player-quality" className="player-button" label={`Качество: ${quality === 'auto' ? 'авто' : quality}`} disabled={blocked || !qualities.length} onPress={() => openPanel('quality')}><Icon name="quality" /><span>Качество: <b>{quality === 'auto' ? 'авто' : stream?.quality || quality}</b></span></TVButton>
        </div>
        <p className="player-note" role="status">{resolving ? 'Получаем поток…' : loading && !error ? 'Загрузка видео…' : message}</p>
      </div>
    </div>}
    {(loading || resolving) && !error && <div className="player-status" role="status" aria-label="Загрузка видео"><span>Загрузка…</span></div>}
    {paused && !visible && !panel && !loading && !resolving && !error && <div className="paused-indicator" aria-hidden="true"><Icon name="pause" /></div>}
    {nextUp === 'shown' && nextEpisode && !panel && <div className="next-up" data-testid="next-up">
      <p role="status">{props.autoNext !== false ? `Следующая серия через ${Math.max(0, Math.ceil(duration - position))} с` : 'Серия заканчивается'}</p>
      <strong>Сезон {nextEpisode.season}, серия {nextEpisode.id}</strong>
      <div className="actions">
        <TVButton id="player-next-now" className="primary" onPress={() => void resolve(current.voice, nextEpisode)}><Icon name="play" />Смотреть</TVButton>
        <TVButton id="player-next-stay" onPress={declineNext}>{props.autoNext !== false ? 'Остаться' : 'Не сейчас'}</TVButton>
      </div>
    </div>}
    {panel && <PlayerPanel name={panelNames[panel]} onClose={closePanel} initialFocus={panel === 'episodes' ? `player-episode-${Math.max(0, episodeIndex)}` : panel === 'voice' ? `player-voice-${Math.max(0, title.voices.findIndex((item) => item.id === current.voice.id))}` : panel === 'quality' ? (quality === 'auto' ? 'player-quality-auto' : `player-quality-${Math.max(0, qualities.indexOf(quality))}`) : subtitle === null ? 'player-subtitle-off' : `player-subtitle-${Math.max(0, current.playback?.subtitles.findIndex((track) => track.url === subtitle) ?? 0)}`}>
      {panel === 'quality' && <div className="sheet-options"><TVButton id="player-quality-auto" selected={quality === 'auto'} onPress={() => switchQuality('auto')}>{mark}<span>Авто</span><span className="option-note">лучшее доступное</span></TVButton>
        {qualities.map((value, index) => <TVButton key={value} id={'player-quality-' + index} selected={quality === value} onPress={() => switchQuality(value)}>{mark}<span>{value}</span></TVButton>)}</div>}
      {panel === 'voice' && <div className="sheet-options">{title.voices.map((voice, index) => <TVButton key={voice.id} id={'player-voice-' + index} selected={voice.id === current.voice.id} disabled={voice.premium && !props.authenticated}
        label={voice.label + (voice.premium ? ' · Нужен аккаунт Premium' : '')}
        onPress={() => { if (voice.id === current.voice.id && !resolving && !error) closePanel(); else void resolve(voice, current.episode); }}>{mark}<span>{voice.label}</span>{voice.premium && <span className="option-note">Нужен Premium</span>}</TVButton>)}</div>}
      {panel === 'subtitles' && <div className="sheet-options"><TVButton id="player-subtitle-off" selected={subtitle === null} onPress={() => { setSubtitle(null); closePanel(); }}>{mark}<span>Выключены</span></TVButton>
        {current.playback?.subtitles.map((track, index) => <TVButton key={track.url + '-' + index} id={'player-subtitle-' + index} selected={subtitle === track.url} onPress={() => { setSubtitle(track.url); closePanel(); }}>{mark}<span>{track.label}</span></TVButton>)}</div>}
      {panel === 'episodes' && <PlayerEpisodes episodes={episodes} current={current.episode}
        onSelect={episode => { if (sameEpisode(episode, current.episode) && !resolving && !error) closePanel(); else void resolve(current.voice, episode); }} />}
    </PlayerPanel>}
  </div></FocusContext.Provider>;
}
