import { afterEach, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevMiddleware } from './dev';
import { createRuntime } from './runtime';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sentinel = 'synthetic-kinopoisk-key-never-returned';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rezzka-kinopoisk-bridge-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'kinopoisk-key.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, apiKey: sentinel, revision: 1 }), { mode: 0o600 });
  const bridge = createDevMiddleware(directory); cleanup.push(() => bridge.close());
  const server = createServer((req, res) => bridge.handle(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (method: string, params: object = {}, foreign = false) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(origin + '/__bridge', { method: 'POST', headers: {
      Host: 'localhost:5173', Origin: foreign ? 'https://outside.example' : 'http://localhost:5173', 'Content-Type': 'application/json',
    } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(JSON.stringify({ method, params }));
  });
  return { directory, path, call };
}

it('private bridge returns only key status, keeps ordinary settings secret-free and checks origins before key changes', async () => {
  const { path, call } = await fixture();
  expect(await call('getKinopoiskStatus')).toEqual({ status: 200, body: { returnValue: true, kinopoiskStatus: { configured: true, revision: 1 } } });
  expect(JSON.stringify(await call('getSettings'))).not.toContain(sentinel);
  expect((await call('setKinopoiskKey', { apiKey: '' }, true)).status).toBe(403);
  expect(JSON.parse(await readFile(path, 'utf8')).apiKey).toBe(sentinel);
  expect((await call('getKinopoiskStatus', { revealKey: true })).status).toBe(400);
  expect((await call('getKinopoiskPerson', { name: 'Без известного фильма' })).body).toEqual({ returnValue: true, kinopoisk: { status: 'unmatched' } });
  expect((await call('setKinopoiskKey', { apiKey: '' })).body).toMatchObject({ returnValue: true, kinopoiskStatus: { configured: false } });
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await call('getKinopoiskPerson', { filmId: '326', name: 'Без ключа' })).body).toEqual({ returnValue: true, kinopoisk: { status: 'disabled' } });
});

it('paired LAN settings never expose or modify the Kinopoisk key', async () => {
  const { directory, path } = await fixture();
  const runtime = await createRuntime(directory, { bindHost: '127.0.0.1' }); cleanup.push(() => runtime.close());
  const setup = await runtime.startSetup();
  if (!setup.returnValue || !setup.setup) throw new Error('Setup failed');
  const origin = new URL(setup.setup.urls[0]).origin;
  const paired = await fetch(origin + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: setup.setup.pin }) });
  const { token } = await paired.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  expect(await (await fetch(origin + '/api/settings', { headers })).text()).not.toContain(sentinel);
  for (const method of ['getKinopoiskStatus', 'setKinopoiskKey', 'getKinopoiskPerson']) {
    const response = await fetch(origin + `/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ apiKey: '' }) });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain(sentinel);
  }
  expect(JSON.parse(await readFile(path, 'utf8')).apiKey).toBe(sentinel);
});
