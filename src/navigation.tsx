import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';

export function focusSoon(key: string) { return window.setTimeout(() => setFocus(key), 40); }

// The remote works either as a pointer or with the arrow keys. The page moves under
// a steady focus, except when the pointer itself picks a control: that control must
// stay where it is, or the next one would slide beneath the cursor and take focus in a chain.
let pointerInput = false, pointerAt: string | undefined, pointerActs = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { pointerInput = false; }, true);
  // Content that moves or appears beneath a resting pointer also reports that the
  // pointer entered or moved, and a browser reports where the pointer rests once at
  // launch. Only a change of its position is the viewer's doing.
  const track = (event: PointerEvent) => {
    const at = `${event.clientX},${event.clientY}`;
    if (at === pointerAt) return;
    if (pointerAt !== undefined) pointerInput = true;
    pointerAt = at;
  };
  // React reports «entered» while handling the pointer leaving the previous element, so that event counts too.
  for (const type of ['pointermove', 'pointerover', 'pointerout'] as const) window.addEventListener(type, track, true);
  // A press focuses the control before its click arrives: until then nothing may move from under the pointer.
  const release = () => { window.setTimeout(() => { pointerActs = Math.max(0, pointerActs - 1); }, 0); };
  window.addEventListener('pointerdown', () => { pointerActs++; }, true);
  window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', release, true);
}
/** Makes a focus change on behalf of the pointer: the page then scrolls only as far as needed to show the control. */
export function focusByPointer(focus: () => void) { pointerActs++; try { focus(); } finally { pointerActs--; } }

/**
 * Brings a focused control to its place.
 * In a row (`data-row`) the control moves to the row's start, so focus stays in
 * one spot while cards slide. A strip of tabs (`data-row="tabs"`) scrolls only as
 * far as needed and keeps part of the next tab in sight. Vertically its section (`data-anchor`) is aligned
 * in the page (`data-scroller`) below any pinned header (`data-pinned`):
 * `top` always puts the section right under the header, `start` returns to the
 * beginning of the page, anything else scrolls only as far as needed to show
 * the whole section. Cards of a grid (`data-anchor-items`) are sections themselves.
 * A section may ask to keep a gap below the pinned header (`--reveal-gap`, in rem): a focused poster
 * grows and gets a ring, and without the gap its top edge would slide under the header.
 * A control picked by the pointer is only brought into view.
 */
export function reveal(element: HTMLElement | null | undefined) {
  if (!element) return;
  const nearest = () => element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  if (pointerActs > 0) { nearest(); return; }
  const row = element.closest<HTMLElement>('[data-row]');
  if (row && row !== element) {
    const box = element.getBoundingClientRect(), frame = row.getBoundingClientRect();
    if (row.dataset.row === 'tabs') {
      const peek = box.width * .6;
      if (box.left - peek < frame.left) row.scrollLeft += box.left - peek - frame.left;
      else if (box.right + peek > frame.right) row.scrollLeft += box.right + peek - frame.right;
    } else row.scrollLeft += box.left - frame.left - (parseFloat(getComputedStyle(row).paddingLeft) || 0);
  }
  // In a grid (`data-anchor-items`) every card is aligned by itself, so the focused line of cards keeps its height.
  const grid = element.closest<HTMLElement>('[data-anchor-items]');
  const scroller = element.closest<HTMLElement>('[data-scroller]'), section = grid ? element : element.closest<HTMLElement>('[data-anchor]');
  if (!scroller || !section || !scroller.contains(section)) { nearest(); return; }
  const mode = grid ? grid.dataset.anchorItems : section.dataset.anchor;
  if (mode === 'start') { scroller.scrollTop = 0; return; }
  const view = scroller.getBoundingClientRect(), box = section.getBoundingClientRect();
  const pinned = [...scroller.querySelectorAll<HTMLElement>('[data-pinned]')].reduce((height, node) =>
    node.getClientRects().length ? Math.max(height, node.getBoundingClientRect().bottom - view.top) : height, 0);
  const gap = (parseFloat(getComputedStyle(section).getPropertyValue('--reveal-gap')) || 0) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 20);
  const above = box.top - view.top - pinned - gap, below = box.bottom - view.bottom;
  if (mode === 'top' || above < 0) scroller.scrollTop += above;
  else if (below > 0) scroller.scrollTop += Math.min(above, below + 24);
}
/** Puts a tab in the middle of its strip. For the chosen tab while focus is elsewhere: `reveal` only follows focus. */
export function centerInRow(element: HTMLElement | null | undefined) {
  const row = element?.closest<HTMLElement>('[data-row]');
  if (!element || !row) return;
  const box = element.getBoundingClientRect(), frame = row.getBoundingClientRect();
  row.scrollLeft += box.left - frame.left - (frame.width - box.width) / 2;
}
let editingInput: HTMLInputElement | null = null;
let inputFocusWork = Promise.resolve(), pendingInputFocus = 0;

// The Magic Remote pointer crosses app controls on its way to the system
// keyboard. Hover must not blur the input. A real click still changes focus.
// Do not derive this state from keyboardStateChange.visibility: webOS emits
// visibility=false while switching from the keyboard to voice input.
export function canFocusFromPointer() {
  // After a key press the pointer rests: a control sliding under it must not take focus.
  if (!pointerInput) return false;
  if (editingInput?.isConnected && !editingInput.disabled) return false;
  const active = document.activeElement;
  return !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ||
    active instanceof HTMLElement && active.isContentEditable);
}
const TVFocusEnabled = createContext(true);
export function useTVFocusEnabled() { return useContext(TVFocusEnabled); }
export function TVFocusScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useContext(TVFocusEnabled);
  return <TVFocusEnabled.Provider value={parent && active}>{children}</TVFocusEnabled.Provider>;
}
export const isBack = (event: KeyboardEvent) => event.key === 'Escape' || event.keyCode === 461 || (event.key === 'Backspace' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName));
interface ButtonProps {
  id: string; children: ReactNode; onPress: () => void; className?: string;
  label?: string; disabled?: boolean; selected?: boolean; onArrow?: (direction: string) => boolean; onFocused?: () => void;
  expanded?: boolean; controls?: string; domId?: string;
}
export function TVButton({ id, children, onPress, className = '', label, disabled = false, selected, onArrow, onFocused, expanded, controls, domId }: ButtonProps) {
  const enabled = useContext(TVFocusEnabled);
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: enabled && !disabled, onEnterPress: () => { if (enabled && !disabled) onPress(); },
    onArrowPress: (direction) => onArrow?.(direction) ?? true,
    onFocus: () => { reveal(ref.current); onFocused?.(); },
  });
  return <button ref={ref} id={domId} type="button" data-testid={id} data-focused={focused || undefined}
    className={`tv-button ${focused ? 'is-focused' : ''} ${className}`} disabled={disabled}
    aria-label={label} aria-pressed={selected} aria-expanded={expanded} aria-controls={controls} tabIndex={0}
    onFocus={() => { if (enabled && !disabled) focusSelf(); }} onPointerEnter={() => { if (enabled && !disabled && canFocusFromPointer()) focusByPointer(focusSelf); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
    onClick={() => { focusByPointer(focusSelf); onPress(); }}>{children}</button>;
}
export function TVField({ id, label, value, onChange, placeholder, inputMode = 'text', type = 'text', disabled = false, onDone }: {
  id: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string; inputMode?: 'text' | 'url';
  type?: 'text' | 'password'; disabled?: boolean; onDone?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const enabled = useContext(TVFocusEnabled);
  const [editing, setEditing] = useState(false);
  const alive = useRef(true), focusRequest = useRef(0), synchronizing = useRef(false);
  const available = useRef(enabled && !disabled); available.current = enabled && !disabled;
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: enabled && !disabled, onEnterPress: () => { if (enabled && !disabled) { setEditing(true); input.current?.focus(); } }, onArrowPress: () => !editing,
  });
  const stopEditing = () => {
    focusRequest.current++; synchronizing.current = false;
    if (editingInput === input.current) editingInput = null;
    setEditing(false);
  };
  useEffect(() => {
    if (!enabled || disabled || !focused && !synchronizing.current) { stopEditing(); input.current?.blur(); }
  }, [focused, enabled, disabled]);
  useEffect(() => {
    alive.current = true;
    const element = input.current;
    return () => {
      alive.current = false; focusRequest.current++;
      if (editingInput === element) editingInput = null;
    };
  }, []);
  return <label ref={ref} tabIndex={-1} className={`field ${focused ? 'is-focused' : ''}`} onPointerEnter={() => { if (enabled && !disabled && canFocusFromPointer()) focusByPointer(focusSelf); }}>
    <span>{label}</span>
    <input ref={input} data-testid={id} value={value} placeholder={placeholder} inputMode={inputMode} type={type} disabled={disabled}
      autoComplete="off" spellCheck={false} onChange={(event) => onChange(event.target.value)}
      onFocus={() => {
        editingInput = input.current; setEditing(true);
        if (getCurrentFocusKey() !== id || pendingInputFocus > 0 && !synchronizing.current) {
          const ticket = ++focusRequest.current; synchronizing.current = true;
          const current = () => alive.current && available.current && focusRequest.current === ticket && editingInput === input.current;
          pendingInputFocus++;
          inputFocusWork = inputFocusWork.then(async () => {
            try {
              // Serialize field synchronization so an older pointer click cannot
              // finish after the viewer has already selected another input.
              if (!current()) return;
              await setFocus(id);
              if (!current()) return;
              if (getCurrentFocusKey() === id && (document.activeElement === ref.current || document.activeElement === input.current)) {
                setEditing(true); input.current?.focus();
              } else stopEditing();
            } finally {
              pendingInputFocus--;
              if (focusRequest.current === ticket) synchronizing.current = false;
            }
          }).catch(() => {
            if (current()) stopEditing();
          });
        }
      }} onBlur={event => {
        const internalFocus = event.relatedTarget instanceof HTMLElement && event.relatedTarget.matches('.field');
        if (!(synchronizing.current && internalFocus)) stopEditing();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape' || event.keyCode === 461) {
          event.preventDefault(); event.stopPropagation(); stopEditing(); input.current?.blur(); focusSelf();
          if (event.key === 'Enter') onDone?.();
        }
        // Keep native caret/keyboard behavior and stop Norigin's window listener
        // from navigating the underlying app or preventing the default action.
        if (event.key.startsWith('Arrow')) event.stopPropagation();
      }} />
    <small style={{ visibility: focused ? 'visible' : 'hidden' }} aria-hidden={!focused}>
      {editing ? 'OK — закончить ввод' : 'OK — редактировать'}
    </small>
  </label>;
}
