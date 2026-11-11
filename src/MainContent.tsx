import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';

// Vertical navigation stays in the page; Left remains the way to the menu.
// The page is the scroller that `reveal` aligns sections in.
export default function MainContent({ active, page, children }: { active: boolean; page: string; children: ReactNode }) {
  const { ref, focusKey } = useFocusable({
    focusKey: 'MAIN_CONTENT', focusable: active,
    isFocusBoundary: true, focusBoundaryDirections: ['up', 'down'],
  });
  const revealStart = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || event.defaultPrevented || (event.key !== 'ArrowUp' && event.keyCode !== 38)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
    const pageElement = event.currentTarget;
    const control = pageElement.querySelector<HTMLElement>(`[data-testid="${CSS.escape(getCurrentFocusKey())}"]`);
    const focused = control?.closest<HTMLElement>('.field.is-focused') ?? (control?.dataset.focused === 'true' ? control : null);
    // Dialogs keep their own focus boundaries.
    if (!focused || focused.closest('[role="dialog"]')) return;
    const box = focused.getBoundingClientRect();
    // Offscreen lines above are still navigation candidates: do not jump past
    // them just because they are outside the scroller's current viewport.
    const above = [...pageElement.querySelectorAll<HTMLElement>('button, .field, [tabindex="0"]')].filter(element => {
      if (element === focused || element.contains(focused) || focused.contains(element) ||
          element.matches(':disabled') || element.closest('[hidden], [inert], [role="dialog"]')) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility === 'visible' && bounds.bottom <= box.top + 1;
    });
    const toStart = () => { event.preventDefault(); event.stopPropagation(); pageElement.scrollTo({ top: 0, behavior: 'instant' }); };
    if (!above.length) { toStart(); return; }
    const bar = pageElement.querySelector<HTMLElement>('.topbar-tools');
    if (!bar || bar.contains(focused) || focused.closest('.topbar')) return;
    const content = above.filter(element => !bar.contains(element));
    if (!content.length) {
      // From the first line of a page Up goes to the chosen filter or tab in the top bar, not to whichever is nearest.
      const chosen = bar.querySelector<HTMLElement>('button[aria-pressed="true"]:not(:disabled)')?.dataset.testid;
      if (!chosen) return;
      toStart(); void setFocus(chosen);
      return;
    }
    // The top bar stays pinned while the page scrolls, so its filters end up right above
    // a line whose real neighbour has scrolled under the bar. That neighbour is the target.
    const pinned = above.filter(element => bar.contains(element));
    if (!pinned.length) return;
    const barBottom = Math.max(...pinned.map(element => element.getBoundingClientRect().bottom));
    const nearest = content.reduce((best, element) => element.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? element : best);
    const edge = nearest.getBoundingClientRect();
    if (edge.top >= barBottom - 1) return;
    const middle = box.left + box.width / 2;
    const offset = (element: HTMLElement) => { const bounds = element.getBoundingClientRect(); return Math.abs(bounds.left + bounds.width / 2 - middle); };
    const neighbour = content.filter(element => element.getBoundingClientRect().bottom > edge.top + 1).reduce((best, element) => offset(element) < offset(best) ? element : best);
    const key = neighbour.dataset.testid ?? neighbour.querySelector<HTMLElement>('[data-testid]')?.dataset.testid;
    if (!key) return;
    event.preventDefault(); event.stopPropagation();
    void setFocus(key);
  };
  // Cards scrolled out to the left of a row lie under the menu and would catch a
  // Left press from another line. From the first control of its line Left opens the menu.
  const toMenu = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || event.defaultPrevented || (event.key !== 'ArrowLeft' && event.keyCode !== 37)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
    const pageElement = event.currentTarget;
    const control = pageElement.querySelector<HTMLElement>(`[data-testid="${CSS.escape(getCurrentFocusKey())}"]`);
    const focused = control?.closest<HTMLElement>('.field.is-focused') ?? (control?.dataset.focused === 'true' ? control : null);
    if (!focused || focused.closest('[role="dialog"]')) return;
    const row = focused.closest<HTMLElement>('[data-row]');
    const candidates = [...(row ?? pageElement).querySelectorAll<HTMLElement>('button:not(:disabled), .field, [tabindex="0"]')];
    const box = focused.getBoundingClientRect(), view = pageElement.getBoundingClientRect();
    const first = !candidates.some(element => {
      if (element === focused || element.contains(focused) || focused.contains(element) || element.closest('[hidden], [inert], [role="dialog"]')) return false;
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || bounds.right > box.left + 1) return false;
      // Inside a row every earlier card counts; elsewhere only what is visible on the same line.
      return row ? true : bounds.right > view.left + 1 && bounds.bottom > box.top + 1 && bounds.top < box.bottom - 1;
    });
    if (!first) return;
    const menu = document.querySelector<HTMLElement>('.nav-button[aria-pressed="true"]')?.dataset.testid ?? 'nav-catalog';
    event.preventDefault(); event.stopPropagation();
    void setFocus(menu);
  };
  // A row ends at its last card: Right must not jump to whatever lies to the right in another line.
  const stopAtRowEnd = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || event.defaultPrevented || (event.key !== 'ArrowRight' && event.keyCode !== 39)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
    const control = event.currentTarget.querySelector<HTMLElement>(`[data-testid="${CSS.escape(getCurrentFocusKey())}"]`);
    const line = control?.dataset.focused === 'true' ? control.closest<HTMLElement>('[data-row], .chips, .title-actions') : null;
    if (!control || !line) return;
    const items = [...line.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
    if (items.at(-1) !== control) return;
    event.preventDefault(); event.stopPropagation();
  };
  return <FocusContext.Provider value={focusKey}>
    <main ref={ref} tabIndex={-1} className="main-content" data-scroller data-testid={`screen-${page}`} onKeyDownCapture={(event) => { revealStart(event); toMenu(event); stopAtRowEnd(event); }}
      onScroll={(event) => { event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollTop > 40); }}>{children}</main>
  </FocusContext.Provider>;
}

/** Puts a screen's own filters or tabs into the page's top bar, next to its title. */
export function TopbarTools({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('topbar-tools')); }, []);
  return slot ? createPortal(children, slot) : null;
}
