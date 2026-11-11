import { useEffect, useRef, useState } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { getKinopoiskStatus, setKinopoiskKey } from './platform';
import { TVButton, TVField } from './navigation';

type Status = Awaited<ReturnType<typeof getKinopoiskStatus>>;
type Busy = 'status' | 'save' | 'remove' | undefined;
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';

export default function KinopoiskSettings() {
  const [status, setStatus] = useState<Status>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true), pending = useRef(false), focusTimer = useRef<number | undefined>(undefined);

  const loadStatus = async (initiator?: string) => {
    if (pending.current) return;
    pending.current = true; setBusy('status'); setError('');
    try {
      const next = await getKinopoiskStatus();
      if (alive.current) {
        setStatus(next);
        if (initiator) focusTimer.current = window.setTimeout(() => {
          if (alive.current && !pending.current && getCurrentFocusKey() === initiator) void setFocus('kinopoisk-key');
        }, 40);
      }
    } catch (reason) { if (alive.current) { setKey(''); setError(message(reason)); } }
    finally { pending.current = false; if (alive.current) setBusy(undefined); }
  };
  useEffect(() => {
    alive.current = true; void loadStatus();
    return () => { alive.current = false; window.clearTimeout(focusTimer.current); };
  }, []);

  const save = async (remove = false) => {
    if (pending.current || !status || (!remove && !key.trim())) return;
    const value = remove ? '' : key.trim(), initiator = getCurrentFocusKey();
    pending.current = true; setKey(''); setBusy(remove ? 'remove' : 'save'); setError(''); setNotice('');
    window.clearTimeout(focusTimer.current);
    try {
      const next = await setKinopoiskKey(value);
      if (alive.current) {
        setStatus(next);
        setNotice(remove ? 'Ключ удалён. Дополнительные сведения отключены.' : 'Ключ проверен и сохранён.');
      }
    } catch (reason) { if (alive.current) setError(message(reason)); }
    finally {
      pending.current = false;
      if (alive.current) {
        setBusy(undefined);
        focusTimer.current = window.setTimeout(() => {
          if (alive.current && !pending.current && getCurrentFocusKey() === initiator) void setFocus('kinopoisk-key');
        }, 40);
      }
    }
  };

  return <section className="settings-section" data-testid="settings-section-kinopoisk">
    <h2>Кинопоиск</h2>
    <p className="field-note">Личный ключ Kinopoisk API Unofficial. Сведения дополняют страницы актёров и авторов.</p>
    <p className="field-note">Получить ключ: kinopoiskapiunofficial.tech</p>
    <TVField id="kinopoisk-key" label={status?.configured ? 'Новый API-ключ' : 'API-ключ'} type="password" value={key}
      placeholder={status?.configured ? 'Введите ключ для замены' : 'Введите личный ключ'} disabled={busy === 'save' || busy === 'remove'}
      onChange={value => { setKey(value); setNotice(''); }} />
    <div className="actions settings-actions">
      <TVButton id="kinopoisk-save" className="primary" disabled={!!busy || !status || !key.trim()} onPress={() => void save()}>{busy === 'save' ? 'Проверяем ключ…' : 'Сохранить ключ'}</TVButton>
      <TVButton id="kinopoisk-remove" disabled={!!busy || !status?.configured} onPress={() => void save(true)}>{busy === 'remove' ? 'Удаляем…' : 'Удалить ключ'}</TVButton>
    </div>
    <p className="save-status" role="status" data-testid="kinopoisk-status">{busy === 'status' ? 'Проверяем настройки…' : busy === 'save' ? 'Проверяем доступ к Кинопоиску…'
      : busy === 'remove' ? 'Удаляем ключ…' : notice || (status ? status.configured ? 'Ключ сохранён на этом устройстве.' : 'Ключ не задан. Используются сведения основного источника.' : '')}</p>
    {error && <div className="inline-error" role="alert"><p>{error}</p>{!status && <TVButton id="kinopoisk-retry" disabled={!!busy} onPress={() => void loadStatus('kinopoisk-retry')}>Повторить</TVButton>}</div>}
  </section>;
}
