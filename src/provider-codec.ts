import type { Playback, Stream, Subtitle } from '../shared/source';

/** Decodes a "#h" stream list: removes 21-character "//_//" padding segments, then decodes Base64 as UTF-8. Malformed input is returned unchanged. */
export function decodeStreamString(original: string): string {
  if (!original.startsWith('#h')) return original;
  try {
    let value = original.replaceAll('#h', '');
    for (let i = 0; i < 20 && value.includes('//_//'); i++) {
      const start = value.indexOf('//_//');
      if (start + 21 > value.length) return original;
      value = value.replaceAll(value.slice(start, start + 21), '');
    }
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch { return original; }
}

export function safeHttpUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function label(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim();
}

function mediaPreference(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.mp4$/.test(path)) return 4;
  if (/\.webm$/.test(path)) return 3;
  if (/\.mpd$/.test(path)) return -1; // No DASH player is installed.
  return 1; // Native HLS or an extensionless URL; actual codec support is runtime-dependent.
}

function entries(value: string, base: string, media: boolean): Array<{ label: string; url: string }> {
  const result: Array<{ label: string; url: string }> = [];
  for (const entry of value.split(',')) {
    const match = entry.trim().match(/^\[([^\]]+)\](.+)$/s);
    if (!match) continue;
    const name = label(match[1]);
    const choices = match[2].split(' or ').map(raw => safeHttpUrl(raw, base))
      .filter((url): url is string => Boolean(url));
    // Prefer progressive MP4; among equally suitable candidates the second "or" alternative wins.
    const ordered = choices.map((url, index) => ({ url, rank: media ? mediaPreference(url) : 1, index }))
      .filter(choice => choice.rank >= 0)
      .sort((a, b) => b.rank - a.rank || (b.index === 1 ? 1 : 0) - (a.index === 1 ? 1 : 0));
    const url = ordered[0]?.url;
    if (name && url && !result.some(item => item.label === name && item.url === url)) result.push({ label: name, url });
  }
  return result;
}

export function parseStreams(value: unknown, base: string): Stream[] {
  if (typeof value !== 'string') return [];
  return entries(decodeStreamString(value), base, true).map(item => ({ quality: item.label, url: item.url }));
}

export function parseSubtitles(value: unknown, base: string): Subtitle[] {
  if (typeof value !== 'string' || value === 'false') return [];
  return entries(value, base, false);
}

export function playbackFields(value: Record<string, unknown>, base: string): Playback {
  return {
    streams: parseStreams(value.url ?? value.streams, base),
    subtitles: parseSubtitles(value.subtitle, base),
    thumbnails: safeHttpUrl(value.thumbnails, base),
  };
}

export interface InitialPlayer {
  isSeries: boolean;
  titleId?: string;
  voiceId?: string;
  season?: string;
  episode?: string;
  data: Record<string, unknown>;
}

/** Split one call without interpreting JS. Only literal JSON arguments are used. */
function callArguments(script: string, start: number): string[] | undefined {
  const result: string[] = [];
  let begin = start, depth = 0, quote = '', escaped = false, comment = '';
  for (let i = start; i < script.length; i++) {
    const char = script[i], next = script[i + 1];
    if (comment === 'line') { if (char === '\n') comment = ''; continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (char === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth++;
    else if (char === ')' && depth === 0) { result.push(script.slice(begin, i).trim()); return result; }
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) { result.push(script.slice(begin, i).trim()); begin = i + 1; }
    if (depth < 0) return undefined;
  }
  return undefined;
}

const literalId = (value?: string): string | undefined => {
  const match = value?.match(/^(?:["'](\d+)["']|(\d+))$/);
  return match?.[1] ?? match?.[2];
};

export function parseInitialPlayer(scripts: readonly string[]): InitialPlayer | undefined {
  for (const script of scripts) {
    const calls = /\binitCDN(Movies|Series)Events\s*\(/g;
    for (const match of script.matchAll(calls)) {
      const args = callArguments(script, match.index! + match[0].length);
      if (!args) continue;
      for (const argument of args) {
        if (!argument.startsWith('{')) continue;
        try {
          const data: unknown = JSON.parse(argument);
          if (!data || typeof data !== 'object' || Array.isArray(data) || !('streams' in data || 'url' in data)) continue;
          const isSeries = match[1] === 'Series';
          return {
            isSeries, titleId: literalId(args[0]), voiceId: literalId(args[1]),
            season: isSeries ? literalId(args[2]) : undefined,
            episode: isSeries ? literalId(args[3]) : undefined,
            data: data as Record<string, unknown>,
          };
        } catch { /* Executable expressions and non-JSON object literals are not accepted. */ }
      }
    }
  }
  return undefined;
}
