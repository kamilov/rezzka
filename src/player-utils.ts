import type { Stream } from '../shared/source';

export const isHlsStream = (url: string) => /\.m3u8(?:$|[?#])/i.test(url);
export function nativeStreams(streams: Stream[], hls: boolean): Stream[] {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    if (!stream.url || seen.has(stream.url) || (!hls && isHlsStream(stream.url))) return false;
    seen.add(stream.url); return true;
  });
}
const resolution = (quality: string) => Number(quality.match(/\d{3,4}/)?.[0] || 0);
export function selectStream(streams: Stream[], quality: string, hls: boolean): Stream | undefined {
  const available = nativeStreams(streams, hls);
  const exact = quality !== 'auto' ? available.filter((stream) => stream.quality === quality) : [];
  if (exact.length) return exact.find((stream) => !isHlsStream(stream.url)) ?? exact[0];
  const progressive = available.filter((stream) => !isHlsStream(stream.url));
  const pool = progressive.length ? progressive : available;
  const sorted = [...pool].sort((a, b) => resolution(b.quality) - resolution(a.quality));
  const target = resolution(quality);
  return (target ? sorted.find((stream) => resolution(stream.quality) <= target) : undefined) ?? sorted[0];
}
export function clampPosition(position: number, duration: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position);
}
export function formatTime(value: number): string {
  const seconds = Math.floor(Number.isFinite(value) && value > 0 ? value : 0);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
