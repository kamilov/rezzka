import { describe, expect, it } from 'vitest';
import { clampPosition, formatTime, nativeStreams, selectStream } from '../../src/player-utils';

const mp4 = { quality: '720p', url: 'https://video.example/720.mp4?token=example' };
const hls = { quality: '1080p', url: 'https://video.example/1080.m3u8?token=example' };
describe('native media selection', () => {
  it('does not offer HLS when the platform cannot play it', () => {
    expect(selectStream([hls], 'auto', false)).toBeUndefined();
    expect(selectStream([hls, mp4], '1080p', false)).toEqual(mp4);
    expect(nativeStreams([hls, mp4, mp4], false)).toEqual([mp4]);
  });
  it('prefers progressive video automatically, but honors a supported manual quality', () => {
    expect(selectStream([hls, mp4], 'auto', true)).toEqual(mp4);
    expect(selectStream([hls, mp4], '1080p', true)).toEqual(hls);
  });
  it('chooses a fallback no higher than the preference when available', () => {
    const high = { quality: '2160p', url: 'https://video.example/2160.mp4' };
    expect(selectStream([high, mp4], '1080p', false)).toEqual(mp4);
    expect(selectStream([mp4, high], 'auto', false)).toEqual(high);
  });
  it('handles long films, unknown duration and invalid seek values', () => {
    expect(formatTime(3661)).toBe('1:01:01'); expect(formatTime(Number.NaN)).toBe('0:00');
    expect(clampPosition(200, 100)).toBe(100); expect(clampPosition(-10, 100)).toBe(0);
    expect(clampPosition(25, Number.POSITIVE_INFINITY)).toBe(25);
    expect(clampPosition(Number.NaN, 100)).toBe(0);
  });
});
