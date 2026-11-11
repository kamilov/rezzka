import type { SourceDocument } from './source';
import type { SourceSession } from './auth';
import type { KinopoiskResult, KinopoiskStatus } from './kinopoisk';

export interface Settings {
  mirrorUrl: string;
  preferredQuality: 'auto' | '1080p' | '720p';
  preferredVoice: string;
  subtitles: boolean;
  resumePlayback: boolean;
  /** Start the next episode by itself when the current one ends. */
  autoNext: boolean;
}

export interface SettingsEnvelope {
  revision: number;
  values: Settings;
}

export interface SetupInfo {
  urls: string[];
  pin: string;
  expiresAt: number;
}

export type ServiceResponse =
  | { returnValue: true; settings?: SettingsEnvelope; setup?: SetupInfo; source?: SourceDocument; session?: SourceSession; kinopoiskStatus?: KinopoiskStatus; kinopoisk?: KinopoiskResult }
  | { returnValue: false; errorText: string; errorCode?: string };

export const defaultSettings: Readonly<Settings> = Object.freeze({
  mirrorUrl: '',
  preferredQuality: 'auto',
  preferredVoice: '',
  subtitles: false,
  resumePlayback: true,
  autoNext: true,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Settings saved by an earlier version lack the fields added later. Fill only those
 * known fields with their defaults; unknown fields still fail validation.
 */
export function upgradeStoredSettings(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const missing = Object.entries(defaultSettings).filter(([key]) => !Object.prototype.hasOwnProperty.call(input, key));
  return missing.length ? { ...input, ...Object.fromEntries(missing) } : input;
}

export function validateSettings(input: unknown): Settings {
  if (!isRecord(input)) throw new Error('Настройки должны быть объектом.');
  const keys = Object.keys(defaultSettings);
  if (Object.keys(input).length !== keys.length ||
      Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error('Набор полей настроек не соответствует формату.');
  }
  if (typeof input.mirrorUrl !== 'string' || input.mirrorUrl.length > 2048) {
    throw new Error('Укажите адрес зеркала HTTP или HTTPS.');
  }
  let mirrorUrl = '';
  if (input.mirrorUrl.trim()) {
    let mirror: URL;
    try { mirror = new URL(input.mirrorUrl.trim()); }
    catch { throw new Error('Некорректный адрес зеркала.'); }
    if (!['http:', 'https:'].includes(mirror.protocol) || !mirror.hostname ||
        mirror.username || mirror.password || mirror.search || mirror.hash) {
      throw new Error('Адрес зеркала должен использовать HTTP(S), без логина, пароля, query и fragment.');
    }
    mirrorUrl = mirror.href.replace(/\/$/, '');
  }
  if (typeof input.preferredQuality !== 'string' ||
      !['auto', '1080p', '720p'].includes(input.preferredQuality)) {
    throw new Error('Неизвестное качество видео.');
  }
  if (typeof input.preferredVoice !== 'string' || input.preferredVoice.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(input.preferredVoice) ||
      typeof input.subtitles !== 'boolean' || typeof input.resumePlayback !== 'boolean' ||
      typeof input.autoNext !== 'boolean') {
    throw new Error('Некорректные значения настроек.');
  }
  return {
    mirrorUrl,
    preferredQuality: input.preferredQuality as Settings['preferredQuality'],
    preferredVoice: input.preferredVoice.trim(),
    subtitles: input.subtitles,
    resumePlayback: input.resumePlayback,
    autoNext: input.autoNext,
  };
}
