import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceTransport, validateSourceRequest } from './source';
import { createRuntime } from './runtime';
import { defaultSettings } from '../shared/settings';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler), sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}
function client(options?: Parameters<typeof createSourceTransport>[0]) {
  const transport = createSourceTransport({ allowInsecureLoopbackAuth: true, ...options });
  cleanup.push(() => transport.close());
  return transport;
}
const accountCookies = ['dle_user_id=42; Path=/; HttpOnly', 'dle_password=fixture-session-token; Path=/; HttpOnly'];
const credentials = (mirrorUrl: string) => ({ mirrorUrl, username: 'viewer', password: 'fixture password' });
const voice = { id: '17', label: 'Студия', isAds: '0', isCamrip: '0', isDirector: '0' };
type Seen = { path: string; method: string; form: Record<string, string>; cookie: string };
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
const ok: Reply = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"success":true}'); };
/** A mirror that accepts a login and records every other request. */
async function mirror(reply: Reply = ok) {
  const seen: Seen[] = [];
  const origin = await fixture((req, res) => {
    if (req.url === '/ajax/login/') { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': accountCookies }); res.end('{"success":true}'); return; }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ path: req.url!.replace(/([?&]t=)\d+/, '$1TIME'), method: req.method!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), cookie: req.headers.cookie || '' });
      reply(req, res);
    });
  });
  return { origin, seen };
}

describe('recording what is watched in the account', () => {
  it('posts the film, voice, season and episode with the constant time the source clients send', async () => {
    const { origin, seen } = await mirror(), transport = client();
    await transport.login(origin, credentials(origin));
    const reply = await transport.request(origin, { operation: 'continueSave', id: '123', url: origin + '/series/drama/123-fixture.html', voice, season: '2', episode: '5' });
    expect(reply).toEqual({ body: '{"success":true}', url: expect.stringMatching(/\/ajax\/send_save\/\?t=\d+$/) });
    expect(seen).toEqual([{
      path: '/ajax/send_save/?t=TIME', method: 'POST', cookie: expect.stringContaining('dle_password=fixture-session-token'),
      form: { post_id: '123', translator_id: '17', season: '2', episode: '5', current_time: '1' },
    }]);
  });

  it('saves a film with zero season and episode', async () => {
    const { origin, seen } = await mirror(), transport = client();
    await transport.login(origin, credentials(origin));
    await transport.request(origin, { operation: 'continueSave', id: '123', url: origin + '/films/123-fixture.html', voice });
    expect(seen[0].form).toEqual({ post_id: '123', translator_id: '17', season: '0', episode: '0', current_time: '1' });
  });

  it('requires a signed-in session and sends nothing without one', async () => {
    const { origin, seen } = await mirror(), transport = client();
    await expect(transport.request(origin, { operation: 'continueSave', id: '123', url: origin + '/films/123-fixture.html', voice }))
      .rejects.toMatchObject({ code: 'auth_required' });
    expect(seen).toEqual([]);
  });

  it('refuses to send account data over plain HTTP outside local fixtures', async () => {
    const { origin, seen } = await mirror(), transport = createSourceTransport();
    cleanup.push(() => transport.close());
    await expect(transport.request(origin, { operation: 'continueSave', id: '123', url: origin + '/films/123-fixture.html', voice })).rejects.toThrow('HTTPS');
    expect(seen).toEqual([]);
  });

  it('sends a save once and never follows a redirect with it', async () => {
    const { origin, seen } = await mirror((_req, res) => { res.writeHead(302, { Location: '/elsewhere/' }); res.end(); });
    const transport = client();
    await transport.login(origin, credentials(origin));
    await expect(transport.request(origin, { operation: 'continueSave', id: '123', url: origin + '/films/123-fixture.html', voice }))
      .rejects.toMatchObject({ code: 'source_mutation_redirect' });
    expect(seen).toHaveLength(1);
  });

  it('rejects a save with a mismatched address, a lone season, a foreign origin or extra fields before connecting', async () => {
    const url = 'https://mirror.example/films/123-fixture.html';
    for (const query of [
      { operation: 'continueSave', id: '124', url, voice },
      { operation: 'continueSave', id: '123', url, voice, season: '2' },
      { operation: 'continueSave', id: '123', url, voice, episode: '5' },
      { operation: 'continueSave', id: '123', url, voice: { ...voice, id: 'abc' } },
      { operation: 'continueSave', id: '123', url, voice, current_time: '900' },
      { operation: 'continueSave', id: '0', url, voice },
    ]) expect(() => validateSourceRequest(query), JSON.stringify(query)).toThrow();
    const { origin, seen } = await mirror(), transport = client();
    await transport.login(origin, credentials(origin));
    await expect(transport.request(origin, { operation: 'continueSave', id: '123', url, voice })).rejects.toMatchObject({ code: 'source_origin' });
    expect(seen).toEqual([]);
  });
});

describe('seek preview map', () => {
  it('reads the map from the mirror with an empty POST and accepts WebVTT content', async () => {
    const { origin, seen } = await mirror((_req, res) => { res.setHeader('Content-Type', 'text/vtt; charset=utf-8'); res.end('WEBVTT\n\n00:00.000 --> 00:10.000\nhttps://cdn.example/a.jpg#xywh=0,0,160,90\n'); });
    const transport = client(), url = origin + '/ajax/get_cdn_tiles/0/123/?t=5';
    expect(await transport.request(origin, { operation: 'thumbnails', url })).toEqual({ body: expect.stringContaining('#xywh=0,0,160,90'), url });
    expect(seen).toEqual([{ path: '/ajax/get_cdn_tiles/0/123/?t=TIME', method: 'POST', form: {}, cookie: '' }]);
  });

  it('never asks another host for the map and rejects malformed addresses', async () => {
    const { origin, seen } = await mirror(), transport = client();
    await expect(transport.request(origin, { operation: 'thumbnails', url: 'https://cdn.example/tiles/1.vtt' })).rejects.toMatchObject({ code: 'source_origin' });
    for (const url of ['/ajax/get_cdn_tiles/', 'javascript:alert(1)', origin + '/tiles/1.vtt#frame', 'https://user:pass@mirror.example/tiles/1.vtt', 5]) {
      expect(() => validateSourceRequest({ operation: 'thumbnails', url }), String(url)).toThrow();
    }
    expect(() => validateSourceRequest({ operation: 'thumbnails', url: origin + '/tiles/1.vtt', extra: 1 })).toThrow();
    expect(seen).toEqual([]);
  });
});

describe('settings saved by an earlier version', () => {
  it('gain the automatic next episode setting instead of blocking the service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rezzka-upgrade-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const { autoNext: _added, ...older } = { ...defaultSettings, mirrorUrl: 'https://mirror.example', subtitles: true };
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 7, values: older }));
    const runtime = await createRuntime(directory, { bindHost: '127.0.0.1' });
    cleanup.push(() => runtime.close());
    expect(await runtime.getSettings()).toEqual({ returnValue: true, settings: { revision: 7, values: { ...older, autoNext: true } } });
    // Reading alone does not rewrite the file.
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).values).toEqual(older);
  });

  it('still refuses a file with an unknown field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rezzka-upgrade-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 1, values: { ...defaultSettings, surprise: true } }));
    await expect(createRuntime(directory, { bindHost: '127.0.0.1' })).rejects.toThrow('Данные сохранены без изменений');
  });
});
