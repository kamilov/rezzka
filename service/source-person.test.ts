import { afterEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSourceTransport, validateSourceRequest } from './source';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}
function transport() {
  const client = createSourceTransport(); cleanup.push(() => client.close()); return client;
}

it('reads source person routes as bounded GETs without an account or request body', async () => {
  const seen: Array<{ method: string; path: string; body: string }> = [];
  const origin = await fixture((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ method: req.method!, path: req.url!, body }); res.end('<h1>Персона</h1>'); });
  });
  const client = transport();
  for (const path of ['/person/3932-morgan-friman/', '/person/410-legacy.html', '/person/99/']) {
    expect(await client.request(origin, { operation: 'person', url: origin + path })).toEqual({ url: origin + path, body: '<h1>Персона</h1>' });
  }
  expect(seen).toEqual([
    { method: 'GET', path: '/person/3932-morgan-friman/', body: '' },
    { method: 'GET', path: '/person/410-legacy.html', body: '' },
    { method: 'GET', path: '/person/99/', body: '' },
  ]);
  expect((await client.session(origin)).authenticated).toBe(false);
});

it('rejects malformed person routes and unexpected parameters before any network request', async () => {
  const seen: string[] = [], origin = await fixture((req, res) => { seen.push(req.url!); res.end('unexpected'); });
  const client = transport(), valid = origin + '/person/41-name/';
  const urls: unknown[] = [
    undefined, 41, '', '/person/41-name/', 'javascript:alert(1)', 'file:///person/41-name/',
    origin + '/films/41-name.html', origin + '/person/0-name/', origin + '/person/01-name/',
    origin + '/person/' + '1'.repeat(13) + '-name/', origin + '/person/41-name',
    origin + '/person/41-name/nested/', valid + '?action=remove', valid + '#part', valid + '\n',
    origin + '/person/41-name%2Fextra/', origin + '/person/41-name%5Cextra/',
    origin.replace('http://', 'http://user:password@') + '/person/41-name/',
    origin + '/person\\41-name/', 'https://example.invalid/person/41-' + 'a'.repeat(2048) + '/',
  ];
  for (const url of urls) await expect(client.request(origin, { operation: 'person', url })).rejects.toMatchObject({ code: 'invalid_source_request' });
  for (const extra of [{ page: 2 }, { id: '41' }, { action: 'delete' }]) {
    expect(() => validateSourceRequest({ operation: 'person', url: valid, ...extra })).toThrow();
  }
  expect(seen).toEqual([]);
});

it('binds person reads and redirects to the configured source origin', async () => {
  let externalRequests = 0;
  const external = await fixture((_req, res) => { externalRequests++; res.end('outside'); });
  const origin = await fixture((_req, res) => { res.writeHead(302, { Location: external + '/person/41-name/' }); res.end(); });
  const client = transport();
  await expect(client.request(origin, { operation: 'person', url: external + '/person/41-name/' })).rejects.toMatchObject({ code: 'source_origin' });
  await expect(client.request(origin, { operation: 'person', url: origin + '/person/41-name/' })).rejects.toMatchObject({ code: 'source_redirect_origin' });
  expect(externalRequests).toBe(0);
});
