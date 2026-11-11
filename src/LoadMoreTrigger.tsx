import { useEffect, useRef } from 'react';

/** Prefetch when a scrolled row/grid approaches its end; the caller owns locks. */
export function LoadMoreTrigger({ enabled, onLoad }: { enabled: boolean; onLoad: () => void }) {
  const element = useRef<HTMLSpanElement>(null);
  const callback = useRef(onLoad); callback.current = onLoad;
  useEffect(() => {
    const target = element.current;
    if (!enabled || !target || typeof IntersectionObserver === 'undefined') return;
    // Use the visible content area: a row as root would also prefetch off-screen rows.
    const root = target.closest('.main-content');
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    }, { root, rootMargin: '0px 0px 240px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);
  return <span ref={element} className="load-more-trigger" aria-hidden="true" />;
}
