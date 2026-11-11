import type { Playback, SeekFrame, SourceDocument } from '../shared/source';
import { sourceRequest } from './platform';
import { safeHttpUrl } from './provider-codec';

const maxFrames = 6000;
/** WebVTT time: [hh:]mm:ss.ttt */
function seconds(value: string): number | undefined {
  const match = value.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] ?? '0').padEnd(3, '0')) / 1000;
}

/**
 * Reads the seek preview map: a WebVTT list where every cue names a sprite image
 * and the region of one frame inside it as `#xywh=x,y,width,height`.
 * Anything that is not such a map yields an empty list: the preview is optional.
 */
export function parseSeekFrames(source: SourceDocument): SeekFrame[] {
  const tokens = source.body.replace(/^\uFEFF/, '').split(/\s+/).filter(Boolean);
  if (!tokens.some(token => token.includes('WEBVTT'))) return [];
  const frames: SeekFrame[] = [];
  for (let index = 1; index < tokens.length - 2 && frames.length < maxFrames; index++) {
    if (tokens[index] !== '-->') continue;
    const start = seconds(tokens[index - 1]), end = seconds(tokens[index + 1]);
    const region = tokens[index + 2].match(/^(.+)#xywh=(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/);
    if (start === undefined || end === undefined || end <= start || !region) continue;
    const image = safeHttpUrl(region[1], source.url);
    const [x, y, width, height] = region.slice(2).map(Number);
    if (!image || !width || !height) continue;
    frames.push({ start, end, image, x, y, width, height });
  }
  return frames.sort((a, b) => a.start - b.start);
}

/** The frame shown for a position: the cue covering it, else the last one that started before it. */
export function frameAt(frames: SeekFrame[], time: number): SeekFrame | undefined {
  let low = 0, high = frames.length - 1, found: SeekFrame | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frames[middle].start <= time) { found = frames[middle]; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

export async function loadSeekFrames(playback: Playback): Promise<SeekFrame[]> {
  if (!playback.thumbnails) return [];
  // Read while a video plays: a failure only leaves the preview out and never asks to sign in.
  return parseSeekFrames(await sourceRequest({ operation: 'thumbnails', url: playback.thumbnails }));
}
