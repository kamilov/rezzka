import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceTransport, getSource, getSourceSession, sourceLogin, validateSourceRequest } from './source';
import { createRuntime } from './runtime';
import { createDevMiddleware } from './dev';
import { defaultSettings } from '../shared/settings';
import type { SourceRequest } from '../shared/source';
import { sourceRequest } from '../src/platform';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const catalog: SourceRequest = { operation: 'catalog', page: 1, sort: 'last', type: '0' };
const voice = { id: '17', label: 'Озвучка', isAds: '1', isCamrip: '0', isDirector: '1' };
const favoriteMutations = [
  { operation: 'favoriteToggle', id: '123', collectionId: '17' },
  { operation: 'favoriteCreate', id: '123', name: 'На выходные' },
] as const;

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}
function transport(options?: Parameters<typeof createSourceTransport>[0]) {
  const client = createSourceTransport(options);
  cleanup.push(() => client.close());
  return client;
}
async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'rezzka-source-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function postBridge(origin: string, params: unknown, headers: Record<string, string> = {}, method = 'getSource') {
  return new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
    const outgoing = httpRequest(origin + '/__bridge', {
      method: 'POST', headers: { Host: 'localhost:5173', Origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { try { resolve({ status: response.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ method, params }));
  });
}

describe('bounded anonymous source transport', () => {
  it('builds catalog/search paths and preserves Cyrillic query text with exact form fields', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.setHeader('Content-Type', 'text/html'); res.end('<html>Каталог</html>'); });
    const client = transport();
    const first = await client.request(origin, catalog);
    expect(first).toEqual({ body: '<html>Каталог</html>', url: origin + '/?filter=last' });
    await client.request(origin, { ...catalog, page: 3, sort: 'new', type: '82' });
    await client.request(origin + '/base', { ...catalog, page: 2, sort: 'popular', type: '2' });
    await client.request(origin, { operation: 'search', query: '  Ёж & море  ', page: 2 });
    expect(seen.slice(0, 3)).toEqual(['/?filter=last', '/new/page/3/?genre=82', '/base/page/2/?filter=popular&genre=2']);
    const search = new URL(seen[3], origin);
    expect(search.pathname).toBe('/search/');
    expect(Object.fromEntries(search.searchParams)).toEqual({ do: 'search', subaction: 'search', q: 'Ёж & море', page: '2' });
  });

  it('builds account continue and filtered browse GET paths, including a mirror subpath', async () => {
    const seen: Array<{ path: string; method: string }> = [];
    const origin = await fixture((req, res) => { seen.push({ path: req.url!, method: req.method! }); res.end('<html>Подборка</html>'); });
    const client = transport();
    await client.request(origin, { operation: 'continue' });
    await client.request(origin + '/base', { operation: 'continue' });
    await client.request(origin, { operation: 'browse', page: 1, type: 'films', genre: '', year: '' });
    await client.request(origin, { operation: 'browse', page: 2, type: 'series', genre: 'drama', year: '' });
    await client.request(origin, { operation: 'browse', page: 1, type: 'cartoons', genre: '', year: '2026' });
    await client.request(origin + '/base', { operation: 'browse', page: 3, type: 'animation', genre: 'science-fiction', year: '1890' });
    // Genre values come from the source, so safe new slugs are not restricted to a static list.
    await client.request(origin, { operation: 'browse', page: 10000, type: 'films', genre: 'future-genre', year: '2099' });
    expect(seen).toEqual([
      { path: '/continue/', method: 'GET' },
      { path: '/base/continue/', method: 'GET' },
      { path: '/films/best/', method: 'GET' },
      { path: '/series/best/drama/page/2/', method: 'GET' },
      { path: '/cartoons/best/2026/', method: 'GET' },
      { path: '/base/animation/best/science-fiction/1890/page/3/', method: 'GET' },
      { path: '/films/best/future-genre/2099/page/10000/', method: 'GET' },
    ]);
  });

  it('reads the default favorites page and explicit collection pages sorted by addition', async () => {
    const paths: string[] = [];
    const origin = await fixture((req, res) => { paths.push(req.url!); expect(req.method).toBe('GET'); res.end('favorites'); });
    const client = transport();
    await client.request(origin, { operation: 'favorites', page: 1 });
    await client.request(origin, { operation: 'favorites', collectionId: '17', page: 1 });
    await client.request(origin + '/base', { operation: 'favorites', collectionId: '17', page: 3 });
    expect(paths).toEqual(['/favorites/?filter=added', '/favorites/17/?filter=added', '/base/favorites/17/page/3/?filter=added']);
  });

  it('reads quick-content ratings with exact form fields without requiring an account', async () => {
    const seen: Array<{ path: string; method: string; form: Record<string, string>; cookie?: string }> = [];
    const body = '<div class="b-content__bubble_rating"><span class="imdb">7.8</span></div>';
    const origin = await fixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ path: req.url!, method: req.method!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), cookie: req.headers.cookie });
        res.setHeader('Content-Type', 'text/html'); res.end(body);
      });
    });
    const client = transport(), mirror = origin + '/base';
    expect(await client.request(mirror, { operation: 'ratings', id: '123', url: mirror + '/films/123-fixture.html' }))
      .toEqual({ body, url: mirror + '/engine/ajax/quick_content.php' });
    expect(seen).toEqual([{ path: '/base/engine/ajax/quick_content.php', method: 'POST', form: { id: '123', is_touch: '1' }, cookie: undefined }]);
    expect((await client.session(mirror)).authenticated).toBe(false);
  });

  it('binds rating reads to a valid title ID and the current origin before connecting', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const client = transport(), query = { operation: 'ratings', id: '123', url: origin + '/films/123-fixture.html' };
    for (const invalid of [
      ...['0', '01', '-1', '1'.repeat(13), 123, null].map(id => ({ ...query, id })),
      ...['/films/123-fixture.html', origin + '/films/124-fixture.html', query.url + '?id=124', query.url + '#fragment',
        'https://user:password@example.invalid/films/123-fixture.html', query.url + '\n'].map(url => ({ ...query, url })),
      { ...query, is_touch: '0' }, { ...query, action: 'add_post' }, { operation: 'ratings', id: '123' },
    ]) await expect(client.request(origin, invalid)).rejects.toMatchObject({ code: 'invalid_source_request' });
    await expect(client.request(origin, { ...query, url: 'https://another.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'source_origin' });
    expect(seen).toEqual([]);
  });

  it('reads a comments page with the exact GET contract and mirror subpath without requiring login', async () => {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    const origin = await fixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { seen.push({ url: req.url!, method: req.method!, body: Buffer.concat(chunks).toString() }); res.end('{"comments":"","navigation":""}'); });
    });
    const client = transport(), mirror = origin + '/base', started = Date.now();
    const result = await client.request(mirror, { operation: 'comments', id: '123', url: mirror + '/films/123-fixture.html', page: 3 });
    expect(result.body).toBe('{"comments":"","navigation":""}');
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ method: 'GET', body: '' });
    const url = new URL(seen[0].url, origin), params = Object.fromEntries(url.searchParams);
    expect(url.pathname).toBe('/base/ajax/get_comments/');
    expect(params).toEqual({ t: expect.stringMatching(/^\d+$/), news_id: '123', cstart: '3', type: '0', comment_id: '0', skin: 'hdrezka' });
    expect(Number(params.t)).toBeGreaterThanOrEqual(started); expect(Number(params.t)).toBeLessThanOrEqual(Date.now());
    expect(result.url).toBe(url.href);
  });

  it('rejects comments requests with invalid title binding, page or extra parameters before connecting', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const client = transport(), query = { operation: 'comments', id: '123', url: origin + '/films/123-fixture.html', page: 1 };
    for (const invalid of [
      ...['0', '01', '1'.repeat(13), 123].map(id => ({ ...query, id })),
      ...[0, 10001, 1.5, '2', null].map(page => ({ ...query, page })),
      ...['/films/123-fixture.html', origin + '/films/124-fixture.html', query.url + '?post=1', query.url + '#part'].map(url => ({ ...query, url })),
      { ...query, comment_id: '7' }, { ...query, type: '1' }, { operation: 'comments', id: '123', url: query.url },
    ]) await expect(client.request(origin, invalid)).rejects.toMatchObject({ code: 'invalid_source_request' });
    await expect(client.request(origin, { ...query, url: 'https://another.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'source_origin' });
    expect(seen).toEqual([]);
  });

  it('validates favorite identifiers and binds mutations to the matching absolute title URL before connecting', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const client = transport();
    const toggle = { operation: 'favoriteToggle', id: '123', collectionId: '17', url: origin + '/films/drama/123-fixture.html' };
    for (const id of ['', '0', '01', '-1', '1.2', '1/2', '1&action=delete', '1'.repeat(13), 1, null]) {
      await expect(client.request(origin, { ...toggle, id })).rejects.toMatchObject({ code: 'invalid_source_request' });
      await expect(client.request(origin, { ...toggle, collectionId: id })).rejects.toMatchObject({ code: 'invalid_source_request' });
      await expect(client.request(origin, { operation: 'favorites', page: 1, collectionId: id })).rejects.toMatchObject({ code: 'invalid_source_request' });
    }
    for (const url of ['/films/123-fixture.html', '//elsewhere.invalid/films/123-fixture.html', origin + '/films/124-fixture.html',
      origin + '/films/123-fixture.html?token=private', origin + '/films/123-fixture.html#fragment', 'file:///123-fixture.html',
      'https://user:password@example.invalid/123-fixture.html', origin + '/films/123-fixture.html\n', origin + '/' + 'a'.repeat(2048)]) {
      await expect(client.request(origin, { ...toggle, url })).rejects.toMatchObject({ code: 'invalid_source_request' });
    }
    for (const query of [{ operation: 'favorites', page: 2 }, { operation: 'favorites', page: 0 }, { operation: 'favorites', page: 10001 },
      { operation: 'favorites', page: 1, url: origin }, { ...toggle, action: 'delete' }, { operation: 'favoriteToggle', id: '123', url: toggle.url }]) {
      await expect(client.request(origin, query)).rejects.toMatchObject({ code: 'invalid_source_request' });
    }
    await expect(client.request(origin, { ...toggle, url: 'https://another.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'source_origin' });
    expect(validateSourceRequest({ operation: 'favorites', page: 10000, collectionId: '999999999999' })).toMatchObject({ collectionId: '999999999999', page: 10000 });
    expect(seen).toEqual([]);
  });

  it('validates collection names and the current title identity before creating a collection', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const client = transport(), query = { operation: 'favoriteCreate', id: '123', name: 'Коллекция', url: origin + '/films/123-fixture.html' };
    for (const name of ['', '   ', 'x'.repeat(101), '\nКоллекция', 'Коллекция\t', 'До\u0000ма', 'До\u007fма', 123, null]) {
      await expect(client.request(origin, { ...query, name })).rejects.toMatchObject({ code: 'invalid_source_request' });
    }
    for (const invalid of [
      { ...query, id: '0' }, { ...query, id: '01' }, { ...query, id: '1'.repeat(13) }, { ...query, id: '124' },
      { ...query, url: '/films/123-fixture.html' }, { ...query, url: query.url + '?action=delete' }, { ...query, url: query.url + '#fragment' },
      { ...query, url: 'https://user:password@example.invalid/films/123-fixture.html' }, { ...query, collectionId: '17' },
      { ...query, post_id: '123' }, { ...query, action: 'add_post' }, { operation: 'favoriteCreate', id: '123', url: query.url },
    ]) await expect(client.request(origin, invalid)).rejects.toMatchObject({ code: 'invalid_source_request' });
    await expect(client.request(origin, { ...query, url: 'https://another.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'source_origin' });
    expect(validateSourceRequest({ ...query, name: '  ' + 'я'.repeat(100) + '  ' })).toMatchObject({ name: 'я'.repeat(100) });
    expect(seen).toEqual([]);
  });

  it('rejects invalid browse filters, path traversal and origin injection before connecting', async () => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const client = transport();
    const browse = { operation: 'browse', page: 1, type: 'films', genre: '', year: '' };
    const invalid = [
      ...['../series', 'film', 'Films', '//elsewhere.invalid', 'https://elsewhere.invalid'].map(type => ({ ...browse, type })),
      ...['..', '../continue', '/drama', 'drama/', 'drama\\other', '%2e%2e', 'drama?x=1', 'drama#x', '//elsewhere.invalid', 'https://elsewhere.invalid', 'Drama', 'драма', '-drama', 'drama-', 'drama--other', 'a'.repeat(65), 'drama\n', null, 1].map(genre => ({ ...browse, genre })),
      ...['1799', '2100', '20', '20260', '2026/page/2', '../', '2026?x=1', ' 2026', 2026, null].map(year => ({ ...browse, year })),
      ...[0, 10001, 1.5, '2'].map(page => ({ ...browse, page })),
      { operation: 'browse', page: 1, type: 'films', year: '' },
      { operation: 'browse', page: 1, type: 'films', genre: '' },
      { ...browse, url: 'https://elsewhere.invalid' },
      { operation: 'continue', page: 1 },
      { operation: 'continue', url: 'https://elsewhere.invalid' },
    ];
    for (const query of invalid) await expect(client.request(origin, query)).rejects.toMatchObject({ code: 'invalid_source_request' });
    expect(seen).toEqual([]);
    expect(validateSourceRequest({ ...browse, genre: 'a'.repeat(64), year: '1800' })).toMatchObject({ genre: 'a'.repeat(64), year: '1800' });
  });

  it('posts only the expected fields for movie, series and episode listing', async () => {
    const received: Array<{ path: string; method: string; form: Record<string, string>; type?: string }> = [];
    const origin = await fixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => { received.push({ path: req.url!, method: req.method!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), type: req.headers['content-type'] }); res.end('{"success":true}'); });
    });
    const client = transport();
    await client.request(origin, { operation: 'streams', id: '123', voice });
    await client.request(origin, { operation: 'streams', id: '123', voice, season: '2', episode: '4' });
    await client.request(origin, { operation: 'episodes', id: '123', voice });
    expect(received.map((item) => item.form)).toEqual([
      { id: '123', translator_id: '17', is_camrip: '0', is_ads: '1', is_director: '1', action: 'get_movie' },
      { id: '123', translator_id: '17', season: '2', episode: '4', action: 'get_stream' },
      { id: '123', translator_id: '17', action: 'get_episodes' },
    ]);
    for (const item of received) {
      expect(item.path).toMatch(/^\/ajax\/get_cdn_series\/\?t=\d{13}$/);
      expect(item.method).toBe('POST');
      expect(item.type).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    }
  });

  it('validates input shape, identifiers, credentials, scheme and origin before connecting', async () => {
    const client = transport();
    await expect(client.request('', catalog)).rejects.toMatchObject({ code: 'mirror_not_configured' });
    for (const mirror of ['file:///tmp/a', 'https://u:p@example.com', 'https://example.com/?token=x']) {
      await expect(client.request(mirror, catalog)).rejects.toMatchObject({ code: 'invalid_source_request' });
    }
    for (const input of [
      { ...catalog, page: 0 }, { ...catalog, page: 1.1 }, { ...catalog, unexpected: true }, { ...catalog, type: 1 },
      { operation: 'search', query: ' ', page: 1 }, { operation: 'search', query: 'a'.repeat(201), page: 1 },
      { operation: 'streams', id: '1', voice, season: '1' },
      { operation: 'streams', id: '1', voice: { ...voice, id: 'default' } },
      { operation: 'streams', id: '1', voice: { ...voice, isAds: '3' } },
      { operation: 'episodes', id: '1&other=2', voice },
    ]) expect(() => validateSourceRequest(input)).toThrow();
    for (const url of ['https://elsewhere.invalid/film.html', '//elsewhere.invalid/film.html', 'https://u:p@example.com/film.html']) {
      await expect(client.request('https://example.com', { operation: 'details', url })).rejects.toMatchObject({ code: 'source_origin' });
    }
  });

  it.each(['gzip', 'deflate', 'br'] as const)('decodes bounded %s HTML', async (encoding) => {
    const expected = '<html>Публичная карточка</html>';
    const compressed = encoding === 'gzip' ? gzipSync(expected) : encoding === 'deflate' ? deflateSync(expected) : brotliCompressSync(expected);
    const origin = await fixture((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': encoding }); res.end(compressed); });
    expect((await transport().request(origin, catalog)).body).toBe(expected);
  });

  it('rejects oversized plain, compressed expansion, malformed compression and binary replies', async () => {
    const origin = await fixture((req, res) => {
      if (req.url === '/zip') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('x'.repeat(2048))); }
      else if (req.url === '/broken') { res.setHeader('Content-Encoding', 'gzip'); res.end('invalid gzip'); }
      else if (req.url === '/video') { res.setHeader('Content-Type', 'video/mp4'); res.end('video'); }
      else { res.write('x'.repeat(600)); res.end('x'.repeat(600)); }
    });
    const client = transport({ maxBytes: 1024 });
    for (const path of ['/plain', '/zip']) await expect(client.request(origin, { operation: 'details', url: path })).rejects.toMatchObject({ code: 'source_too_large' });
    await expect(client.request(origin, { operation: 'details', url: '/broken' })).rejects.toMatchObject({ code: 'source_encoding' });
    await expect(client.request(origin, { operation: 'details', url: '/video' })).rejects.toMatchObject({ code: 'source_content_type' });
  });

  it('follows only same-origin bounded redirects and keeps cookies private on redirects', async () => {
    const cookies: string[] = [];
    const origin = await fixture((req, res) => {
      cookies.push(req.headers.cookie || '');
      if (req.url?.startsWith('/?')) { res.writeHead(302, { Location: '/ready', 'Set-Cookie': 'PHPSESSID=fixture_session; Path=/; HttpOnly' }); res.end(); }
      else if (req.url === '/ready') res.end('ready');
      else if (req.url === '/cross') { res.writeHead(302, { Location: 'http://example.invalid/target?private=fixture' }); res.end(); }
      else { res.writeHead(302, { Location: '/loop' }); res.end(); }
    });
    const client = transport();
    expect(await client.request(origin, catalog)).toEqual({ body: 'ready', url: origin + '/ready' });
    expect(cookies.slice(0, 2)).toEqual(['', 'PHPSESSID=fixture_session']);
    await expect(client.request(origin, { operation: 'details', url: '/cross' })).rejects.toMatchObject({ code: 'source_redirect_origin' });
    await expect(client.request(origin, { operation: 'details', url: '/loop' })).rejects.toMatchObject({ code: 'source_redirects' });
  });

  it('honors cookie path/expiry/secure/domain, ignores account cookies and clears session on mirror change', async () => {
    const cookies: string[] = [];
    const origin = await fixture((req, res) => {
      cookies.push(req.headers.cookie || '');
      if (req.url === '/seed') res.setHeader('Set-Cookie', [
        'PHPSESSID=fixture=a; Path=/; HttpOnly', 'scoped=only; Path=/scope', 'expired=gone; Max-Age=0; Path=/',
        'secure=only; Secure; Path=/', 'foreign=no; Domain=example.invalid; Path=/',
        'dle_user_id=17; Path=/', 'dle_password=synthetic; Path=/',
      ]);
      res.end('ok');
    });
    const other = await fixture((req, res) => { cookies.push(req.headers.cookie || ''); res.end('other'); });
    const client = transport();
    for (const url of ['/seed', '/scope/inside', '/scope-other']) await client.request(origin, { operation: 'details', url });
    await client.request(other, catalog);
    await client.request(origin, catalog);
    expect(cookies).toEqual(['', 'scoped=only; PHPSESSID=fixture=a', 'PHPSESSID=fixture=a', '', '']);
  });

  it('expires the whole request even while data trickles and frees a slot for the next request', async () => {
    const origin = await fixture((req, res) => {
      if (req.url === '/fast') { res.end('ok'); return; }
      const interval = setInterval(() => res.write('x'), 10);
      res.once('close', () => clearInterval(interval));
    });
    const client = transport({ timeoutMs: 65 });
    await expect(client.request(origin, catalog)).rejects.toMatchObject({ code: 'source_timeout' });
    expect((await client.request(origin, { operation: 'details', url: '/fast' })).body).toBe('ok');
  });

  it('reports HTTP restrictions without exposing response text and aborts pending requests on close', async () => {
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    const origin = await fixture((req, res) => {
      if (req.url === '/hang') { connected(); return; }
      res.writeHead(403); res.end('not for error messages: fixture-cookie');
    });
    const client = transport();
    await expect(client.request(origin, catalog)).rejects.toMatchObject({ code: 'source_http_403', message: expect.not.stringContaining('fixture-cookie') });
    const pending = client.request(origin, { operation: 'details', url: '/hang' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'service_closed' });
    await ready;
    client.close();
    await rejected;
  });

  it('reads the persisted mirror via the authorized development bridge, without a LAN provider route', async () => {
    const origin = await fixture((_req, res) => res.end('<html>fixture</html>'));
    const directory = await tempDirectory();
    const core = await createRuntime(directory, { bindHost: '127.0.0.1' });
    cleanup.push(() => core.close());
    expect(await getSource(core, transport(), catalog)).toMatchObject({ returnValue: false, errorCode: 'mirror_not_configured' });
    await core.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, mirrorUrl: origin } });
    const bridge = createDevMiddleware(directory);
    cleanup.push(() => bridge.close());
    const bridgeOrigin = await fixture((req, res) => bridge.handle(req, res, () => { res.writeHead(404); res.end(); }));
    expect(await postBridge(bridgeOrigin, catalog)).toMatchObject({ status: 200, value: { returnValue: true, source: { body: '<html>fixture</html>', url: origin + '/?filter=last' } } });
    expect(await postBridge(bridgeOrigin, catalog, { Origin: 'https://foreign.invalid' })).toMatchObject({ status: 403 });
    const setup = await core.startSetup();
    if (!setup.returnValue || !setup.setup) throw new Error('Setup failed');
    const setupOrigin = new URL(setup.setup.urls[0]).origin;
    expect((await fetch(setupOrigin + '/api/source')).status).toBe(401);
    const pair = await fetch(setupOrigin + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: setup.setup.pin }) });
    const { token } = await pair.json() as { token: string };
    expect((await fetch(setupOrigin + '/api/source', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(404);
  });
});

describe('private source account session', () => {
  const accountCookies = ['dle_user_id=42; Path=/; HttpOnly', 'dle_password=fixture-session-token; Path=/; HttpOnly', 'PHPSESSID=fixture-session-id; Path=/; HttpOnly'];
  const credentials = (mirrorUrl: string) => ({ mirrorUrl, username: '  кино-user  ', password: '  fixture account password &+  ' });
  const loginPage = '<h1>Вход</h1><form><input name="login_name"><input name="login_password"></form>';
  function success(res: ServerResponse) { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': accountCookies }); res.end('{"success":true}'); }
  const authTransport = (options?: Parameters<typeof createSourceTransport>[0]) => transport({ allowInsecureLoopbackAuth: true, ...options });

  it('posts the login contract, preserves password spaces, persists only a private session and restores it', async () => {
    const requests: Array<{ url: string; form: Record<string, string>; cookie: string }> = [];
    const origin = await fixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ url: req.url!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), cookie: req.headers.cookie || '' });
        if (req.url === '/ajax/login/') success(res); else res.end('<h1>Каталог</h1>');
      });
    });
    const sessionPath = join(await tempDirectory(), 'source-session.json');
    const client = authTransport({ sessionPath });
    const session = await client.login(origin, credentials(origin));
    expect(session).toEqual({ authenticated: true, origin, username: 'кино-user' });
    expect(requests[0]).toEqual({ url: '/ajax/login/', cookie: '', form: { login_name: 'кино-user', login_password: credentials(origin).password, login_not_save: '0' } });
    const saved = await readFile(sessionPath, 'utf8');
    expect(saved).not.toContain(credentials(origin).password);
    expect(JSON.stringify(session)).not.toContain('fixture-session');
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    client.close();
    const restored = authTransport({ sessionPath });
    expect(await restored.session(origin)).toEqual(session);
    await restored.request(origin, catalog);
    expect(requests[1].cookie).toContain('dle_password=fixture-session-token');
    expect(requests[1].cookie).toContain('PHPSESSID=fixture-session-id');
  });

  it('reuses the private session for account pages, ratings and comments without forwarding it across origins', async () => {
    const seen: Array<{ path: string; cookie: string }> = [], foreign: string[] = [];
    const other = await fixture((req, res) => { foreign.push(req.headers.cookie || ''); res.end('unexpected redirect'); });
    let redirect = false;
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      seen.push({ path: req.url!, cookie: req.headers.cookie || '' });
      if (redirect) { res.writeHead(302, { Location: other + '/target' }); res.end(); }
      else res.end('<html>Подборка аккаунта</html>');
    });
    const client = authTransport();
    await client.login(origin, credentials(origin));
    const requests: SourceRequest[] = [
      { operation: 'continue' },
      { operation: 'browse', page: 2, type: 'series', genre: 'drama', year: '2024' },
      { operation: 'ratings', id: '123', url: origin + '/films/123-fixture.html' },
      { operation: 'comments', id: '123', url: origin + '/films/123-fixture.html', page: 2 },
    ];
    for (const query of requests) await client.request(origin, query);
    expect(seen.map(item => item.path.split('?')[0])).toEqual(['/continue/', '/series/best/drama/2024/page/2/', '/engine/ajax/quick_content.php', '/ajax/get_comments/']);
    for (const item of seen) {
      expect(item.cookie).toContain('dle_user_id=42');
      expect(item.cookie).toContain('dle_password=fixture-session-token');
      expect(item.cookie).toContain('PHPSESSID=fixture-session-id');
    }
    redirect = true;
    for (const query of requests) await expect(client.request(origin, query)).rejects.toMatchObject({ code: 'source_redirect_origin' });
    expect(foreign).toEqual([]);
    expect((await client.session(origin)).authenticated).toBe(true);
  });

  it('posts exactly the source favorites toggle contract using the authenticated private session', async () => {
    const seen: Array<{ path: string; method: string; form: Record<string, string>; cookie: string; type?: string; origin?: string; ajax?: string | string[] }> = [];
    const origin = await fixture((req, res) => {
      if (req.url === '/base/ajax/login/') { success(res); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ path: req.url!, method: req.method!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), cookie: req.headers.cookie || '', type: req.headers['content-type'], origin: req.headers.origin, ajax: req.headers['x-requested-with'] });
        res.setHeader('Content-Type', 'application/json'); res.end('{"success":true}');
      });
    });
    const mirror = origin + '/base', client = authTransport();
    await client.login(mirror, credentials(mirror));
    expect(await client.request(mirror, { operation: 'favoriteToggle', id: '123', collectionId: '17', url: origin + '/base/films/123-fixture.html' }))
      .toEqual({ body: '{"success":true}', url: origin + '/base/ajax/favorites/' });
    expect(seen).toEqual([{
      path: '/base/ajax/favorites/', method: 'POST', form: { post_id: '123', cat_id: '17', action: 'add_post' },
      cookie: expect.stringContaining('dle_password=fixture-session-token'), type: 'application/x-www-form-urlencoded; charset=UTF-8', origin, ajax: 'XMLHttpRequest',
    }]);
  });

  it('creates a collection with only its trimmed name and action, without adding the title to it', async () => {
    const seen: Array<{ path: string; method: string; form: Record<string, string>; cookie: string }> = [];
    const origin = await fixture((req, res) => {
      if (req.url === '/base/ajax/login/') { success(res); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ path: req.url!, method: req.method!, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), cookie: req.headers.cookie || '' });
        res.setHeader('Content-Type', 'application/json'); res.end('{"success":true,"id":19,"name":"На вечер & ещё +"}');
      });
    });
    const mirror = origin + '/base', client = authTransport();
    await client.login(mirror, credentials(mirror));
    expect(await client.request(mirror, { operation: 'favoriteCreate', id: '123', name: '  На вечер & ещё +  ', url: mirror + '/films/123-fixture.html' }))
      .toEqual({ body: '{"success":true,"id":19,"name":"На вечер & ещё +"}', url: mirror + '/ajax/favorites/' });
    expect(seen).toEqual([{ path: '/base/ajax/favorites/', method: 'POST', form: { name: 'На вечер & ещё +', action: 'add_cat' }, cookie: expect.stringContaining('dle_password=fixture-session-token') }]);
  });

  it.each(favoriteMutations)('requires HTTPS and a current authenticated session before transmitting $operation', async mutation => {
    const seen: string[] = [];
    const origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected request'); });
    const query = { ...mutation, url: origin + '/films/123-fixture.html' };
    await expect(transport().request(origin, query)).rejects.toMatchObject({ code: 'auth_https_required' });
    await expect(authTransport().request(origin, query)).rejects.toMatchObject({ code: 'auth_required' });
    await expect(authTransport().request('http://not-loopback.invalid', { ...query, url: 'http://not-loopback.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'auth_https_required' });
    await expect(transport().request('https://example.invalid', { ...query, url: 'https://example.invalid/films/123-fixture.html' })).rejects.toMatchObject({ code: 'auth_required' });
    expect(seen).toEqual([]);
  });

  it('allows only one in-flight toggle per post and collection and releases its lock after completion', async () => {
    const collections: string[] = [];
    let delayed!: ServerResponse, arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        collections.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('cat_id')!);
        if (collections.length === 1) { delayed = res; arrived(); }
        else res.end('{"success":true}');
      });
    });
    const client = authTransport(), query = { operation: 'favoriteToggle', id: '123', collectionId: '17', url: origin + '/films/123-fixture.html' };
    await client.login(origin, credentials(origin));
    const first = client.request(origin, query);
    await received;
    await expect(client.request(origin, query)).rejects.toMatchObject({ code: 'favorite_busy' });
    await client.request(origin, { ...query, collectionId: '18' });
    delayed.end('{"success":true}'); await first;
    await client.request(origin, query);
    expect(collections).toEqual(['17', '18', '17']);
  });

  it('locks concurrent collection creation across titles while allowing independent membership changes', async () => {
    const actions: string[] = [];
    let delayed!: ServerResponse, arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        actions.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('action')!);
        if (actions.length === 1) { delayed = res; arrived(); }
        else res.end('{"success":true}');
      });
    });
    const client = authTransport(), query = { operation: 'favoriteCreate', id: '123', name: 'Выходные', url: origin + '/films/123-fixture.html' };
    await client.login(origin, credentials(origin));
    const first = client.request(origin, query);
    await received;
    await expect(client.request(origin, query)).rejects.toMatchObject({ code: 'favorite_busy' });
    await expect(client.request(origin, { ...query, id: '124', name: 'Другая', url: origin + '/films/124-fixture.html' })).rejects.toMatchObject({ code: 'favorite_busy' });
    await client.request(origin, { operation: 'favoriteToggle', id: '123', collectionId: '17', url: query.url });
    delayed.end('{"success":true}'); await first;
    await client.request(origin, { ...query, name: 'Другая' });
    expect(actions).toEqual(['add_cat', 'add_post', 'add_cat']);
  });

  it.each(favoriteMutations.flatMap(mutation => [301, 302, 303, 307, 308].map(status => ({ mutation, status }))))('never converts or replays $mutation.operation after HTTP $status', async ({ mutation, status }) => {
    const seen: Array<{ path: string; method: string }> = [];
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      seen.push({ path: req.url!, method: req.method! });
      if (req.url === '/ajax/favorites/') { res.writeHead(status, { Location: '/redirected' }); res.end(); }
      else res.end('{"success":true}');
    });
    const client = authTransport();
    await client.login(origin, credentials(origin));
    await expect(client.request(origin, { ...mutation, url: origin + '/films/123-fixture.html' }))
      .rejects.toMatchObject({ code: 'source_mutation_redirect' });
    expect(seen).toEqual([{ path: '/ajax/favorites/', method: 'POST' }]);
  });

  it.each(favoriteMutations)('sends a timed-out $operation only once and reports its outcome as unconfirmed', async mutation => {
    let mutations = 0;
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      if (req.url === '/ajax/favorites/') { mutations++; req.resume(); return; }
      res.end('favorites');
    });
    const client = authTransport({ timeoutMs: 65 });
    await client.login(origin, credentials(origin));
    await expect(client.request(origin, { ...mutation, url: origin + '/films/123-fixture.html' }))
      .rejects.toMatchObject({ code: 'source_mutation_unconfirmed', message: expect.stringContaining('Обновите избранное') });
    await client.request(origin, { operation: 'favorites', collectionId: '17', page: 1 });
    expect(mutations).toBe(1);
  });

  it.each(favoriteMutations)('preserves session invalidation when an old $operation connection fails after logout', async mutation => {
    let connection!: Socket, arrived!: () => void, mutations = 0;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      mutations++; req.resume(); connection = req.socket; arrived();
    });
    const client = authTransport();
    await client.login(origin, credentials(origin));
    const pending = client.request(origin, { ...mutation, url: origin + '/films/123-fixture.html' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'source_changed' });
    await received;
    await client.logout(origin, { mirrorUrl: origin });
    connection.destroy();
    await rejected;
    expect(mutations).toBe(1);
    expect((await client.session(origin)).authenticated).toBe(false);
  });

  it.each(favoriteMutations.flatMap(mutation => (['logout', 'mirror', 'login'] as const).map(action => ({ mutation, action }))))('rejects a late $mutation.operation response after $action without resurrecting its cookies', async ({ mutation, action }) => {
    let delayed!: ServerResponse, arrived!: () => void, mutations = 0;
    const received = new Promise<void>(resolve => { arrived = resolve; }), cookies: string[] = [];
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') { success(res); return; }
      if (req.url === '/ajax/favorites/' && mutations++ === 0) { req.resume(); delayed = res; arrived(); return; }
      cookies.push(req.headers.cookie || ''); res.end('{"success":true}');
    });
    const client = authTransport(), query = { ...mutation, url: origin + '/films/123-fixture.html' };
    await client.login(origin, credentials(origin));
    const pending = client.request(origin, query), rejected = expect(pending).rejects.toMatchObject({ code: 'source_changed' });
    await received;
    if (action === 'logout') await client.logout(origin, { mirrorUrl: origin });
    else if (action === 'mirror') await client.selectMirror('https://another.invalid');
    else {
      await client.login(origin, credentials(origin));
      // A lock from the old session must not block a deliberate new-session action.
      await client.request(origin, query);
    }
    delayed.setHeader('Set-Cookie', ['dle_user_id=999; Path=/', 'dle_password=late-obsolete; Path=/', 'PHPSESSID=late-obsolete; Path=/']);
    delayed.end('{"success":true}'); await rejected;
    expect((await client.session(origin)).authenticated).toBe(action === 'login');
    await client.request(origin, { operation: 'favorites', collectionId: '17', page: 1 });
    expect(cookies.at(-1)).toEqual(action === 'login' ? expect.stringContaining('dle_password=fixture-session-token') : '');
    expect(cookies.join(';')).not.toContain('late-obsolete');
  });

  it.each([
    ['{"success":false,"message":{"login_password":"echo fixture account password"}}', 'invalid_credentials'],
    ['{"success":true}', 'auth_session_missing'],
    ['{"success":"true"}', 'auth_response'],
    ['<html><title>Just a moment...</title><form id="challenge-form"></form></html>', 'auth_challenge'],
    ['{"success":false,"captcha":true}', 'auth_challenge'],
  ])('rejects unverified auth responses without leaking raw server messages (%s)', async (body, code) => {
    const origin = await fixture((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
    const client = authTransport();
    await expect(client.login(origin, credentials(origin))).rejects.toMatchObject({ code, message: expect.not.stringContaining('fixture account password') });
    expect(await client.session(origin)).toEqual({ authenticated: false, origin });
  });

  it('rejects HTTP credentials by default and rejects a stale mirror before sending anything', async () => {
    let count = 0;
    const origin = await fixture((_req, res) => { count++; success(res); });
    await expect(transport().login(origin, credentials(origin))).rejects.toMatchObject({ code: 'auth_https_required' });
    await expect(authTransport().login(origin, credentials('https://another.invalid'))).rejects.toMatchObject({ code: 'source_changed' });
    expect(count).toBe(0);
  });

  it('never forwards login credentials or cookies to a redirect at a different origin', async () => {
    let stolen = 0;
    const other = await fixture((_req, res) => { stolen++; success(res); });
    const origin = await fixture((_req, res) => { res.writeHead(307, { Location: other + '/sink', 'Set-Cookie': accountCookies }); res.end(); });
    const client = authTransport();
    await expect(client.login(origin, credentials(origin))).rejects.toMatchObject({ code: 'source_redirect_origin' });
    expect(stolen).toBe(0);
    expect((await client.session(origin)).authenticated).toBe(false);
  });

  it('clears expired account cookies on an explicit login page but does not turn a generic 403 into login', async () => {
    let protectedPage = false;
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') success(res);
      else if (protectedPage) res.end(loginPage);
      else { res.writeHead(403); res.end('Forbidden'); }
    });
    const sessionPath = join(await tempDirectory(), 'source-session.json'), client = authTransport({ sessionPath });
    await client.login(origin, credentials(origin));
    await expect(client.request(origin, catalog)).rejects.toMatchObject({ code: 'source_http_403' });
    expect((await client.session(origin)).authenticated).toBe(true);
    protectedPage = true;
    await expect(client.request(origin, catalog)).rejects.toMatchObject({ code: 'auth_required' });
    expect((await client.session(origin)).authenticated).toBe(false);
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('logout deletes stored credentials and a different mirror receives no cookies', async () => {
    const cookies: string[] = [];
    const origin = await fixture((req, res) => { if (req.url === '/ajax/login/') success(res); else { cookies.push(req.headers.cookie || ''); res.end('catalog'); } });
    const other = await fixture((req, res) => { cookies.push(req.headers.cookie || ''); res.end('other'); });
    const sessionPath = join(await tempDirectory(), 'source-session.json'), client = authTransport({ sessionPath });
    await client.login(origin, credentials(origin));
    expect(await client.logout(origin, { mirrorUrl: origin })).toEqual({ authenticated: false, origin });
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await client.request(origin, catalog);
    await client.login(origin, credentials(origin));
    await client.request(other, catalog);
    await client.request(origin, catalog);
    expect(cookies).toEqual(['', '', '']);
  });

  it.each(['logout', 'mirror'] as const)('an outstanding login cannot restore a session after %s', async (action) => {
    let response!: ServerResponse, received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const origin = await fixture((_req, res) => { response = res; received(); });
    const sessionPath = join(await tempDirectory(), 'source-session.json'), client = authTransport({ sessionPath });
    const pending = client.login(origin, credentials(origin));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'source_changed' });
    await arrived;
    if (action === 'logout') await client.logout(origin, { mirrorUrl: origin });
    else await client.selectMirror('https://another.invalid');
    success(response); await rejected;
    expect((await client.session(origin)).authenticated).toBe(false);
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an outstanding source response cannot resurrect cookies cleared by logout', async () => {
    let delayed!: ServerResponse, received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const origin = await fixture((req, res) => {
      if (req.url === '/ajax/login/') success(res);
      else { delayed = res; received(); }
    });
    const sessionPath = join(await tempDirectory(), 'source-session.json'), client = authTransport({ sessionPath });
    await client.login(origin, credentials(origin));
    const pending = client.request(origin, catalog), rejected = expect(pending).rejects.toMatchObject({ code: 'source_changed' });
    await arrived;
    await client.logout(origin, { mirrorUrl: origin });
    delayed.setHeader('Set-Cookie', accountCookies); delayed.end('catalog'); await rejected;
    expect((await client.session(origin)).authenticated).toBe(false);
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks the configured mirror again before accepting an outstanding login', async () => {
    let delayed!: ServerResponse, received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const origin = await fixture((_req, res) => { delayed = res; received(); });
    const core = await createRuntime(await tempDirectory()); cleanup.push(() => core.close());
    await core.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, mirrorUrl: origin } });
    const client = authTransport();
    const pending = sourceLogin(core, client, credentials(origin));
    await arrived;
    await core.saveSettings({ expectedRevision: 1, values: { ...defaultSettings, mirrorUrl: 'https://another.invalid' } });
    success(delayed);
    expect(await pending).toMatchObject({ returnValue: false, errorCode: 'source_changed' });
    expect(await getSourceSession(core, client)).toEqual({ returnValue: true, session: { authenticated: false, origin: 'https://another.invalid' } });
  });

  it('LAN A → B → A mirror changes revoke a persisted session through the production bridge runtime', async () => {
    const origin = await fixture((_req, res) => success(res));
    const directory = await tempDirectory(), sessionPath = join(directory, 'source-session.json');
    const seeded = authTransport({ sessionPath });
    await seeded.login(origin, credentials(origin)); seeded.close();
    const core = await createRuntime(directory);
    await core.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, mirrorUrl: origin } });
    await core.close();
    const bridge = createDevMiddleware(directory); cleanup.push(() => bridge.close());
    const bridgeOrigin = await fixture((req, res) => bridge.handle(req, res, () => { res.writeHead(404); res.end(); }));
    expect((await postBridge(bridgeOrigin, {}, {}, 'getSourceSession')).value).toMatchObject({ session: { authenticated: true } });
    const setup = (await postBridge(bridgeOrigin, {}, {}, 'startSetup')).value.setup as { urls: string[]; pin: string };
    const url = setup.urls.find(value => value.includes('127.0.0.1')) ?? setup.urls[0];
    const base = new URL(url).origin;
    const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: setup.pin }) });
    const { token } = await paired.json() as { token: string };
    for (const [index, mirrorUrl] of ['https://another.invalid', origin].entries()) {
      const response = await fetch(base + '/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: index + 1, values: { ...defaultSettings, mirrorUrl } }) });
      expect(response.status).toBe(200);
    }
    expect((await postBridge(bridgeOrigin, {}, {}, 'getSourceSession')).value).toEqual({ returnValue: true, session: { authenticated: false, origin } });
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('LAN A → B → A invalidates a pending login even though the final mirror matches its request', async () => {
    let delayed!: ServerResponse, received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const origin = await fixture((_req, res) => { delayed = res; received(); });
    const directory = await tempDirectory(), sessionPath = join(directory, 'source-session.json'), client = authTransport({ sessionPath });
    const core = await createRuntime(directory, { bindHost: '127.0.0.1', onMirrorChange: mirror => client.selectMirror(mirror, true) });
    cleanup.push(() => core.close());
    await core.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, mirrorUrl: origin } });
    const pending = sourceLogin(core, client, credentials(origin));
    await arrived;
    const setupReply = await core.startSetup();
    if (!setupReply.returnValue || !setupReply.setup) throw new Error('Setup failed');
    const setup = setupReply.setup, base = new URL(setup.urls[0]).origin;
    const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: setup.pin }) });
    const { token } = await paired.json() as { token: string };
    for (const [index, mirrorUrl] of ['https://another.invalid', origin].entries()) {
      const response = await fetch(base + '/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: index + 1, values: { ...defaultSettings, mirrorUrl } }) });
      expect(response.status).toBe(200);
    }
    success(delayed);
    expect(await pending).toMatchObject({ returnValue: false, errorCode: 'source_changed' });
    expect(await getSourceSession(core, client)).toEqual({ returnValue: true, session: { authenticated: false, origin } });
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes auth only through the origin-checked development bridge, never the LAN setup routes', async () => {
    const directory = await tempDirectory(), core = await createRuntime(directory, { bindHost: '127.0.0.1' }); cleanup.push(() => core.close());
    await core.saveSettings({ expectedRevision: 0, values: { ...defaultSettings, mirrorUrl: 'https://fixture.invalid' } });
    const bridge = createDevMiddleware(directory); cleanup.push(() => bridge.close());
    const origin = await fixture((req, res) => bridge.handle(req, res, () => { res.writeHead(404); res.end(); }));
    expect(await postBridge(origin, {}, {}, 'getSourceSession')).toMatchObject({ status: 200, value: { returnValue: true, session: { authenticated: false, origin: 'https://fixture.invalid' } } });
    expect(await postBridge(origin, credentials('https://fixture.invalid'), { Origin: 'https://foreign.invalid' }, 'sourceLogin')).toMatchObject({ status: 403 });
    const setup = await core.startSetup();
    if (!setup.returnValue || !setup.setup) throw new Error('Setup failed');
    const url = new URL(setup.setup.urls[0]).origin;
    const pair = await fetch(url + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: setup.setup.pin }) });
    const { token } = await pair.json() as { token: string };
    for (const path of ['/api/sourceLogin', '/api/getSourceSession', '/api/sourceLogout']) {
      expect((await fetch(url + path, { headers: { Authorization: 'Bearer ' + token } })).status).toBe(404);
    }
  });
});

describe('source platform bridge', () => {
  it('uses the native app service and allows 20 seconds for source requests', async () => {
    vi.useFakeTimers();
    let native: { onservicecallback: (value: string) => void; call: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
    class Bridge {
      onservicecallback = (_value: string) => {};
      call = vi.fn(); cancel = vi.fn();
      constructor() { native = this; }
    }
    vi.stubGlobal('window', { PalmServiceBridge: Bridge, setTimeout, navigator: { userAgent: 'webOS' } });
    vi.stubGlobal('fetch', vi.fn());
    const pending = sourceRequest(catalog);
    const rejected = expect(pending).rejects.toThrow('Проверьте зеркало');
    expect(native!.call).toHaveBeenCalledWith('luna://ru.kamilov.rezzka.service/getSource', JSON.stringify(catalog));
    await vi.advanceTimersByTimeAsync(10000);
    expect(native!.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(native!.cancel).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
