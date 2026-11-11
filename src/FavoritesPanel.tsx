import { useEffect, useRef, useState } from 'react';
import { doesFocusableExist, FocusContext, getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { FavoriteMembership, TitleSummary } from '../shared/source';
import { createFavoriteCollection, FavoriteUpdateError, loadFavoriteMembership, setFavoriteMembership } from './provider-favorites';
import { isBack, TVButton, TVField, canFocusFromPointer } from './navigation';
import './favorites-panel.css';

function CollectionCheckbox({ item, disabled, onToggle }: { item: FavoriteMembership; disabled: boolean; onToggle: () => void }) {
  const id = `favorite-membership-${item.id}`;
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: !disabled, onEnterPress: () => { if (!disabled) onToggle(); },
    onFocus: () => ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
  });
  return <button ref={ref} type="button" role="checkbox" aria-checked={item.selected} disabled={disabled} data-testid={id} data-focused={focused || undefined}
    className={`tv-button favorite-membership ${focused ? 'is-focused' : ''}`} onFocus={() => focusSelf()} onPointerEnter={() => { if (!disabled && canFocusFromPointer()) focusSelf(); }}
    onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} onClick={() => { if (!disabled) { focusSelf(); onToggle(); } }}>
    <span className="favorite-check" aria-hidden="true">{item.selected ? '✓' : ''}</span><span>{item.name}</span>
  </button>;
}

export default function FavoritesPanel({ title, onClose, onChanged }: { title: TitleSummary; onClose: () => void; onChanged: () => void }) {
  const { ref, focusKey } = useFocusable({ focusKey: 'FAVORITES_PANEL', autoRestoreFocus: false, isFocusBoundary: true, focusBoundaryDirections: ['left', 'right', 'up', 'down'] });
  const [items, setItems] = useState<FavoriteMembership[]>([]);
  const [known, setKnown] = useState(false), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false), [name, setName] = useState(''), [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false), [creationUncertain, setCreationUncertain] = useState(false);
  const inForm = useRef(false);
  const alive = useRef(true), ticket = useRef(0), reading = useRef(false), writing = useRef(false);
  const snapshot = useRef({ title, onClose, onChanged, items, known }); snapshot.current = { title, onClose, onChanged, items, known };
  const focusTimers = useRef<number[]>([]);
  const initialFocusTimer = useRef<number | undefined>(undefined);
  const focusAfter = (target: string, initiator: string, current = ticket.current) => {
    focusTimers.current.push(window.setTimeout(() => {
      const focused = getCurrentFocusKey();
      if (alive.current && current === ticket.current && (focused === initiator || !doesFocusableExist(focused))) void setFocus(target);
    }, 40));
  };
  const close = () => {
    if (writing.current) return;
    alive.current = false; ticket.current++; snapshot.current.onClose();
  };
  const closeRef = useRef(close); closeRef.current = close;
  const reload = async () => {
    if (reading.current || writing.current || !alive.current) return;
    const current = ++ticket.current, initiator = getCurrentFocusKey(); reading.current = true;
    if (initiator === 'favorite-panel-reload') window.clearTimeout(initialFocusTimer.current);
    setLoading(true); setKnown(false); setNotice('');
    try {
      const next = await loadFavoriteMembership(snapshot.current.title);
      if (alive.current && current === ticket.current) {
        setItems(next); setKnown(true); setError(''); setCreationUncertain(false);
        if (initiator === 'favorite-panel-reload') focusAfter(next[0] ? `favorite-membership-${next[0].id}` : 'favorite-create-open', initiator, current);
      }
    } catch (reason) {
      if (alive.current && current === ticket.current) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить коллекции.');
    } finally { if (alive.current && current === ticket.current) { reading.current = false; setLoading(false); } }
  };
  const toggle = async (id: string) => {
    const state = snapshot.current, item = state.items.find(value => value.id === id);
    if (!alive.current || writing.current || reading.current || inForm.current || creationUncertain || !state.known || !item) return;
    window.clearTimeout(initialFocusTimer.current);
    writing.current = true;
    const current = ++ticket.current, initiator = getCurrentFocusKey();
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await setFavoriteMembership(state.title, id, !item.selected);
      if (!alive.current || current !== ticket.current) return;
      setItems(next); setKnown(true); setNotice('Избранное обновлено.');
    } catch (reason) {
      if (!alive.current || current !== ticket.current) return;
      const latest = reason instanceof FavoriteUpdateError ? reason.memberships : undefined;
      if (latest) setItems(latest);
      setKnown(Boolean(latest));
      setError(reason instanceof Error ? reason.message : 'Не удалось изменить избранное.');
    } finally {
      if (alive.current && current === ticket.current) {
        writing.current = false; setSaving(false); snapshot.current.onChanged();
        focusTimers.current.push(window.setTimeout(() => {
          if (!alive.current || current !== ticket.current || getCurrentFocusKey() !== initiator) return;
          const target = document.querySelector<HTMLButtonElement>(`[data-testid="${initiator}"]`);
          if (!target || target.disabled) void setFocus('favorite-panel-close');
        }, 40));
      }
    }
  };
  const openCreate = () => {
    if (!known || reading.current || writing.current || creationUncertain) return;
    window.clearTimeout(initialFocusTimer.current);
    const initiator = getCurrentFocusKey();
    inForm.current = true; setFormOpen(true); setName(''); setFormError(''); setError(''); setNotice('');
    focusAfter('favorite-create-name', initiator);
  };
  const cancelCreate = () => {
    if (writing.current) return;
    const initiator = getCurrentFocusKey();
    inForm.current = false; setFormOpen(false); setName(''); setFormError('');
    focusAfter('favorite-create-open', initiator);
  };
  const cancelCreateRef = useRef(cancelCreate); cancelCreateRef.current = cancelCreate;
  const create = async () => {
    if (!alive.current || writing.current || reading.current || !inForm.current || !known || creationUncertain) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) { setFormError('Введите название от 1 до 100 символов.'); return; }
    writing.current = true;
    const current = ++ticket.current, initiator = getCurrentFocusKey();
    setSaving(true); setCreating(true); setError(''); setFormError(''); setNotice('');
    let focusTarget = 'favorite-panel-reload';
    try {
      const result = await createFavoriteCollection(snapshot.current.title, trimmed);
      if (!alive.current || current !== ticket.current) return;
      setItems(result.memberships); setKnown(true); setCreationUncertain(false); setNotice('Список создан.');
      focusTarget = `favorite-membership-${result.collectionId}`;
    } catch (reason) {
      if (!alive.current || current !== ticket.current) return;
      const failure = reason instanceof FavoriteUpdateError ? reason : undefined;
      if (failure?.memberships) setItems(failure.memberships);
      setKnown(Boolean(failure?.memberships)); setCreationUncertain(failure?.creationUncertain ?? true);
      setError(reason instanceof Error ? reason.message : 'Не удалось создать список. Проверьте состояние аккаунта.');
    } finally {
      if (alive.current && current === ticket.current) {
        writing.current = false; setSaving(false); setCreating(false);
        inForm.current = false; setFormOpen(false); setName('');
        snapshot.current.onChanged(); focusAfter(focusTarget, initiator, current);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    initialFocusTimer.current = window.setTimeout(() => {
      const root = ref.current as HTMLElement | undefined;
      if (alive.current && !inForm.current && !writing.current && !root?.contains(document.activeElement)) void setFocus('favorite-panel-close');
    }, 40);
    focusTimers.current.push(initialFocusTimer.current);
    void reload();
    const key = (event: KeyboardEvent) => {
      const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (isBack(event)) { consume(); if (inForm.current) cancelCreateRef.current(); else closeRef.current(); return; }
      if (writing.current && (event.key.startsWith('Arrow') || ['Enter', 'Tab', ' '].includes(event.key))) { consume(); return; }
      if (event.key === 'Tab') {
        consume();
        const root = ref.current as HTMLElement | undefined;
        const controls = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      alive.current = false; ticket.current++;
      focusTimers.current.forEach(timer => window.clearTimeout(timer));
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  return <div className="favorite-panel-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <FocusContext.Provider value={focusKey}><section ref={ref} className="favorite-panel" data-testid="favorite-panel" role="dialog" aria-modal="true" aria-labelledby="favorite-panel-heading" aria-busy={saving || loading}>
      <div className="sheet-heading"><h2 id="favorite-panel-heading">Избранное</h2><TVButton id="favorite-panel-close" disabled={saving} onPress={close}>Закрыть</TVButton></div>
      <p className="favorite-panel-title">{title.title}</p>
      <p className="section-note">Отметьте коллекции вашего аккаунта.</p>
      {loading && <p role="status">Загружаем коллекции…</p>}
      {saving && <p role="status">{creating ? 'Создаём список…' : 'Сохраняем изменения…'}</p>}
      {error && <div className="inline-error" role="alert"><p>{error}</p>{(!known || creationUncertain) && <p>Проверьте списки перед следующим действием.</p>}<TVButton id="favorite-panel-reload" disabled={loading || saving} onPress={() => void reload()}>{creationUncertain ? 'Проверить списки' : 'Повторить загрузку'}</TVButton></div>}
      {notice && <p role="status">{notice}</p>}
      <div className="favorite-memberships">{items.map(item => <CollectionCheckbox key={item.id} item={item} disabled={loading || saving || formOpen || creationUncertain || !known} onToggle={() => void toggle(item.id)} />)}</div>
      {known && !loading && !items.length && <p className="section-note">Пока нет списков. Создайте первый, чтобы сохранять фильмы и сериалы.</p>}
      <div className="favorite-create-actions">{formOpen ? <div className="favorite-create-form" data-testid="favorite-create-form">
        <TVField id="favorite-create-name" label="Название списка" value={name} disabled={saving} onChange={value => { setName(value); setFormError(''); }} placeholder="Например, На выходные" onDone={() => focusAfter('favorite-create-submit', getCurrentFocusKey())} />
        {(formError || name.trim().length > 100) && <p role="alert" className="favorite-create-error">{formError || 'Название должно содержать не больше 100 символов.'}</p>}
        <div className="actions"><TVButton id="favorite-create-submit" className="primary" disabled={saving || !name.trim() || name.trim().length > 100} onPress={() => void create()}>Создать</TVButton><TVButton id="favorite-create-cancel" disabled={saving} onPress={cancelCreate}>Отмена</TVButton></div>
      </div> : known && !creationUncertain && <TVButton id="favorite-create-open" disabled={loading || saving} onPress={openCreate}>Создать список</TVButton>}</div>
    </section></FocusContext.Provider>
  </div>;
}
