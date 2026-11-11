import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime';
import { createDevMiddleware } from './dev';
import { defaultSettings, validateSettings, type ServiceResponse, type SetupInfo } from '../shared/settings';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(options?: RuntimeOptions): Promise<{ runtime: Runtime; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'rezzka-service-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = await createRuntime(directory, { bindHost: '127.0.0.1', ...options });
  cleanup.push(() => runtime.close());
  return { runtime, directory };
}

function success(value: ServiceResponse): Extract<ServiceResponse, { returnValue: true }> {
  expect(value.returnValue).toBe(true);
  if (!value.returnValue) throw new Error(value.errorText);
  return value;
}

function setupInfo(value: ServiceResponse): SetupInfo {
  const setup = success(value).setup;
  expect(setup).toBeDefined();
  return setup!;
}

function base(setup: SetupInfo): string { return new URL(setup.urls[0]).origin; }

async function pair(setup: SetupInfo): Promise<string> {
  const response = await fetch(base(setup) + '/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: setup.pin }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function delayedJson(
  url: string, method: string, body: unknown, headers: Record<string, string> = {},
): Promise<{ finish(): void; response: Promise<{ status: number; value: Record<string, unknown> }> }> {
  const text = JSON.stringify(body);
  let onContinue!: () => void;
  const ready = new Promise<void>((resolve) => { onContinue = resolve; });
  let finish!: () => void;
  const response = new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
    const outgoing = httpRequest(url, {
      method,
      headers: {
        ...headers, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text), Expect: '100-continue',
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        try {
          resolve({
            status: incoming.statusCode!,
            value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        } catch (cause) { reject(cause); }
      });
    });
    outgoing.on('error', reject);
    outgoing.once('continue', onContinue);
    outgoing.flushHeaders();
    finish = () => outgoing.end(text);
    cleanup.push(async () => {
      outgoing.destroy();
      await response.catch(() => undefined);
    });
  });
  await Promise.race([ready, response.then(() => { throw new Error('Response before request body'); })]);
  return { finish, response };
}

describe('settings validation and persistence', () => {
  it('starts unconfigured and normalizes a valid mirror without making network requests', () => {
    expect(defaultSettings.mirrorUrl).toBe('');
    expect(validateSettings({ ...defaultSettings, mirrorUrl: ' HTTPS://Example.COM:443/ ' }).mirrorUrl)
      .toBe('https://example.com');
    expect(() => validateSettings({ ...defaultSettings, mirrorUrl: 'https://user:password@example.com' })).toThrow();
    expect(() => validateSettings({ ...defaultSettings, mirrorUrl: 'https://example.com/?token=secret' })).toThrow();
    expect(() => validateSettings({ ...defaultSettings, mirrorUrl: 'https://example.com/#secret' })).toThrow();
    expect(() => validateSettings({ ...defaultSettings, mirrorUrl: 'file:///etc/passwd' })).toThrow();
    expect(() => validateSettings({ ...defaultSettings, subtitles: 'true' })).toThrow();
    expect(() => validateSettings({ ...defaultSettings, unexpected: true })).toThrow();
  });

  it('persists canonical settings atomically with restricted file permissions and survives restart', async () => {
    const { runtime, directory } = await fixture();
    expect(success(await runtime.getSettings()).settings).toEqual({ revision: 0, values: defaultSettings });
    const saved = success(await runtime.saveSettings({
      expectedRevision: 0,
      values: { ...defaultSettings, mirrorUrl: 'https://example.com/', subtitles: true },
    }));
    expect(saved.settings?.revision).toBe(1);
    expect(saved.settings?.values.mirrorUrl).toBe('https://example.com');
    expect((await stat(join(directory, 'settings.json'))).mode & 0o777).toBe(0o600);
    await runtime.close();
    const reopened = await createRuntime(directory);
    cleanup.push(() => reopened.close());
    expect(success(await reopened.getSettings()).settings).toEqual(saved.settings);
  });

  it('rejects stale concurrent writes and preserves the accepted settings', async () => {
    const { runtime } = await fixture();
    const results = await Promise.all([
      runtime.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, subtitles: true } }),
      runtime.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, preferredQuality: '720p' } }),
    ]);
    expect(results.filter((result) => result.returnValue)).toHaveLength(1);
    expect(results[1]).toMatchObject({ returnValue: false, errorCode: 'revision_conflict' });
    expect(success(await runtime.getSettings()).settings?.values.subtitles).toBe(true);
    expect(await runtime.saveSettings({ expectedRevision: 1, values: { ...defaultSettings, preferredQuality: '4k' } }))
      .toMatchObject({ returnValue: false, errorCode: 'invalid_settings' });
    expect(success(await runtime.getSettings()).settings?.revision).toBe(1);
  });

  it('reports corrupt saved state without overwriting it', async () => {
    const { runtime, directory } = await fixture();
    await runtime.close();
    const path = join(directory, 'settings.json');
    const corrupt = '{ damaged state';
    await writeFile(path, corrupt);
    await expect(createRuntime(directory)).rejects.toThrow('Данные сохранены без изменений');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
  });

  it('returns copies so callers cannot mutate persisted state in memory', async () => {
    const { runtime } = await fixture();
    const envelope = success(await runtime.getSettings()).settings!;
    envelope.values.mirrorUrl = 'https://changed.invalid';
    expect(success(await runtime.getSettings()).settings?.values.mirrorUrl).toBe('');
  });

  it('runs the mirror invalidation hook only for validated actual mirror changes', async () => {
    const mirrors: string[] = [];
    const { runtime } = await fixture({ onMirrorChange: mirror => { mirrors.push(mirror); } });
    const values = { ...defaultSettings, mirrorUrl: 'https://first.invalid' };
    expect((await runtime.saveSettings({ expectedRevision: 0, values })).returnValue).toBe(true);
    expect((await runtime.saveSettings({ expectedRevision: 1, values: { ...values, subtitles: true } })).returnValue).toBe(true);
    await runtime.saveSettings({ expectedRevision: 0, values: { ...values, mirrorUrl: 'https://stale.invalid' } });
    await runtime.saveSettings({ expectedRevision: 2, values: { ...values, mirrorUrl: 'file:///invalid' } });
    expect((await runtime.saveSettings({ expectedRevision: 2, values: defaultSettings })).returnValue).toBe(true);
    expect(mirrors).toEqual(['https://first.invalid', '']);
  });

  it('keeps settings unchanged if the old source session cannot be revoked', async () => {
    const { runtime, directory } = await fixture({ onMirrorChange: () => { throw new Error('fixture storage secret'); } });
    const initial = success(await runtime.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, subtitles: true } })).settings!;
    const savedBefore = await readFile(join(directory, 'settings.json'), 'utf8');
    expect(await runtime.saveSettings({ expectedRevision: 1, values: { ...defaultSettings, mirrorUrl: 'https://another.invalid' } }))
      .toMatchObject({ returnValue: false, errorCode: 'source_session_error', errorText: expect.not.stringContaining('fixture storage secret') });
    expect(success(await runtime.getSettings()).settings).toEqual(initial);
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(savedBefore);
  });
});

describe('temporary LAN setup', () => {
  it('requires pairing before reading or writing, saves settings, and detects revision conflicts', async () => {
    const { runtime } = await fixture();
    const setup = setupInfo(await runtime.startSetup());
    expect(setup.pin).toMatch(/^\d{4}$/);
    expect((await fetch(base(setup) + '/setup')).status).toBe(200);
    expect((await fetch(base(setup) + '/api/settings')).status).toBe(401);
    const token = await pair(setup);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const read = await fetch(base(setup) + '/api/settings', { headers });
    expect(await read.json()).toMatchObject({ returnValue: true, settings: { revision: 0 } });
    const body = JSON.stringify({ expectedRevision: 0, values: { ...defaultSettings, preferredVoice: 'Оригинал' } });
    const saved = await fetch(base(setup) + '/api/settings', { method: 'PATCH', headers, body });
    expect(saved.status).toBe(200);
    expect(success(await runtime.getSettings()).settings?.values.preferredVoice).toBe('Оригинал');
    expect((await fetch(base(setup) + '/api/settings', { method: 'PATCH', headers, body })).status).toBe(409);
    await fetch(base(setup) + '/api/session', { method: 'DELETE', headers });
    expect((await fetch(base(setup) + '/api/settings', { headers })).status).toBe(401);
  });

  it('rate limits incorrect PINs and allows retry only after the cooldown', async () => {
    let now = 1_000_000;
    const { runtime } = await fixture({ now: () => now });
    const setup = setupInfo(await runtime.startSetup());
    const incorrect = setup.pin === '0000' ? '0001' : '0000';
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(base(setup) + '/api/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: incorrect }),
      });
      expect(response.status).toBe(401);
    }
    const blocked = await fetch(base(setup) + '/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: setup.pin }),
    });
    expect(blocked.status).toBe(429);
    now += 60_001;
    expect(await pair(setup)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rechecks the PIN cooldown after receiving a previously pending correct PIN body', async () => {
    let now = 1_000_000;
    const { runtime } = await fixture({ now: () => now });
    const setup = setupInfo(await runtime.startSetup());
    const pending = await delayedJson(base(setup) + '/api/pair', 'POST', { pin: setup.pin });
    const incorrect = setup.pin === '0000' ? '0001' : '0000';
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await fetch(base(setup) + '/api/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: incorrect }),
      })).status).toBe(401);
    }
    pending.finish();
    const response = await pending.response;
    expect(response.status).toBe(429);
    expect(response.value).toMatchObject({ returnValue: false, errorCode: 'rate_limited' });
    expect(response.value).not.toHaveProperty('token');
    now += 60_001;
    expect(await pair(setup)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not save a pending request after its browser token is revoked', async () => {
    const { runtime } = await fixture();
    const setup = setupInfo(await runtime.startSetup());
    const token = await pair(setup);
    const headers = { Authorization: 'Bearer ' + token };
    const pending = await delayedJson(base(setup) + '/api/settings', 'PATCH', {
      expectedRevision: 0, values: { ...defaultSettings, preferredVoice: 'Do not save' },
    }, headers);
    expect((await fetch(base(setup) + '/api/session', { method: 'DELETE', headers })).status).toBe(200);
    pending.finish();
    expect((await pending.response).status).toBe(401);
    expect(success(await runtime.getSettings()).settings).toEqual({ revision: 0, values: defaultSettings });
  });

  it('rejects expired setup, invalidates tokens across stop/start, and closes its port', async () => {
    let now = 1000;
    const { runtime } = await fixture({ now: () => now, setupTtlMs: 100_000 });
    const setup = setupInfo(await runtime.startSetup());
    const token = await pair(setup);
    expect(setupInfo(await runtime.startSetup())).toEqual(setup);
    now = setup.expiresAt;
    expect((await fetch(base(setup) + '/api/settings', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(410);
    await runtime.stopSetup();
    await expect(fetch(base(setup) + '/setup')).rejects.toThrow();
    const renewed = setupInfo(await runtime.startSetup());
    expect((await fetch(base(renewed) + '/api/settings', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401);
    await runtime.stopSetup();
    expect((await runtime.stopSetup()).returnValue).toBe(true);
  });

  it('automatically closes the listening port at TTL without a browser request', async () => {
    const { runtime } = await fixture({ setupTtlMs: 50 });
    const setup = setupInfo(await runtime.startSetup());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fetch(base(setup) + '/setup')).rejects.toThrow();
  });

  it('rejects cross-site requests, oversized JSON and URL tokens', async () => {
    const { runtime } = await fixture();
    const setup = setupInfo(await runtime.startSetup());
    const crossSite = await fetch(base(setup) + '/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' },
      body: JSON.stringify({ pin: setup.pin }),
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await fetch(base(setup) + '/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0'.repeat(2048) }),
    })).status).toBe(413);
    expect((await fetch(base(setup) + '/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })).status).toBe(400);
    expect((await fetch(base(setup) + '/api/settings?token=secret')).status).toBe(400);
  });

  it('serializes concurrent setup opens into one listener', async () => {
    const { runtime } = await fixture();
    const results = await Promise.all([runtime.startSetup(), runtime.startSetup(), runtime.startSetup()]);
    expect(results.map(setupInfo)).toEqual([setupInfo(results[0]), setupInfo(results[0]), setupInfo(results[0])]);
  });
});

describe('development bridge', () => {
  async function bridgeFixture(): Promise<{ server: Server; url: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'rezzka-bridge-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bridge = createDevMiddleware(directory);
    cleanup.push(() => bridge.close());
    const server = createServer((req, res) => {
      bridge.handle(req, res, () => { res.writeHead(404); res.end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    return { server, url: 'http://127.0.0.1:' + address.port + '/__bridge' };
  }

  it('requires the local Vite origin and rejects unknown RPC methods', async () => {
    const { url } = await bridgeFixture();
    // A browser cannot override Host. Use raw HTTP to exercise Vite's fixed
    // authority while the test listener itself uses an available ephemeral port.
    const request = (headers: Record<string, string>, body: string) =>
      new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const outgoing = httpRequest(url, { method: 'POST', headers }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => resolve({
            status: incoming.statusCode!,
            value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        });
        outgoing.on('error', reject);
        outgoing.end(body);
      });
    const body = JSON.stringify({ method: 'getSettings', params: {} });
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(403);
    const headers = { Host: 'localhost:5173', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
    const allowed = await request(headers, body);
    expect(allowed.status).toBe(200);
    expect(allowed.value).toMatchObject({ returnValue: true, settings: { revision: 0 } });
    expect((await request(headers, JSON.stringify({ method: 'exec', params: {} }))).status).toBe(404);
    expect((await request({ ...headers, Origin: 'https://other.invalid' }, body)).status).toBe(403);
  });
});
