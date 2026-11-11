import type { ComponentProps, ReactNode } from 'react';
import { TVButton } from './navigation';

const icons = {
  play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  quality: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4m-5-9 3 3 7-7" /></>,
  voice: <><path d="M4 10v4h4l5 4V6l-5 4Zm13-2a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
  subtitles: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M6 11h4m4 0h4M6 15h2m4 0h6" /></>,
  episodes: <><rect x="3" y="4" width="5" height="5" rx="1" /><rect x="3" y="15" width="5" height="5" rx="1" /><path d="M12 6.5h9M12 17.5h9" /></>,
  next: <><path d="m5 5 11 7-11 7Z" fill="currentColor" stroke="none" /><path d="M19 5v14" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  retry: <><path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6" /></>,
} satisfies Record<string, ReactNode>;

export default function PlayerIconButton({ icon, label, className = '', ...props }: Omit<ComponentProps<typeof TVButton>, 'children' | 'label'> & { icon: keyof typeof icons; label: string }) {
  return <TVButton {...props} label={label} className={`player-icon-button ${className}`}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icons[icon]}</svg>
    <span className="player-icon-hint" aria-hidden="true">{label}</span>
  </TVButton>;
}
