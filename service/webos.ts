import { createRuntime, type Runtime } from './runtime';
import type { ServiceResponse } from '../shared/settings';
import { createSourceTransport, getSource, getSourceSession, sourceLogin, sourceLogout } from './source';
import { createKinopoisk } from './kinopoisk';
import { kinopoiskCall } from './kinopoisk-rpc';

// The TV supplies this module. esbuild must leave it external.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Service = require('webos-service') as new (id: string) => LunaService;
const APP_ID = 'ru.kamilov.rezzka';
const SERVICE_ID = APP_ID + '.service';

interface LunaMessage {
  sender: string;
  payload: unknown;
  isSubscription: boolean;
  uniqueToken: string;
  respond(value: ServiceResponse): void;
  cancel(): void;
}
interface LunaService {
  register(
    name: string,
    request: (message: LunaMessage) => void,
    cancel?: (message: LunaMessage) => void,
  ): unknown;
}

const service = new Service(SERVICE_ID);
const dataDir = '/media/internal/' + SERVICE_ID;
const source = createSourceTransport({ sessionPath: dataDir + '/source-session.json' });
const kinopoisk = createKinopoisk({ storagePath: dataDir + '/kinopoisk-key.json' });
let corePromise: Promise<Runtime> | undefined;
const leases = new Map<string, { message: LunaMessage; timer?: ReturnType<typeof setTimeout> }>();

function core(): Promise<Runtime> {
  corePromise ??= createRuntime(dataDir, { onMirrorChange: mirror => source.selectMirror(mirror, true) });
  return corePromise;
}

function authorized(message: LunaMessage): boolean {
  if (message.sender === APP_ID) return true;
  message.respond({ returnValue: false, errorCode: 'forbidden', errorText: 'Доступ запрещён.' });
  return false;
}

function respond(message: LunaMessage, work: Promise<ServiceResponse>): void {
  void work.then(
    (result) => message.respond(result),
    () => message.respond({
      returnValue: false,
      errorCode: 'storage_error',
      errorText: 'Сервис не смог прочитать настройки. Сохранённые данные не изменены.',
    }),
  );
}

function cancelLeases(): void {
  const existing = [...leases.values()];
  leases.clear();
  for (const lease of existing) {
    clearTimeout(lease.timer);
    lease.message.cancel();
  }
}

service.register('getSettings', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => runtime.getSettings()));
});
service.register('saveSettings', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => runtime.saveSettings(message.payload)));
});
service.register('getSource', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => getSource(runtime, source, message.payload)));
});
service.register('getSourceSession', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => getSourceSession(runtime, source)));
});
service.register('sourceLogin', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => sourceLogin(runtime, source, message.payload)));
});
service.register('sourceLogout', (message) => {
  if (authorized(message)) respond(message, core().then((runtime) => sourceLogout(runtime, source, message.payload)));
});
for (const method of ['getKinopoiskStatus', 'setKinopoiskKey', 'getKinopoiskPerson'] as const) {
  service.register(method, message => { if (authorized(message)) respond(message, kinopoiskCall(kinopoisk, method, message.payload)); });
}
service.register('stopSetup', (message) => {
  if (!authorized(message)) return;
  cancelLeases();
  respond(message, core().then((runtime) => runtime.stopSetup()));
});
service.register('startSetup', (message) => {
  if (!authorized(message)) return;
  if (!message.isSubscription) {
    message.respond({
      returnValue: false,
      errorCode: 'subscription_required',
      errorText: 'Режим настройки требует активной подписки приложения.',
    });
    return;
  }
  const lease = { message, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  leases.set(message.uniqueToken, lease);
  void core().then(async (runtime) => {
    const result = await runtime.startSetup();
    if (!leases.has(message.uniqueToken)) {
      if (!leases.size) await runtime.stopSetup();
      return;
    }
    message.respond(result);
    if (!result.returnValue || !result.setup) {
      leases.delete(message.uniqueToken);
      message.cancel();
      return;
    }
    lease.timer = setTimeout(() => {
      leases.delete(message.uniqueToken);
      message.cancel();
      if (!leases.size) void runtime.stopSetup();
    }, Math.max(0, result.setup.expiresAt - Date.now()));
    lease.timer.unref();
  }).catch(() => {
    leases.delete(message.uniqueToken);
    message.respond({ returnValue: false, errorCode: 'storage_error', errorText: 'Не удалось открыть сервис настроек.' });
    message.cancel();
  });
}, (message) => {
  const lease = leases.get(message.uniqueToken);
  if (!lease) return;
  clearTimeout(lease.timer);
  leases.delete(message.uniqueToken);
  if (!leases.size && corePromise) void corePromise.then((runtime) => runtime.stopSetup()).catch(() => undefined);
});

function shutdown(): void {
  source.close();
  cancelLeases();
  void Promise.allSettled([kinopoisk.close(), corePromise?.then(runtime => runtime.close())]).finally(() => process.exit(0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
