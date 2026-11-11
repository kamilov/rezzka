import { useEffect, useRef, type ReactNode } from 'react';
import { doesFocusableExist, FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { isBack, TVButton, useTVFocusEnabled } from './navigation';

/**
 * A panel on the right edge for a choice or for reading. Focus stays inside it,
 * Back or a press on the dimmed page closes it; the opener restores its own focus.
 */
export default function Sheet({ id, title, note, wide = false, initialFocus, hidden = false, onClose, children }: {
  id: string; title: string; note?: string; wide?: boolean; initialFocus?: string; onClose: () => void; children: ReactNode;
  /** Keeps the content mounted while the sheet is closed, so reopening does not load it again. */
  hidden?: boolean;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: `SHEET_${id}`, isFocusBoundary: true, focusBoundaryDirections: ['left', 'right', 'up', 'down'] });
  const close = useRef(onClose); close.current = onClose;
  const first = useRef(initialFocus);
  useEffect(() => {
    if (hidden) return;
    // Children have registered by now. Cancelling on close keeps a quick Back
    // from focusing a panel that has already gone.
    const timer = window.setTimeout(() => {
      if (ref.current?.querySelector('[data-focused="true"]')) return;
      const target = first.current && doesFocusableExist(first.current) ? first.current : `${id}-close`;
      if (doesFocusableExist(target)) void setFocus(target);
    }, 0);
    const key = (event: KeyboardEvent) => {
      if (isBack(event)) { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const buttons = [...(ref.current as HTMLElement | null)?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []];
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', key, true); };
  }, [id, hidden]);
  return <div className="sheet-backdrop" hidden={hidden} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className={`sheet ${wide ? 'sheet-wide' : ''}`} data-testid={`${id}-sheet`}>
        <div className="sheet-heading"><div><h2 id={`${id}-title`}>{title}</h2>{note && <p className="sheet-note">{note}</p>}</div>
          <TVButton id={`${id}-close`} className="sheet-close" onPress={onClose}>Закрыть</TVButton></div>
        <div className="sheet-body">{children}</div>
      </section>
    </FocusContext.Provider>
  </div>;
}

/** Text in a sheet that is longer than the screen: Up and Down scroll it. */
export function SheetReading({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const enabled = useTVFocusEnabled();
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: enabled,
    onArrowPress: (direction: string): boolean => {
      const body: HTMLElement | null | undefined = (ref.current as HTMLElement | null)?.closest<HTMLElement>('.sheet-body');
      if (!body || (direction !== 'up' && direction !== 'down')) return true;
      const before = body.scrollTop;
      body.scrollTop += (direction === 'down' ? 1 : -1) * Math.max(120, body.clientHeight * .6);
      // At the edge the key moves focus, so the close button above stays reachable.
      return Math.abs(body.scrollTop - before) < 1;
    },
  });
  return <div ref={ref} role="region" aria-label={label} tabIndex={enabled ? 0 : -1} data-testid={id} data-focused={focused || undefined}
    className={`sheet-reading ${focused ? 'is-focused' : ''}`} onFocus={(event) => { if (event.target === event.currentTarget && enabled) focusSelf(); }}
    onClick={() => { if (enabled) focusSelf(); }}>{children}</div>;
}
