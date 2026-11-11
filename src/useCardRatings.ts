import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TitleRating, TitleSummary } from '../shared/source';
import { getProviderGeneration } from './provider';
import { loadCardBrief, type CardBrief } from './provider-ratings';

type Subscriber = { visible: () => boolean; receive: (ratings: TitleRating[]) => void };
type Entry = {
  key: string; generation: number; title: TitleSummary; subscribers: Set<Subscriber>;
  status: 'queued' | 'pending' | 'done' | 'failed'; ratings?: TitleRating[];
};
const cache = new Map<string, Entry>();
// One read of the short card per title serves both the poster badge and the description under focus.
const briefs = new Map<string, Promise<CardBrief>>();
let queue: Entry[] = [], active = 0, cacheGeneration = -1;

function syncGeneration(): number {
  const generation = getProviderGeneration();
  if (generation !== cacheGeneration) {
    for (const entry of cache.values()) entry.subscribers.clear();
    cache.clear(); briefs.clear(); queue = []; cacheGeneration = generation;
  }
  return generation;
}

/** The source's short card for a title; a failed read is remembered for the session and not repeated. */
export function cardBrief(title: TitleSummary): Promise<CardBrief> {
  const key = JSON.stringify([syncGeneration(), title.url]);
  let pending = briefs.get(key);
  if (!pending) {
    pending = loadCardBrief(title); briefs.set(key, pending);
    pending.catch(() => { /* Each caller handles the rejection of its own copy. */ });
    if (briefs.size > 400) briefs.delete(briefs.keys().next().value!);
  }
  return pending;
}

function visibleCard(element: HTMLElement): boolean {
  if (!element.isConnected || !element.getClientRects().length) return false;
  const bounds = element.getBoundingClientRect();
  let left = Math.max(0, bounds.left), right = Math.min(window.innerWidth, bounds.right);
  let top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
  // Recheck clipping when the queue starts: its IntersectionObserver notification
  // may still describe the frame before the user scrolled or left this screen.
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    if (node !== element) {
      const rect = node.getBoundingClientRect();
      if (/(?:auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
      if (/(?:auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    if (right <= left || bottom <= top) return false;
  }
  return true;
}

function pump() {
  const generation = syncGeneration();
  while (active < 2 && queue.length) {
    const entry = queue.shift()!;
    if (entry.generation !== generation || cache.get(entry.key) !== entry) continue;
    for (const subscriber of entry.subscribers) if (!subscriber.visible()) entry.subscribers.delete(subscriber);
    if (!entry.subscribers.size) { cache.delete(entry.key); continue; }
    entry.status = 'pending'; active++;
    void cardBrief(entry.title).then(({ ratings }) => {
      if (entry.generation !== getProviderGeneration() || cache.get(entry.key) !== entry) return;
      entry.status = 'done'; entry.ratings = ratings;
      for (const subscriber of entry.subscribers) if (subscriber.visible()) subscriber.receive(ratings);
    }).catch(() => {
      // A failed optional badge must not fail the catalog or retry on each scroll.
      // Authentication errors have already passed through sourceData's observer.
      if (entry.generation === getProviderGeneration() && cache.get(entry.key) === entry) entry.status = 'failed';
    }).finally(() => { entry.subscribers.clear(); active--; pump(); });
  }
}

function unsubscribe(entry: Entry | undefined, subscriber: Subscriber) {
  if (!entry) return;
  entry.subscribers.delete(subscriber);
  if (entry.status === 'queued' && !entry.subscribers.size) {
    if (cache.get(entry.key) === entry) cache.delete(entry.key);
    queue = queue.filter(item => item !== entry);
  }
}

export function useCardRatings(title: TitleSummary, ref: RefObject<HTMLDivElement | null>, enabled: boolean): TitleRating[] | undefined {
  const generation = getProviderGeneration();
  const [loaded, setLoaded] = useState<{ generation: number; url: string; ratings: TitleRating[] }>();
  const latest = useRef({ title, enabled }); latest.current = { title, enabled };
  useEffect(() => {
    const element = ref.current;
    if (!enabled || title.ratings !== undefined || title.rating || !element || typeof IntersectionObserver === 'undefined') return;
    const current = syncGeneration(), key = JSON.stringify([current, title.url]);
    let alive = true, intersecting = false, subscription: Entry | undefined;
    const subscriber: Subscriber = {
      visible: () => alive && intersecting && latest.current.enabled && latest.current.title.url === title.url && current === getProviderGeneration() && visibleCard(element),
      receive: ratings => { if (alive && current === getProviderGeneration() && latest.current.title.url === title.url) setLoaded({ generation: current, url: title.url, ratings }); },
    };
    const observer = new IntersectionObserver(entries => {
      const observation = entries.find(entry => entry.target === element);
      if (!observation) return;
      intersecting = observation.isIntersecting && observation.intersectionRect.width > 0 && observation.intersectionRect.height > 0;
      if (!subscriber.visible()) { unsubscribe(subscription, subscriber); subscription = undefined; return; }
      syncGeneration();
      if (current !== getProviderGeneration()) return;
      let entry = cache.get(key);
      if (entry?.status === 'done') { subscriber.receive(entry.ratings!); return; }
      if (entry?.status === 'failed') return;
      if (!entry) {
        entry = { key, generation: current, title: latest.current.title, subscribers: new Set(), status: 'queued' };
        cache.set(key, entry); queue.push(entry);
      }
      entry.subscribers.add(subscriber); subscription = entry; pump();
    }, { root: null, rootMargin: '0px', threshold: 0 });
    observer.observe(element);
    return () => { alive = false; observer.disconnect(); unsubscribe(subscription, subscriber); };
  }, [title.url, title.id, title.ratings, title.rating, ref, enabled, generation]);
  if (title.ratings !== undefined) return title.ratings;
  if (title.rating) return undefined;
  return loaded?.generation === generation && loaded.url === title.url ? loaded.ratings : undefined;
}

/**
 * The short card of the title under focus. It is requested only after the focus
 * has rested on the title, so moving along a row asks the source for nothing.
 */
export function useCardBrief(title: TitleSummary | undefined, enabled = true): CardBrief | undefined {
  const [loaded, setLoaded] = useState<{ url: string; brief: CardBrief }>();
  const url = title?.url;
  useEffect(() => {
    if (!title || !enabled) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void cardBrief(title).then(brief => { if (alive) setLoaded({ url: title.url, brief }); }).catch(() => { /* The description is optional. */ });
    }, 500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [url, enabled]);
  return loaded && loaded.url === url ? loaded.brief : undefined;
}
