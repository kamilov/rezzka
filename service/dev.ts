import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isRecord, type ServiceResponse } from '../shared/settings.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { fail, HttpError, isLoopback, json, readJson } from './http.ts';
import { createSourceTransport, getSource, getSourceSession, sourceLogin, sourceLogout } from './source.ts';
import { createKinopoisk } from './kinopoisk';
import { kinopoiskCall } from './kinopoisk-rpc';

export function createDevMiddleware(dataDir: string): {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  close(): Promise<void>;
} {
  let runtime: Promise<Runtime> | undefined;
  let closed = false;
  const source = createSourceTransport({ sessionPath: join(dataDir, 'source-session.json') });
  const kinopoisk = createKinopoisk({ storagePath: join(dataDir, 'kinopoisk-key.json') });
  async function handleBridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hosts = new Set(['localhost:5173', '127.0.0.1:5173', '[::1]:5173']);
    if (!isLoopback(req.socket.remoteAddress) || !hosts.has(req.headers.host || '') ||
        req.headers.origin !== 'http://' + req.headers.host) {
      throw new HttpError(403, 'invalid_origin', 'Доступен только локальный интерфейс разработки.');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Ожидается POST.');
    if (closed) throw new HttpError(503, 'service_closed', 'Сервис остановлен.');
    const body = await readJson(req);
    if (!isRecord(body) || Object.keys(body).some((key) => !['method', 'params'].includes(key)) ||
        typeof body.method !== 'string' || !isRecord(body.params)) {
      throw new HttpError(400, 'invalid_request', 'Ожидаются method и params.');
    }
    if (!['getSettings', 'saveSettings', 'startSetup', 'stopSetup', 'getSource', 'getSourceSession', 'sourceLogin', 'sourceLogout', 'getKinopoiskStatus', 'setKinopoiskKey', 'getKinopoiskPerson'].includes(body.method)) {
      throw new HttpError(404, 'unknown_method', 'Неизвестный метод.');
    }
    if (!['saveSettings', 'getSource', 'sourceLogin', 'sourceLogout', 'setKinopoiskKey', 'getKinopoiskPerson'].includes(body.method) && Object.keys(body.params).length) {
      throw new HttpError(400, 'invalid_request', 'Этот метод не принимает параметры.');
    }
    runtime ??= createRuntime(dataDir, { onMirrorChange: mirror => source.selectMirror(mirror, true) });
    let core: Runtime;
    try { core = await runtime; }
    catch (cause) { throw new HttpError(503, 'storage_error', (cause as Error).message); }
    if (closed) throw new HttpError(503, 'service_closed', 'Сервис остановлен.');
    let response: ServiceResponse;
    switch (body.method) {
      case 'getSettings': response = await core.getSettings(); break;
      case 'saveSettings': response = await core.saveSettings(body.params); break;
      case 'startSetup': response = await core.startSetup(); break;
      case 'getSource': response = await getSource(core, source, body.params); break;
      case 'getSourceSession': response = await getSourceSession(core, source); break;
      case 'sourceLogin': response = await sourceLogin(core, source, body.params); break;
      case 'sourceLogout': response = await sourceLogout(core, source, body.params); break;
      case 'getKinopoiskStatus': case 'setKinopoiskKey': case 'getKinopoiskPerson': response = await kinopoiskCall(kinopoisk, body.method, body.params); break;
      default: response = await core.stopSetup();
    }
    json(res, 200, response);
  }
  return {
    handle(req, res, next) {
      if (req.url !== '/__bridge') { next(); return; }
      void handleBridge(req, res).catch((cause) => fail(res, cause));
    },
    async close() {
      closed = true;
      source.close();
      await kinopoisk.close();
      if (runtime) await runtime.then((core) => core.close(), () => undefined);
    },
  };
}
