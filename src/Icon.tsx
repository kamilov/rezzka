import type { ReactNode } from 'react';

const paths = {
  play: <path d="M7 4.5v15l12-7.5Z" fill="currentColor" stroke="none" />,
  pause: <path d="M7.5 5v14M16.5 5v14" strokeWidth="3" />,
  next: <><path d="M5 5v14l10-7Z" fill="currentColor" stroke="none" /><path d="M19 5v14" strokeWidth="2.4" /></>,
  episodes: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth="2.8" /></>,
  voice: <><path d="M4 5h16a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-7l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8 10.8h.01M12 10.8h.01M16 10.8h.01" strokeWidth="2.6" /></>,
  subtitles: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h4M14 15h3M7 11h2M12 11h5" /></>,
  quality: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7.5 9.5v5M7.5 12h3M10.5 9.5v5M13.8 9.5v5H15a2.5 2.5 0 0 0 0-5Z" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" strokeWidth="2.2" /></>,
  comments: <path d="M4 5h16v11H9l-5 4Z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" strokeWidth="2.4" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" strokeWidth="2.2" />,
  retry: <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5" />,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof paths;

/** One line weight for every pictogram; a control that needs explaining also carries a text label. */
export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
