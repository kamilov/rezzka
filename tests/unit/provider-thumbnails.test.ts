import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform', () => ({ sourceRequest: vi.fn() }));
const { frameAt, parseSeekFrames } = await import('../../src/provider-thumbnails');

const url = 'https://mirror.example/ajax/get_cdn_tiles/0/123/?t=1';
const map = (body: string) => parseSeekFrames({ body, url });

describe('seek preview map', () => {
  it('reads cue times, absolute, protocol-relative and relative sprite addresses with their regions', () => {
    const frames = map([
      'WEBVTT', '',
      '00:00:00.000 --> 00:00:10.000', 'https://cdn.example/tiles/1.jpg#xywh=0,0,160,90', '',
      '00:00:10.000 --> 00:00:20.000', '//cdn.example/tiles/1.jpg#xywh=160,0,160,90', '',
      '01:00:20.500 --> 01:00:30.000', 'tiles/7.jpg#xywh=320,90,160,90',
    ].join('\n'));
    expect(frames).toEqual([
      { start: 0, end: 10, image: 'https://cdn.example/tiles/1.jpg', x: 0, y: 0, width: 160, height: 90 },
      { start: 10, end: 20, image: 'https://cdn.example/tiles/1.jpg', x: 160, y: 0, width: 160, height: 90 },
      { start: 3620.5, end: 3630, image: 'https://mirror.example/ajax/get_cdn_tiles/0/123/tiles/7.jpg', x: 320, y: 90, width: 160, height: 90 },
    ]);
  });

  it('accepts a map collapsed into one line and short mm:ss times', () => {
    expect(map('WEBVTT 00:05.000 --> 00:10.000 https://cdn.example/a.jpg#xywh=0,0,100,56')).toEqual([
      { start: 5, end: 10, image: 'https://cdn.example/a.jpg', x: 0, y: 0, width: 100, height: 56 },
    ]);
  });

  it('skips cues without a region, with unsafe addresses, empty sizes or reversed times', () => {
    expect(map([
      'WEBVTT',
      '00:00:00.000 --> 00:00:05.000', 'https://cdn.example/a.jpg',
      '00:00:05.000 --> 00:00:10.000', 'javascript:alert(1)#xywh=0,0,10,10',
      '00:00:10.000 --> 00:00:15.000', 'https://cdn.example/a.jpg#xywh=0,0,0,90',
      '00:00:20.000 --> 00:00:15.000', 'https://cdn.example/a.jpg#xywh=0,0,160,90',
      'not-a-time --> 00:00:30.000', 'https://cdn.example/a.jpg#xywh=0,0,160,90',
    ].join('\n'))).toEqual([]);
  });

  it('treats a reply that is not a WebVTT map as no preview', () => {
    expect(map('<html><body>Вход</body></html>')).toEqual([]);
    expect(map('')).toEqual([]);
  });

  it('finds the frame covering a position and the last earlier frame after a gap', () => {
    const frames = map('WEBVTT\n00:00:00.000 --> 00:00:10.000\nhttps://c.example/a.jpg#xywh=0,0,10,10\n\n00:00:30.000 --> 00:00:40.000\nhttps://c.example/a.jpg#xywh=10,0,10,10');
    expect(frameAt(frames, 0)?.x).toBe(0);
    expect(frameAt(frames, 9.9)?.x).toBe(0);
    expect(frameAt(frames, 20)?.x).toBe(0);
    expect(frameAt(frames, 35)?.x).toBe(10);
    expect(frameAt(frames, 999)?.x).toBe(10);
    expect(frameAt([], 5)).toBeUndefined();
  });
});
