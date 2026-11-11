import { useEffect, useRef, useState } from 'react';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { sourceLogin } from './platform';
import { focusSoon, isBack, TVButton, TVField } from './navigation';

interface AuthScreenProps {
  mirrorUrl: string;
  clock: string;
  onSuccess: () => void;
  onChangeSource: () => void;
  onCancel?: () => void;
}

export default function AuthScreen({ mirrorUrl, clock, onSuccess, onChangeSource, onCancel }: AuthScreenProps) {
  const { ref, focusKey } = useFocusable({ focusKey: 'AUTH_SCREEN', isFocusBoundary: true });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    request.current++;
    inFlight.current = false;
    setUsername(''); setPassword(''); setRevealed(false); setBusy(false); setError('');
    focusSoon('auth-username');
    const backWhileSubmitting = (event: KeyboardEvent) => {
      if (!inFlight.current || !isBack(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', backWhileSubmitting, true);
    return () => { request.current++; window.removeEventListener('keydown', backWhileSubmitting, true); };
  }, [mirrorUrl]);

  const submit = async () => {
    if (inFlight.current) return;
    const name = username.trim();
    if (!name || !password) {
      setError(!name ? 'Введите логин или почту аккаунта.' : 'Введите пароль.');
      focusSoon(!name ? 'auth-username' : 'auth-password');
      return;
    }
    const ticket = ++request.current;
    inFlight.current = true;
    setBusy(true); setError(''); setRevealed(false);
    // The password remains only in this call until the service answers.
    // Clearing the field also keeps it out of a subsequent browser snapshot.
    const credentials = { mirrorUrl, username: name, password };
    setPassword('');
    try {
      const session = await sourceLogin(credentials);
      if (ticket !== request.current) return;
      if (!session.authenticated) throw new Error('Источник не подтвердил вход. Попробуйте ещё раз.');
      onSuccess();
    } catch (failure) {
      if (ticket !== request.current) return;
      setError(failure instanceof Error ? failure.message : 'Не удалось войти. Попробуйте ещё раз.');
      focusSoon('auth-password');
    } finally {
      credentials.password = '';
      if (ticket === request.current) { inFlight.current = false; setBusy(false); }
    }
  };

  return <FocusContext.Provider value={focusKey}>
    <main ref={ref} className="auth-screen" data-testid="screen-auth">
      <header className="auth-header">
        <img className="auth-logo" src={`${import.meta.env.BASE_URL}assets/rezzka-logo.svg`} alt="Rezzka" />
        <time>{clock}</time>
      </header>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">Ваш аккаунт</p>
        <h1 id="auth-title">{onCancel ? 'Вход в аккаунт' : 'Войдите, чтобы смотреть'}</h1>
        <p className="auth-source">{onCancel ? <>Войдите в аккаунт на источнике <span>{mirrorUrl}</span>.</> : <>Источник <span>{mirrorUrl}</span> требует авторизации.</>}</p>
        <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <TVField id="auth-username" label="Логин или почта" value={username} disabled={busy} onChange={setUsername} onDone={() => focusSoon('auth-password')} />
          <div className="auth-password-row">
            <TVField id="auth-password" label="Пароль" type={revealed ? 'text' : 'password'} value={password} disabled={busy} onChange={setPassword} onDone={() => focusSoon('auth-submit')} />
            <TVButton id="auth-show-password" disabled={busy} selected={revealed} onPress={() => setRevealed((value) => !value)}>{revealed ? 'Скрыть' : 'Показать'}</TVButton>
          </div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="auth-actions">
            <TVButton id="auth-submit" className="primary" disabled={busy} onPress={() => void submit()}>{busy ? 'Входим…' : 'Войти'}</TVButton>
            <TVButton id="auth-change-source" disabled={busy} onPress={onChangeSource}>Изменить источник</TVButton>
            {onCancel && <TVButton id="auth-cancel" disabled={busy} onPress={onCancel}>Назад</TVButton>}
          </div>
          <p className="auth-note" role="status">{busy ? 'Проверяем аккаунт на источнике…' : 'Пароль не сохраняется. После входа сохраняется только сессия для этого источника.'}</p>
        </form>
      </section>
    </main>
  </FocusContext.Provider>;
}
