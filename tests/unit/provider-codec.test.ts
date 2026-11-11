import { describe, expect, it } from 'vitest';
import { decodeStreamString, parseInitialPlayer, parseStreams, parseSubtitles, safeHttpUrl } from '../../src/provider-codec';

describe('stream list decoder', () => {
  const payload = '[720p]fixture-A or fixture-B,[1080p]fixture-C';
  const encoded = btoa(payload), marker = '//_//' + 'X'.repeat(16);
  it.each([
    ['plain input', payload, payload],
    ['canonical prefix', '#h' + encoded, payload],
    ['single block', '#h' + encoded.slice(0, 8) + marker + encoded.slice(8), payload],
    ['global removal of 25 identical blocks', '#h' + marker.repeat(25) + encoded, payload],
    ['short block', '#h' + encoded + '//_//short', '#h' + encoded + '//_//short'],
    ['marker only', '#h//_//', '#h//_//'],
    ['unknown prefix', '#2' + encoded, '#2' + encoded],
    ['empty payload', '#h', ''],
    ['block consumes payload', '#h//_//' + btoa('abcdefghijklmnopqrstuvwx'), 'mnopqrstuvwx'],
  ])('%s', (_name, input, output) => expect(decodeStreamString(input)).toBe(output));

  it('preserves malformed Base64 and applies the 20-iteration cap', () => {
    const input = '#h' + Array.from({ length: 21 }, (_, i) => '//_//' + String(i).padStart(16, '0')).join('') + encoded;
    expect(decodeStreamString(input)).toBe(input);
    expect(decodeStreamString('#h%invalid%')).toBe('#h%invalid%');
    expect(decodeStreamString('#h' + Buffer.from('Озвучка', 'utf8').toString('base64'))).toBe('Озвучка');
  });
});

describe('URLs and native stream choices', () => {
  const base = 'https://mirror.example/films/10-film.html';
  it('rejects executable URLs and embedded credentials, resolves relative URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,a', 'file:///a', 'https://user:password@cdn.example/a', 'https://cdn.example/a\n']) {
      expect(safeHttpUrl(url, base)).toBeUndefined();
    }
    expect(safeHttpUrl('//cdn.example/a.mp4', base)).toBe('https://cdn.example/a.mp4');
    expect(safeHttpUrl('/poster.jpg', base)).toBe('https://mirror.example/poster.jpg');
  });
  it('prefers MP4 regardless of alternative order and skips invalid/DASH-only records', () => {
    expect(parseStreams('[1080p]https://cdn.example/a.mp4 or https://cdn.example/a.m3u8,[720p]https://cdn.example/b.m3u8 or https://cdn.example/b.mp4,[480p]javascript:alert(1),[360p]https://cdn.example/a.mpd,broken', base)).toEqual([
      { quality: '1080p', url: 'https://cdn.example/a.mp4' }, { quality: '720p', url: 'https://cdn.example/b.mp4' },
    ]);
  });
  it('prefers the second alternative among equal formats and sanitizes labels', () => {
    expect(parseStreams('[<img src=x>1080p]https://cdn.example/a.mp4 or https://cdn.example/b.mp4', base)).toEqual([{ quality: '1080p', url: 'https://cdn.example/b.mp4' }]);
    expect(parseSubtitles('[Русский]/ru.vtt,[Bad]javascript:alert(1),malformed,[English]//cdn.example/en.vtt', base)).toEqual([
      { label: 'Русский', url: 'https://mirror.example/ru.vtt' }, { label: 'English', url: 'https://cdn.example/en.vtt' },
    ]);
    expect(parseSubtitles('false', base)).toEqual([]);
  });
});

describe('inline player data without evaluating JS', () => {
  it('handles nesting, escaped quotes and delimiter text inside JSON strings', () => {
    const data = { id: 'player', streams: '[720p]https://cdn.example/a.mp4', note: '}); , " quoted', nested: { values: [1, 2] } };
    expect(parseInitialPlayer([`$(function () { sof.tv.initCDNSeriesEvents(42, '9', 2, 3, ${JSON.stringify(data)}); });`])).toEqual({
      isSeries: true, titleId: '42', voiceId: '9', season: '2', episode: '3', data,
    });
  });
  it('does not evaluate object expressions or callable arguments', () => {
    expect(parseInitialPlayer(['sof.tv.initCDNMoviesEvents(1, 2, {"streams": (() => { throw Error("executed"); })()});'])).toBeUndefined();
    const value = parseInitialPlayer(['sof.tv.initCDNMoviesEvents(1, stealCookie(), {"streams":"[720p]https://cdn.example/a.mp4"});']);
    expect(value?.voiceId).toBeUndefined();
    expect(value?.titleId).toBe('1');
  });
});
