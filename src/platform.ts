import type { Settings, SettingsEnvelope } from '../shared/settings';
import type { SourceDocument, SourceRequest } from '../shared/source';
import type { SourceCredentials, SourceSession } from '../shared/auth';
import type { KinopoiskPersonQuery, KinopoiskResult, KinopoiskStatus } from '../shared/kinopoisk';

export interface SetupInfo { urls: string[]; pin: string; expiresAt: number }
interface Reply {
  returnValue: boolean; settings?: SettingsEnvelope; setup?: SetupInfo; source?: SourceDocument; session?: SourceSession;
  kinopoiskStatus?: KinopoiskStatus; kinopoisk?: KinopoiskResult;
  errorText?: string; errorCode?: string | number;
}
interface Bridge { onservicecallback: (message: string) => void; call(uri: string, payload: string): void; cancel(): void }
type BridgeConstructor = new () => Bridge;
type TelevisionWindow = Window & {
  PalmServiceBridge?: BridgeConstructor;
  WebOSServiceBridge?: BridgeConstructor;
  WebOSSystem?: unknown;
  PalmSystem?: unknown;
};
const BridgeClass = (): BridgeConstructor | undefined => {
  const system = window as TelevisionWindow;
  if (typeof system.PalmServiceBridge === 'function') return system.PalmServiceBridge;
  if (typeof system.WebOSServiceBridge === 'function') return system.WebOSServiceBridge;
  return undefined;
};
export const isTelevision = () => {
  const system = window as TelevisionWindow;
  return Boolean(BridgeClass()) || system.WebOSSystem != null || system.PalmSystem != null || /web[o0]s|netcast/i.test(system.navigator?.userAgent || '');
};
export class ServiceError extends Error {
  constructor(public readonly code: string | number | undefined, message: string) { super(message); this.name = 'ServiceError'; }
}
function checked(reply: Reply): Reply {
  if (!reply.returnValue) throw new ServiceError(reply.errorCode, reply.errorText || 'Сервис не смог выполнить запрос.');
  return reply;
}
async function request(method: string, params: object = {}): Promise<Reply> {
  const sourceMethod = method === 'getSource' || method === 'sourceLogin';
  const kinopoiskMethod = method === 'getKinopoiskPerson' || method === 'setKinopoiskKey';
  const timeoutMs = sourceMethod || kinopoiskMethod ? 20000 : 10000;
  const timeoutText = kinopoiskMethod ? 'Кинопоиск не ответил. Попробуйте ещё раз.' : sourceMethod
    ? 'Не удалось дождаться источника. Проверьте зеркало и подключение.'
    : 'Телевизор не ответил. Попробуйте ещё раз.';
  const NativeBridge = BridgeClass();
  if (NativeBridge) {
    return new Promise((resolve, reject) => {
      const bridge = new NativeBridge();
      const timeout = window.setTimeout(() => { bridge.cancel(); reject(new Error(timeoutText)); }, timeoutMs);
      bridge.onservicecallback = (message) => {
        clearTimeout(timeout);
        try { resolve(checked(JSON.parse(message) as Reply)); } catch (error) { reject(error); }
      };
      try { bridge.call(`luna://ru.kamilov.rezzka.service/${method}`, JSON.stringify(params)); }
      catch (error) { clearTimeout(timeout); reject(error); }
    });
  }
  if (isTelevision()) throw new Error('Системный сервис webOS недоступен: не найден PalmServiceBridge. Перезапустите приложение на телевизоре.');
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}__bridge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: abort.signal,
    });
    if (!response.ok) {
      const reply = await response.json().catch(() => null) as Reply | null;
      throw new ServiceError(reply?.errorCode, reply?.errorText || 'Сервис настроек недоступен. Проверьте, запущен ли он.');
    }
    return checked(await response.json() as Reply);
  } catch (cause) {
    if (abort.signal.aborted) throw new Error(timeoutText);
    throw cause;
  } finally { clearTimeout(timeout); }
}
export async function sourceRequest(query: SourceRequest): Promise<SourceDocument> {
  const reply = await request('getSource', query);
  if (!reply.source || typeof reply.source.body !== 'string' || typeof reply.source.url !== 'string') {
    throw new Error('Сервис не вернул документ источника.');
  }
  return reply.source;
}
function kinopoiskStatusReply(reply: Reply): KinopoiskStatus {
  if (!reply.kinopoiskStatus || typeof reply.kinopoiskStatus.configured !== 'boolean' || !Number.isSafeInteger(reply.kinopoiskStatus.revision)) throw new Error('Сервис не вернул состояние Кинопоиска.');
  return reply.kinopoiskStatus;
}
export async function getKinopoiskStatus(): Promise<KinopoiskStatus> { return kinopoiskStatusReply(await request('getKinopoiskStatus')); }
export async function setKinopoiskKey(apiKey: string): Promise<KinopoiskStatus> { return kinopoiskStatusReply(await request('setKinopoiskKey', { apiKey })); }
export async function getKinopoiskPerson(query: KinopoiskPersonQuery): Promise<KinopoiskResult> {
  const reply = await request('getKinopoiskPerson', query);
  if (!reply.kinopoisk || !['disabled', 'unmatched', 'ambiguous', 'matched'].includes(reply.kinopoisk.status) || (reply.kinopoisk.status === 'matched' && !reply.kinopoisk.person)) throw new Error('Сервис не вернул сведения Кинопоиска.');
  return reply.kinopoisk;
}
function sessionReply(reply: Reply): SourceSession {
  if (!reply.session || typeof reply.session.authenticated !== 'boolean' || typeof reply.session.origin !== 'string') {
    throw new Error('Сервис не вернул состояние аккаунта.');
  }
  return reply.session;
}
export async function getSourceSession(): Promise<SourceSession> { return sessionReply(await request('getSourceSession')); }
export async function sourceLogin(credentials: SourceCredentials): Promise<SourceSession> { return sessionReply(await request('sourceLogin', credentials)); }
export async function sourceLogout(mirrorUrl: string): Promise<SourceSession> { return sessionReply(await request('sourceLogout', { mirrorUrl })); }
export async function getSettings(): Promise<SettingsEnvelope> {
  const reply = await request('getSettings');
  if (!reply.settings) throw new Error('Сервис не вернул настройки.');
  return reply.settings;
}
export async function saveSettings(expectedRevision: number, values: Settings): Promise<SettingsEnvelope> {
  const reply = await request('saveSettings', { expectedRevision, values });
  if (!reply.settings) throw new Error('Сервис не подтвердил сохранение.');
  return reply.settings;
}
export function startSetup(onSettings: (settings: SettingsEnvelope) => void) {
  let bridge: Bridge | undefined;
  let stopped = false;
  let rejectPending: ((reason: Error) => void) | undefined;
  let timeout: number | undefined;
  const NativeBridge = BridgeClass();
  const result = NativeBridge ? new Promise<SetupInfo>((resolve, reject) => {
    rejectPending = reject; bridge = new NativeBridge();
    timeout = window.setTimeout(() => reject(new Error('Не удалось открыть настройку по сети.')), 10000);
    bridge.onservicecallback = (message) => {
      if (stopped) return;
      try {
        const reply = checked(JSON.parse(message) as Reply);
        if (reply.settings) onSettings(reply.settings);
        if (reply.setup) { clearTimeout(timeout); resolve(reply.setup); }
      } catch (error) { clearTimeout(timeout); reject(error); }
    };
    try { bridge.call('luna://ru.kamilov.rezzka.service/startSetup', JSON.stringify({ subscribe: true })); }
    catch (error) { clearTimeout(timeout); reject(error); }
  }) : request('startSetup').then((reply) => {
    if (stopped) { void request('stopSetup').catch(() => {}); throw new Error('Настройка закрыта.'); }
    if (!reply.setup) throw new Error('Сервис не вернул адрес настройки.');
    return reply.setup;
  });
  return { result, cancel() {
    if (stopped) return;
    stopped = true; clearTimeout(timeout); bridge?.cancel(); rejectPending?.(new Error('Настройка закрыта.'));
    void request('stopSetup').catch(() => {});
  } };
}
export function leaveApp() {
  const system = window as Window & { webOS?: { platformBack?: () => void } };
  if (system.webOS?.platformBack) system.webOS.platformBack(); else if (isTelevision()) window.close();
}
