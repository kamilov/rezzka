import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  defaultSettings, isRecord, upgradeStoredSettings, validateSettings,
  type ServiceResponse, type SettingsEnvelope, type SetupInfo,
} from '../shared/settings.ts';
import { fail, HttpError, json, readJson } from './http.ts';
import { setupPage } from './setup-page.ts';

export interface RuntimeOptions {
  now?: () => number;
  setupTtlMs?: number;
  bindHost?: '0.0.0.0' | '127.0.0.1';
  onMirrorChange?: (mirrorUrl: string) => void | Promise<void>;
}

export interface Runtime {
  getSettings(): Promise<ServiceResponse>;
  saveSettings(input: unknown): Promise<ServiceResponse>;
  startSetup(): Promise<ServiceResponse>;
  stopSetup(): Promise<ServiceResponse>;
  close(): Promise<void>;
}

type Attempt = { count: number; blockedUntil: number };
type SetupSession = {
  info: SetupInfo;
  server: Server;
  hosts: Set<string>;
  tokens: Set<string>;
  attempts: Map<string, Attempt>;
  globalAttempt: Attempt;
  timer?: ReturnType<typeof setTimeout>;
};

function error(errorCode: string, errorText: string): ServiceResponse {
  return { returnValue: false, errorCode, errorText };
}

function cloneSettings(settings: SettingsEnvelope): SettingsEnvelope {
  return { revision: settings.revision, values: { ...settings.values } };
}

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function responseStatus(result: ServiceResponse): number {
  if (result.returnValue) return 200;
  if (result.errorCode === 'revision_conflict') return 409;
  if (result.errorCode === 'invalid_settings') return 400;
  return 500;
}

export async function createRuntime(dataDir: string, options: RuntimeOptions = {}): Promise<Runtime> {
  const now = options.now ?? Date.now;
  const ttl = options.setupTtlMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('Некорректный срок режима настройки.');
  const settingsPath = join(dataDir, 'settings.json');
  let current: SettingsEnvelope = { revision: 0, values: { ...defaultSettings } };
  try {
    const data: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!isRecord(data) || data.schemaVersion !== 1 ||
        !Number.isSafeInteger(data.revision) || Number(data.revision) < 0) {
      throw new Error('Invalid schema');
    }
    // A file written before a setting existed must keep working after the update.
    current = { revision: Number(data.revision), values: validateSettings(upgradeStoredSettings(data.values)) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Не удалось прочитать настройки: файл повреждён или недоступен. Данные сохранены без изменений.');
    }
  }

  let closed = false;
  let setup: SetupSession | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let setupOperations: Promise<unknown> = Promise.resolve();

  async function getSettings(): Promise<ServiceResponse> {
    if (closed) return error('service_closed', 'Сервис остановлен.');
    return { returnValue: true, settings: cloneSettings(current) };
  }

  async function persist(next: SettingsEnvelope): Promise<void> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = join(dataDir, '.settings-' + randomBytes(12).toString('hex') + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, ...next }) + '\n', 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, settingsPath);
    } finally {
      await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause;
      });
    }
  }

  function saveSettings(input: unknown): Promise<ServiceResponse> {
    const write = async (): Promise<ServiceResponse> => {
      if (closed) return error('service_closed', 'Сервис остановлен.');
      if (!isRecord(input) || Object.keys(input).length !== 2 ||
          !Object.hasOwn(input, 'expectedRevision') || !Object.hasOwn(input, 'values') ||
          !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
        return error('invalid_settings', 'Ожидаются expectedRevision и полный объект values.');
      }
      let values;
      try { values = validateSettings(input.values); }
      catch (cause) { return error('invalid_settings', (cause as Error).message); }
      if (input.expectedRevision !== current.revision) {
        return error('revision_conflict', 'Настройки уже изменились. Обновите страницу и повторите изменения.');
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) return error('storage_error', 'Исчерпан счётчик версий настроек.');
      const next = { revision: current.revision + 1, values };
      const resetSession = current.values.mirrorUrl !== values.mirrorUrl && options.onMirrorChange;
      // This is inside the shared serialized save path, including paired LAN
      // requests. Revoke the old session before accepting a different mirror.
      if (resetSession) {
        try { await resetSession(values.mirrorUrl); }
        catch { return error('source_session_error', 'Не удалось сбросить сессию источника. Настройки не изменены.'); }
      }
      if (closed) return error('service_closed', 'Сервис остановлен.');
      try { await persist(next); }
      catch { return error('storage_error', resetSession
        ? 'Не удалось сохранить настройки. Предыдущие значения сохранены; в аккаунт источника потребуется войти снова.'
        : 'Не удалось сохранить настройки. Предыдущие значения сохранены.'); }
      current = next;
      return { returnValue: true, settings: cloneSettings(current) };
    };
    const result = writes.then(write, write);
    writes = result;
    return result;
  }

  async function disposeSetup(): Promise<void> {
    const session = setup;
    if (!session) return;
    setup = undefined;
    clearTimeout(session.timer);
    session.tokens.clear();
    session.attempts.clear();
    await new Promise<void>((resolve) => {
      session.server.close(() => resolve());
      session.server.closeAllConnections();
    });
  }

  function setupOperation(work: () => Promise<ServiceResponse>): Promise<ServiceResponse> {
    const result = setupOperations.then(work, work);
    setupOperations = result;
    return result;
  }

  async function request(session: SetupSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (session !== setup || now() >= session.info.expiresAt) {
      throw new HttpError(410, 'setup_expired', 'Режим настройки завершён. Откройте его на телевизоре заново.');
    }
    const host = req.headers.host;
    if (!host || !session.hosts.has(host)) throw new HttpError(403, 'invalid_host', 'Неизвестный адрес сервера.');
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + host) {
      throw new HttpError(403, 'invalid_origin', 'Запрос с другого сайта запрещён.');
    }
    const url = new URL(req.url || '/', 'http://' + host);
    if (url.search) throw new HttpError(400, 'invalid_request', 'Параметры URL не поддерживаются.');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(setupPage);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const address = req.socket.remoteAddress || 'unknown';
      let attempt = session.attempts.get(address);
      if (!attempt) {
        if (session.attempts.size >= 128) throw new HttpError(429, 'rate_limited', 'Слишком много запросов.');
        attempt = { count: 0, blockedUntil: 0 };
        session.attempts.set(address, attempt);
      }
      const global = session.globalAttempt;
      if (attempt.blockedUntil > now() || global.blockedUntil > now()) {
        res.setHeader('Retry-After', '60');
        throw new HttpError(429, 'rate_limited', 'Слишком много попыток. Повторите через минуту.');
      }
      if (attempt.blockedUntil) { attempt.count = 0; attempt.blockedUntil = 0; }
      if (global.blockedUntil) { global.count = 0; global.blockedUntil = 0; }
      const body = await readJson(req, 1024);
      // Other requests may exhaust the PIN budget while this body is arriving.
      // Check again immediately before verification, with no intervening await.
      if (session !== setup || now() >= session.info.expiresAt) {
        throw new HttpError(410, 'setup_expired', 'Режим настройки завершён.');
      }
      if (attempt.blockedUntil > now() || global.blockedUntil > now()) {
        res.setHeader('Retry-After', '60');
        throw new HttpError(429, 'rate_limited', 'Слишком много попыток. Повторите через минуту.');
      }
      if (!isRecord(body) || Object.keys(body).length !== 1 ||
          typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin) ||
          !sameSecret(body.pin, session.info.pin)) {
        attempt.count++;
        global.count++;
        if (attempt.count >= 5) attempt.blockedUntil = now() + 60000;
        if (global.count >= 20) global.blockedUntil = now() + 60000;
        throw new HttpError(401, 'invalid_pin', 'Неверный PIN.');
      }
      if (session.tokens.size >= 8) throw new HttpError(429, 'session_limit', 'Перезапустите режим настройки на телевизоре.');
      const token = randomBytes(32).toString('hex');
      session.tokens.add(token);
      attempt.count = 0;
      json(res, 200, { returnValue: true, token, expiresAt: session.info.expiresAt });
      return;
    }
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!/^[a-f0-9]{64}$/.test(token) ||
        ![...session.tokens].some((candidate) => sameSecret(token, candidate))) {
      throw new HttpError(401, 'unauthorized', 'Введите PIN с телевизора.');
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      json(res, 200, await getSettings());
      return;
    }
    if (url.pathname === '/api/settings' && req.method === 'PATCH') {
      const body = await readJson(req);
      if (session !== setup || now() >= session.info.expiresAt) {
        throw new HttpError(410, 'setup_expired', 'Режим настройки завершён.');
      }
      if (!session.tokens.has(token)) {
        throw new HttpError(401, 'unauthorized', 'Введите PIN с телевизора.');
      }
      const result = await saveSettings(body);
      json(res, responseStatus(result), result);
      return;
    }
    if (url.pathname === '/api/session' && req.method === 'DELETE') {
      session.tokens.delete(token);
      json(res, 200, { returnValue: true });
      return;
    }
    throw new HttpError(404, 'not_found', 'Страница не найдена.');
  }

  function startSetup(): Promise<ServiceResponse> {
    return setupOperation(async () => {
      if (closed) return error('service_closed', 'Сервис остановлен.');
      if (setup && now() < setup.info.expiresAt) {
        return { returnValue: true, setup: { ...setup.info, urls: [...setup.info.urls] } };
      }
      await disposeSetup();
      const session: SetupSession = {
        info: { urls: [], pin: String(randomInt(10000)).padStart(4, '0'), expiresAt: now() + ttl },
        server: createServer((req, res) => { void request(session, req, res).catch((cause) => fail(res, cause)); }),
        hosts: new Set(), tokens: new Set(), attempts: new Map(), globalAttempt: { count: 0, blockedUntil: 0 },
      };
      session.server.requestTimeout = 10000;
      session.server.headersTimeout = 5000;
      session.server.keepAliveTimeout = 1000;
      session.server.maxConnections = 32;
      try {
        await new Promise<void>((resolve, reject) => {
          session.server.once('error', reject);
          session.server.listen(0, options.bindHost ?? '0.0.0.0', () => {
            session.server.removeListener('error', reject);
            resolve();
          });
        });
      } catch { return error('listen_failed', 'Не удалось открыть настройку по сети.'); }
      const address = session.server.address();
      if (!address || typeof address === 'string') {
        session.server.close();
        return error('listen_failed', 'Не удалось определить сетевой адрес.');
      }
      const ips = new Set<string>();
      if (options.bindHost !== '127.0.0.1') {
        for (const entries of Object.values(networkInterfaces())) {
          for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) ips.add(entry.address);
          }
        }
      }
      if (!ips.size) ips.add('127.0.0.1');
      session.info.urls = [...ips].map((ip) => 'http://' + ip + ':' + address.port + '/setup');
      for (const ip of [...ips, '127.0.0.1', 'localhost']) session.hosts.add(ip + ':' + address.port);
      setup = session;
      session.server.on('error', () => { void stopSetup(); });
      session.timer = setTimeout(() => { void stopSetup(); }, ttl);
      session.timer.unref();
      return { returnValue: true, setup: { ...session.info, urls: [...session.info.urls] } };
    });
  }

  function stopSetup(): Promise<ServiceResponse> {
    return setupOperation(async () => {
      await disposeSetup();
      return { returnValue: true };
    });
  }

  async function close(): Promise<void> {
    closed = true;
    await stopSetup();
    await writes;
  }

  return { getSettings, saveSettings, startSetup, stopSetup, close };
}
