import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../shared/settings';
import { getSettings, isTelevision, saveSettings, sourceLogin, sourceRequest, startSetup } from '../../src/platform';

class FakeBridge {
  static instances: FakeBridge[] = [];
  onservicecallback: (message: string) => void = () => {};
  call = vi.fn();
  cancel = vi.fn();
  constructor() { FakeBridge.instances.push(this); }
  respond(reply: object) { this.onservicecallback(JSON.stringify(reply)); }
}

const snapshot = { revision: 3, values: { ...defaultSettings } };
function browser(overrides: object = {}) {
  const target = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    navigator: { userAgent: 'Desktop Chromium' },
    ...overrides,
  };
  vi.stubGlobal('window', target);
  return target;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeBridge.instances = [];
  vi.stubGlobal('fetch', vi.fn());
  browser();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('webOS native transport', () => {
  it('allows source login longer than settings calls and uses the private native endpoint', async () => {
    browser({ PalmServiceBridge: FakeBridge });
    const credentials = { mirrorUrl: 'https://fixture.example', username: 'fixture', password: 'synthetic-test-password' };
    const pending = sourceLogin(credentials);
    const bridge = FakeBridge.instances[0];
    expect(bridge.call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/sourceLogin', JSON.stringify(credentials));
    await vi.advanceTimersByTimeAsync(11000);
    expect(bridge.cancel).not.toHaveBeenCalled();
    const session = { authenticated: true, origin: credentials.mirrorUrl, username: 'fixture' };
    bridge.respond({ returnValue: true, session });
    await expect(pending).resolves.toEqual(session);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['PalmServiceBridge', 'WebOSServiceBridge'])('uses %s for settings without desktop HTTP fallback', async (name) => {
    browser({ [name]: FakeBridge });
    expect(isTelevision()).toBe(true);
    const loading = getSettings();
    const bridge = FakeBridge.instances[0];
    expect(bridge.call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/getSettings', '{}');
    bridge.respond({ returnValue: true, settings: snapshot });
    await expect(loading).resolves.toEqual(snapshot);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers the official PalmServiceBridge constructor when both exist', async () => {
    const compatibility = vi.fn();
    browser({ PalmServiceBridge: FakeBridge, WebOSServiceBridge: compatibility });
    const saving = saveSettings(snapshot.revision, snapshot.values);
    const bridge = FakeBridge.instances[0];
    expect(bridge.call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/saveSettings', JSON.stringify({ expectedRevision: snapshot.revision, values: snapshot.values }));
    bridge.respond({ returnValue: true, settings: snapshot });
    await expect(saving).resolves.toEqual(snapshot);
    expect(compatibility).not.toHaveBeenCalled();
  });

  it.each([
    { WebOSSystem: {} },
    { PalmSystem: {} },
    { navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36' } },
    { navigator: { userAgent: 'Mozilla/5.0 (webOS; Linux/SmartTV)' } },
  ])('reports missing native bridge on a detected television without fetching a local development endpoint', async (device) => {
    browser(device);
    expect(isTelevision()).toBe(true);
    await expect(getSettings()).rejects.toThrow('не найден PalmServiceBridge');
    const session = startSetup(vi.fn());
    await expect(session.result).rejects.toThrow('не найден PalmServiceBridge');
    session.cancel();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps setup subscribed, forwards settings updates, and cancels the subscription and listener once', async () => {
    browser({ PalmServiceBridge: FakeBridge });
    const changed = vi.fn();
    const session = startSetup(changed);
    const subscription = FakeBridge.instances[0];
    const setup = { urls: ['http://192.0.2.1:18888'], pin: '123456', expiresAt: Date.now() + 60000 };
    expect(subscription.call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/startSetup', '{"subscribe":true}');
    subscription.respond({ returnValue: true, setup });
    await expect(session.result).resolves.toEqual(setup);
    subscription.respond({ returnValue: true, settings: snapshot });
    expect(changed).toHaveBeenCalledWith(snapshot);
    session.cancel();
    session.cancel();
    expect(subscription.cancel).toHaveBeenCalledTimes(1);
    expect(FakeBridge.instances).toHaveLength(2);
    expect(FakeBridge.instances[1].call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/stopSetup', '{}');
    FakeBridge.instances[1].respond({ returnValue: true });
    subscription.respond({ returnValue: true, settings: { ...snapshot, revision: 4 } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a cancelled pending setup and ignores a late reply', async () => {
    browser({ WebOSServiceBridge: FakeBridge });
    const changed = vi.fn();
    const session = startSetup(changed);
    const rejection = expect(session.result).rejects.toThrow('Настройка закрыта');
    session.cancel();
    await rejection;
    FakeBridge.instances[0].respond({ returnValue: true, settings: snapshot });
    FakeBridge.instances[1].respond({ returnValue: true });
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('desktop preview transport', () => {
  it('retains auth_required as a code so every source screen can enter the login gate', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ returnValue: false, errorCode: 'auth_required', errorText: 'Войдите снова.' }) } as Response);
    await expect(sourceRequest({ operation: 'details', url: 'https://fixture.example/films/1-test.html' })).rejects.toMatchObject({ code: 'auth_required', message: 'Войдите снова.' });
  });
  it('uses HTTP only for a desktop and sends no subscription parameter', async () => {
    expect(isTelevision()).toBe(false);
    const setup = { urls: ['http://192.0.2.1:18888'], pin: '123456', expiresAt: Date.now() + 60000 };
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ returnValue: true, setup }) } as Response);
    const session = startSetup(vi.fn());
    await expect(session.result).resolves.toEqual(setup);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('__bridge'), expect.objectContaining({ body: '{"method":"startSetup","params":{}}' }));
    session.cancel();
  });
});
