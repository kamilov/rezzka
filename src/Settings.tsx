import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doesFocusableExist, FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { validateSettings, type Settings, type SettingsEnvelope } from '../shared/settings';
import { getSettings, saveSettings, startSetup, type SetupInfo } from './platform';
import { focusSoon, isBack, TVButton, TVField, TVFocusScope } from './navigation';
import { clearHistory, readLibrary } from './library';
import type { SourceSession } from '../shared/auth';
import KinopoiskSettings from './KinopoiskSettings';
import Sheet from './Sheet';
import Icon from './Icon';

type Section = 'source' | 'playback' | 'interface' | 'kinopoisk';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие.';
const sections: { id: Section; label: string; focus: string }[] = [
  { id: 'source', label: 'Источник и аккаунт', focus: 'settings-mirror' },
  { id: 'playback', label: 'Воспроизведение', focus: 'quality-auto' },
  { id: 'interface', label: 'Интерфейс', focus: 'settings-theme-dark' },
  { id: 'kinopoisk', label: 'Кинопоиск', focus: 'kinopoisk-key' },
];

/**
 * Settings take effect as soon as they are changed; only the mirror address,
 * which is typed, is saved by its own button. The line under the list explains
 * the setting under focus and reports the result of the last change.
 */
export default function SettingsScreen({ current, onUpdate, onLeave, theme, onTheme, session, onSignIn, onSignOut, standalone = false }: {
  current: SettingsEnvelope; onUpdate: (settings: SettingsEnvelope) => void; onLeave: () => void;
  theme: 'dark' | 'light'; onTheme: (theme: 'dark' | 'light') => void;
  session?: SourceSession; onSignIn?: () => void; onSignOut?: () => Promise<void>; standalone?: boolean;
}) {
  const [section, setSection] = useState<Section>('source');
  const [snapshot, setSnapshot] = useState(current);
  const [mirror, setMirror] = useState(current.values.mirrorUrl);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const [hint, setHint] = useState('');
  const [panel, setPanel] = useState<'voice' | 'clear' | 'signout' | null>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const dirty = mirror.trim() !== snapshot.values.mirrorUrl;
  const accept = useCallback((next: SettingsEnvelope) => {
    setSnapshot(next); setMirror(next.values.mirrorUrl); onUpdate(next); setLoaded(true);
  }, [onUpdate]);
  const reload = useCallback(async () => {
    setBusy(true);
    try { accept(await getSettings()); } catch (failure) { setStatus({ text: errorMessage(failure), error: true }); }
    finally { setBusy(false); }
  }, [accept]);
  useEffect(() => { void reload(); }, [reload]);
  const apply = async (change: Partial<Settings>) => {
    if (busy) return;
    setBusy(true); setStatus(undefined);
    try {
      accept(await saveSettings(snapshotRef.current.revision, validateSettings({ ...snapshotRef.current.values, ...change })));
      setStatus({ text: 'Сохранено.' });
    } catch (failure) {
      // Another device may have changed the settings meanwhile: show what is stored now.
      const conflict = failure instanceof Error && 'code' in failure && failure.code === 'revision_conflict';
      if (conflict) { try { accept(await getSettings()); } catch { /* The message below still tells what happened. */ } }
      setStatus({ text: conflict ? 'Настройки изменились на другом устройстве. Показаны актуальные значения — повторите изменение.' : errorMessage(failure), error: true });
    } finally { setBusy(false); }
  };
  const closeNetwork = useCallback(() => {
    setNetworkOpen(false); focusSoon('settings-network');
    void getSettings().then(accept).catch((failure) => setStatus({ text: errorMessage(failure), error: true }));
  }, [accept]);
  const closePanel = (opener: string) => { setPanel(null); focusSoon(opener); };
  const explain = (text: string) => () => { setHint(text); };
  // Voices the viewer has already watched with: choosing one needs no typing.
  const voices = useMemo(() => [...new Set(readLibrary().history.map((item) => item.voice.label).filter(Boolean))].slice(0, 30), [panel]);
  // «Как в прошлый раз» first, then the chosen voice and the ones watched with.
  const voiceOptions = ['', ...new Set([...(snapshot.values.preferredVoice ? [snapshot.values.preferredVoice] : []), ...voices])];
  const toggle = (id: string, key: 'subtitles' | 'resumePlayback' | 'autoNext', label: string, text: string) =>
    <TVButton id={id} className="setting-row" selected={snapshot.values[key]} disabled={!loaded} onFocused={explain(text)} onPress={() => void apply({ [key]: !snapshot.values[key] })}>
      <span>{label}</span><span className="setting-value"><span className={`switch ${snapshot.values[key] ? 'on' : ''}`} aria-hidden="true"><i /></span></span><span className="sr-only">{snapshot.values[key] ? 'Включено' : 'Выключено'}</span>
    </TVButton>;
  const shown = sections.filter((item) => !standalone || item.id !== 'kinopoisk');
  return <><TVFocusScope active={!panel && !networkOpen}><section className="settings-screen">
    <div className="settings-columns">
      <nav className="settings-menu" aria-label="Разделы настроек">
        {shown.map((item) => <TVButton key={item.id} id={`settings-tab-${item.id}`} className="settings-menu-item" selected={section === item.id}
          // A section opens as soon as its name takes focus.
          onPress={() => setSection(item.id)} onFocused={() => { setSection(item.id); setHint(''); }} onArrow={(direction) => {
            if (direction !== 'right') return true;
            setSection(item.id); focusSoon(item.focus); return false;
          }}>{item.label}</TVButton>)}
        {standalone && <TVButton id="settings-back" className="settings-menu-item" onPress={onLeave}>Назад</TVButton>}
      </nav>
      <div className="settings-form">
        {section === 'source' && <div className="settings-section" data-testid="settings-section-source">
          <TVField id="settings-mirror" label="Адрес зеркала" inputMode="url" value={mirror} placeholder="https://…" onChange={(value) => { setMirror(value); setStatus(undefined); }} />
          <TVButton id="settings-save" className={`setting-row ${dirty ? 'primary' : ''}`} disabled={busy || !loaded || !dirty} onFocused={explain('Адрес используется для каталога, поиска и входа. Смена адреса завершает сессию аккаунта.')} onPress={() => void apply({ mirrorUrl: mirror })}>
            <span>{busy ? 'Подождите…' : 'Сохранить адрес'}</span></TVButton>
          {!standalone && snapshot.values.mirrorUrl && (session?.authenticated
            ? <TVButton id="settings-signout" className="setting-row" disabled={busy || dirty} onFocused={explain('OK — выйти из аккаунта. Списки «Досмотреть» и «Избранное» останутся на сайте.')} onPress={() => setPanel('signout')}>
              <span>Аккаунт</span><span className="setting-value">{session.username || 'Вход выполнен'}</span></TVButton>
            : <TVButton id="settings-signin" className="setting-row" disabled={busy || dirty} onFocused={explain('OK — войти. Пароль не сохраняется на телевизоре.')} onPress={() => onSignIn?.()}>
              <span>Аккаунт</span><span className="setting-value">Войти</span></TVButton>)}
          <TVButton id="settings-network" className="setting-row" disabled={dirty || busy || !loaded} onFocused={explain(dirty ? 'Сначала сохраните адрес.' : 'Откроет временный доступ к настройкам с телефона или компьютера в домашней сети.')} onPress={() => setNetworkOpen(true)}>
            <span>Настроить с телефона</span><span className="setting-value"><Icon name="phone" />по коду</span></TVButton>
        </div>}
        {section === 'playback' && <div className="settings-section" data-testid="settings-section-playback">
          <div className="setting-label">Качество</div>
          <div className="chips quality-options" role="group" aria-label="Качество">
            {(['auto', '1080p', '720p'] as const).map((quality) => <TVButton key={quality} id={`quality-${quality}`} selected={snapshot.values.preferredQuality === quality} disabled={!loaded}
              onFocused={explain('«Авто» выбирает лучшее качество, которое источник отдаёт для видео.')} onPress={() => void apply({ preferredQuality: quality })}>{quality === 'auto' ? 'Авто' : quality}</TVButton>)}
          </div>
          <TVButton id="settings-voice" className="setting-row" disabled={!loaded} onFocused={explain('Если у фильма есть выбранная озвучка, она включится сама. Иначе — та, с которой вы смотрели его в прошлый раз.')} onPress={() => setPanel('voice')}>
            <span>Озвучка по умолчанию</span><span className="setting-value">{snapshot.values.preferredVoice || 'Как в прошлый раз'}</span></TVButton>
          {toggle('settings-subtitles', 'subtitles', 'Включать субтитры', 'Если у видео есть субтитры, они включатся при запуске.')}
          {toggle('settings-resume', 'resumePlayback', 'Продолжать с места остановки', 'Точная позиция хранится на этом телевизоре.')}
          {toggle('settings-autonext', 'autoNext', 'Включать следующую серию', 'Когда серия заканчивается, следующая начинается сама. За 20 секунд до конца это можно отменить.')}
          <TVButton id="settings-clear-history" className="setting-row danger" onFocused={explain('Удалит сохранённые на телевизоре позиции и недавние поисковые запросы. Список «Досмотреть» в аккаунте не изменится.')} onPress={() => setPanel('clear')}>
            <span>Очистить историю просмотра</span></TVButton>
        </div>}
        {section === 'interface' && <div className="settings-section" data-testid="settings-section-interface">
          <div className="setting-label">Тема оформления</div>
          <div className="chips theme-options" role="group" aria-label="Тема оформления">
            <TVButton id="settings-theme-dark" className="theme-option" selected={theme === 'dark'} onFocused={explain('Тёмная тема бережнее к OLED-экрану и комфортнее в затемнённой комнате. Тема меняется сразу.')} onPress={() => onTheme('dark')}>Тёмная</TVButton>
            <TVButton id="settings-theme-light" className="theme-option" selected={theme === 'light'} onFocused={explain('Тёмная тема бережнее к OLED-экрану и комфортнее в затемнённой комнате. Тема меняется сразу.')} onPress={() => onTheme('light')}>Светлая</TVButton>
          </div>
        </div>}
        {section === 'kinopoisk' && <KinopoiskSettings />}
        {section !== 'kinopoisk' && <p className={`setting-hint save-status ${status?.error ? 'error' : ''}`} role={status?.error ? 'alert' : 'status'}>{status?.text || hint}</p>}
      </div>
    </div>
  </section></TVFocusScope>
  {panel === 'voice' && <Sheet id="settings-voices" title="Озвучка по умолчанию" note="Озвучки, с которыми вы уже смотрели" onClose={() => closePanel('settings-voice')}
    initialFocus={`settings-voice-option-${Math.max(0, voiceOptions.indexOf(snapshot.values.preferredVoice))}`}>
    <div className="sheet-options">{voiceOptions.map((value, index) =>
      <TVButton key={value || 'last'} id={`settings-voice-option-${index}`} selected={snapshot.values.preferredVoice === value} onPress={() => { closePanel('settings-voice'); if (value !== snapshot.values.preferredVoice) void apply({ preferredVoice: value }); }}>
        <Icon name="check" className="option-mark" /><span>{value || 'Как в прошлый раз'}</span></TVButton>)}</div>
    {!voices.length && <p className="sheet-note">Список пополнится озвучками, с которыми вы посмотрите фильмы на этом телевизоре.</p>}
  </Sheet>}
  {(panel === 'clear' || panel === 'signout') && <Confirm id={`settings-confirm-${panel}`}
    title={panel === 'clear' ? 'Очистить историю просмотра?' : `Выйти из аккаунта${session?.username ? ` ${session.username}` : ''}?`}
    text={panel === 'clear' ? 'Позиции просмотра и недавние запросы на этом телевизоре будут удалены. Отменить это нельзя.' : 'Сохранённая на телевизоре сессия будет удалена.'}
    action={panel === 'clear' ? 'Очистить' : 'Выйти'} onCancel={() => closePanel(panel === 'clear' ? 'settings-clear-history' : 'settings-signout')}
    onConfirm={() => {
      if (panel === 'clear') {
        try { clearHistory(); setStatus({ text: 'История просмотра очищена.' }); } catch (failure) { setStatus({ text: errorMessage(failure), error: true }); }
        closePanel('settings-clear-history'); return;
      }
      setPanel(null); setBusy(true);
      void onSignOut?.().catch((failure) => { setStatus({ text: errorMessage(failure), error: true }); focusSoon('settings-signout'); }).finally(() => setBusy(false));
    }} />}
  {networkOpen && <NetworkSetup onClose={closeNetwork} onUpdate={accept} />}
  </>;
}

/** Asks before an action that cannot be undone; focus starts on the safe answer. */
function Confirm({ id, title, text, action, onConfirm, onCancel }: { id: string; title: string; text: string; action: string; onConfirm: () => void; onCancel: () => void }) {
  const { ref, focusKey } = useFocusable({ focusKey: id.toUpperCase(), isFocusBoundary: true });
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const timer = window.setTimeout(() => { if (doesFocusableExist(`${id}-cancel`)) void setFocus(`${id}-cancel`); }, 0);
    const key = (event: KeyboardEvent) => {
      if (isBack(event)) { event.preventDefault(); event.stopImmediatePropagation(); cancel.current(); }
      else if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', key, true); };
  }, [id]);
  return <div className="modal-backdrop"><FocusContext.Provider value={focusKey}><section ref={ref} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid={id}>
    <h2 id={`${id}-title`}>{title}</h2><p>{text}</p>
    <div className="actions"><TVButton id={`${id}-ok`} className="primary" onPress={onConfirm}>{action}</TVButton><TVButton id={`${id}-cancel`} onPress={onCancel}>Отмена</TVButton></div>
  </section></FocusContext.Provider></div>;
}

function NetworkSetup({ onClose, onUpdate }: { onClose: () => void; onUpdate: (settings: SettingsEnvelope) => void }) {
  const { ref, focusKey } = useFocusable({ focusKey: 'network-modal', isFocusBoundary: true, trackChildren: true });
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(0);
  const onUpdateRef = useRef(onUpdate); onUpdateRef.current = onUpdate;
  useEffect(() => {
    let active = true;
    let polling = false;
    let expiresAt = 0;
    const session = startSetup((next) => { if (active) onUpdateRef.current(next); });
    session.result.then((info) => { if (active) { setSetup(info); expiresAt = info.expiresAt; setRemaining(Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000))); } }).catch((failure) => {
      if (active) { setError(errorMessage(failure)); session.cancel(); }
    });
    focusSoon('network-close');
    const timer = window.setInterval(() => {
      if (expiresAt) {
        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); setRemaining(seconds);
        if (!seconds) { setError('Время доступа истекло. Закройте окно и откройте настройку снова.'); session.cancel(); expiresAt = 0; }
      }
    }, 1000);
    const poll = window.setInterval(() => {
      if (!expiresAt || polling) return;
      polling = true;
      void getSettings().then((next) => { if (active) onUpdateRef.current(next); }).catch(() => {}).finally(() => { polling = false; });
    }, 2000);
    const back = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); focusSoon('network-close'); }
      else if (isBack(event)) { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
    };
    const hidden = () => { if (document.hidden) onClose(); };
    window.addEventListener('keydown', back, true); document.addEventListener('visibilitychange', hidden);
    return () => { active = false; clearInterval(timer); clearInterval(poll); session.cancel(); window.removeEventListener('keydown', back, true); document.removeEventListener('visibilitychange', hidden); };
  }, [onClose]);
  return <div className="modal-backdrop"><FocusContext.Provider value={focusKey}><section ref={ref} className="network-modal" role="dialog" aria-modal="true" aria-labelledby="network-title" data-testid="network-modal">
    <h1 id="network-title">Настройка с телефона</h1>
    <p>Подключите телефон или компьютер к той же сети. Откройте один из адресов и введите код.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : !setup ? <p role="status" className="network-wait">Открываем временный доступ…</p> : <>
      <div className="network-addresses">{setup.urls.map((url) => <code key={url}>{url}</code>)}</div>
      <div className="pairing-code"><span>Код доступа</span><strong data-testid="network-pin">{setup.pin}</strong><small>Действует ещё {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</small></div>
    </>}
    <TVButton id="network-close" className="primary" onPress={onClose}>Закрыть доступ</TVButton>
    <p className="field-note">Настройки сохраняются сразу после подтверждения на подключённом устройстве.</p>
  </section></FocusContext.Provider></div>;
}
