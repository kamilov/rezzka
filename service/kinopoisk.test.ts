import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKinopoisk, type KinopoiskOptions } from './kinopoisk';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const oldKey = 'fixture-old-key', newKey = 'fixture-new-key';
type Call = { url: URL; init: RequestInit; headers: Headers };
const profile = (id = 41, extra: Record<string, unknown> = {}) => ({ personId: id, nameRu: 'Алексей Смирнов', nameEn: 'Alexey Smirnov', facts: [], birthday: '1980-02-01', profession: 'Актёр, Режиссёр', ...extra });
const member = (id = 41, extra: Record<string, unknown> = {}) => ({ staffId: id, nameRu: 'Алексей Смирнов', nameEn: 'Alexey Smirnov', professionKey: 'ACTOR', ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const query = { filmId: '301', name: 'Алексей Смирнов', originalName: 'Alexey Smirnov', profession: 'Актёр', birthDate: '1980-02-01' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>, options: Partial<KinopoiskOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rezzka-kinopoisk-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const calls: Call[] = [], storagePath = join(directory, 'kinopoisk-key.json');
  const fetcher: typeof fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), init, headers: new Headers(init.headers) }; calls.push(call);
    const response = await handler?.(call);
    if (response) return response;
    if (call.url.pathname === '/api/v1/staff/66539') return json(profile(66539));
    if (call.url.pathname === '/api/v1/staff') return json([member()]);
    return json(profile(Number(call.url.pathname.split('/').at(-1))));
  };
  const service = createKinopoisk({ storagePath, fetch: fetcher, ...options });
  cleanup.push(() => service.close());
  return { service, calls, storagePath, fetcher };
}

it('stays offline without a key or an explicit Kinopoisk identifier', async () => {
  const { service, calls } = await fixture();
  expect(await service.status()).toEqual({ configured: false, revision: 0 });
  expect(await service.person(query)).toEqual({ status: 'disabled' });
  expect(calls).toHaveLength(0);
  await service.setKey({ apiKey: oldKey });
  const count = calls.length;
  expect(await service.person({ name: query.name })).toEqual({ status: 'unmatched' });
  expect(calls).toHaveLength(count);
});

it('checks a key over fixed HTTPS with no redirects or cookies and stores it privately', async () => {
  const { service, calls, storagePath, fetcher } = await fixture();
  expect(await service.setKey({ apiKey: oldKey })).toEqual({ configured: true, revision: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0].url.href).toBe('https://kinopoiskapiunofficial.tech/api/v1/staff/66539');
  expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
  expect(calls[0].headers.get('X-API-KEY')).toBe(oldKey);
  expect(calls[0].headers.get('Cookie')).toBeNull();
  expect(calls[0].headers.get('Authorization')).toBeNull();
  expect(calls[0].init.body).toBeUndefined();
  expect((await stat(storagePath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(storagePath, 'utf8'))).toEqual({ schemaVersion: 1, apiKey: oldKey, revision: 1 });
  const reopened = createKinopoisk({ storagePath, fetch: fetcher }); cleanup.push(() => reopened.close());
  expect(await reopened.status()).toEqual({ configured: true, revision: 1 });
  expect(JSON.stringify(await reopened.status())).not.toContain(oldKey);
  await service.setKey({ apiKey: '' });
  expect(await service.status()).toEqual({ configured: false, revision: 2 });
  await expect(stat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await service.person(query)).toEqual({ status: 'disabled' });
});

it.each([[401, 'kinopoisk_invalid_key'], [402, 'kinopoisk_quota'], [403, 'kinopoisk_forbidden'], [429, 'kinopoisk_rate_limit'], [500, 'kinopoisk_unavailable']] as const)('preserves the previous key on HTTP %i and does not expose provider messages', async (status, code) => {
  const { service, storagePath } = await fixture(call => call.headers.get('X-API-KEY') === newKey ? json({ message: `${newKey} account@example.test` }, status) : undefined);
  await service.setKey({ apiKey: oldKey });
  const before = await readFile(storagePath, 'utf8');
  const failure = await service.setKey({ apiKey: newKey }).catch(error => error);
  expect(failure).toMatchObject({ code });
  expect(String(failure)).not.toContain(newKey); expect(String(failure)).not.toContain('account@example.test');
  expect(await readFile(storagePath, 'utf8')).toBe(before);
  expect(await service.status()).toEqual({ configured: true, revision: 1 });
});

it('rejects unknown fields, invalid IDs and injected key headers before network access', async () => {
  const { service, calls } = await fixture();
  for (const input of [null, [], { apiKey: 9 }, { apiKey: oldKey, url: 'https://outside.test' }, { apiKey: 'key\r\nX-Other: value' }]) {
    await expect(service.setKey(input)).rejects.toMatchObject({ code: 'invalid_kinopoisk_request' });
  }
  for (const input of [null, { name: '' }, { ...query, filmId: '0' }, { ...query, filmId: '15000001' }, { ...query, personId: '01' }, { ...query, url: 'https://outside.test' }, { ...query, birthDate: '1980-02-31' }]) {
    await expect(service.person(input)).rejects.toMatchObject({ code: 'invalid_kinopoisk_request' });
  }
  expect(calls).toHaveLength(0);
});

it('matches a unique film participant, deduplicates roles and emits bounded plain metadata', async () => {
  const { service, calls } = await fixture(call => {
    if (call.url.pathname === '/api/v1/staff') return json([member(), member(41, { professionKey: 'DIRECTOR' }), member(42, { nameEn: 'Alexey Other' })]);
    if (call.url.pathname === '/api/v1/staff/41') return json(profile(41, { webUrl: 'javascript:alert(1)', posterUrl: 'https://st.kp.yandex.net/images/actor/41.jpg', growth: 185, hasAwards: 1,
      birthplace: '<a>Москва &amp; область</a>', facts: ['<b>Факт</b><script>secret()</script>', 'Факт', 'Другой &laquo;факт&raquo;'] }));
  });
  await service.setKey({ apiKey: oldKey });
  const result = await service.person(query);
  expect(result).toEqual({ status: 'matched', person: { id: '41', name: query.name, originalName: query.originalName, photo: 'https://st.kp.yandex.net/images/actor/41.jpg', profileUrl: 'https://www.kinopoisk.ru/name/41/',
    facts: [{ label: 'Карьера', value: 'Актёр, Режиссёр' }, { label: 'Дата рождения', value: '01.02.1980' }, { label: 'Место рождения', value: 'Москва & область' }, { label: 'Рост', value: '185 см' }, { label: 'Награды', value: 'Есть' }], trivia: ['Факт', 'Другой «факт»'] } });
  expect(calls.map(call => call.url.pathname + call.url.search)).toEqual(['/api/v1/staff/66539', '/api/v1/staff?filmId=301', '/api/v1/staff/41']);
  expect(JSON.stringify(result)).not.toContain(oldKey);
});

it('does not choose between two different people with identical names and professions', async () => {
  const { service, calls } = await fixture(call => call.url.pathname === '/api/v1/staff' ? json([member(41), member(42), member(41)]) : undefined);
  await service.setKey({ apiKey: oldKey });
  expect(await service.person(query)).toEqual({ status: 'ambiguous' });
  expect(calls).toHaveLength(2);
});

it('uses an exact original name when the API has no Russian name', async () => {
  const { service } = await fixture(call => call.url.pathname === '/api/v1/staff' ? json([member(41, { nameRu: null })])
    : call.url.pathname === '/api/v1/staff/41' ? json(profile(41, { nameRu: null })) : undefined);
  await service.setKey({ apiKey: oldKey });
  expect(await service.person(query)).toMatchObject({ status: 'matched', person: { name: query.originalName } });
});

it('rejects conflicting names, professions, dates and IDs instead of enriching the wrong person', async () => {
  let contents: unknown = [member(41, { professionKey: 'DIRECTOR' })];
  const { service } = await fixture(call => call.url.pathname === '/api/v1/staff' ? json(contents) : call.url.pathname === '/api/v1/staff/44' ? json(profile(45)) : undefined);
  await service.setKey({ apiKey: oldKey });
  expect(await service.person(query)).toEqual({ status: 'unmatched' });
  expect(await service.person({ ...query, personId: '41', originalName: 'Alexey Other' })).toEqual({ status: 'unmatched' });
  expect(await service.person({ ...query, personId: '41', birthDate: '1980-02-02' })).toEqual({ status: 'unmatched' });
  await expect(service.person({ ...query, personId: '44' })).rejects.toMatchObject({ code: 'kinopoisk_response' });
  contents = [member(43, { nameRu: 'Другой человек' })];
  expect(await service.person({ ...query, filmId: '302' })).toEqual({ status: 'unmatched' });
});

it('caches and coalesces film and person reads, expires them after a day and isolates callers', async () => {
  let time = 1000;
  const pending = deferred<Response>(), entered = deferred<void>();
  const { service, calls } = await fixture(call => {
    if (call.url.pathname === '/api/v1/staff' && calls.filter(item => item.url.pathname === '/api/v1/staff').length === 1) { entered.resolve(); return pending.promise; }
  }, { now: () => time });
  await service.setKey({ apiKey: oldKey });
  const first = service.person(query), second = service.person(query);
  await entered.promise; pending.resolve(json([member()]));
  const values = await Promise.all([first, second]);
  expect(calls).toHaveLength(3);
  if (values[0].status === 'matched') values[0].person.name = 'Changed by caller';
  expect(await service.person(query)).toEqual(values[1]);
  expect(calls).toHaveLength(3);
  time += 24 * 60 * 60 * 1000 + 1;
  await service.person(query); expect(calls).toHaveLength(5);
});

it('caps person and film caches instead of retaining an unbounded browsing history', async () => {
  const { service, calls } = await fixture(call => call.url.pathname === '/api/v1/staff' ? json([member()]) : undefined);
  await service.setKey({ apiKey: oldKey });
  for (let id = 1; id <= 65; id++) await service.person({ name: query.name, personId: String(id) });
  let before = calls.length; await service.person({ name: query.name, personId: '1' }); expect(calls).toHaveLength(before + 1);
  for (let id = 1; id <= 129; id++) await service.person({ ...query, filmId: String(id) });
  before = calls.length; await service.person({ ...query, filmId: '1' }); expect(calls).toHaveLength(before + 1);
});

it.each(['delete', 'replace', 'close'] as const)('aborts and rejects old person responses on key %s', async action => {
  const pending = deferred<Response>(), entered = deferred<AbortSignal>();
  const { service } = await fixture(call => {
    if (call.url.pathname === '/api/v1/staff/41') { entered.resolve(call.init.signal!); return pending.promise; }
  });
  await service.setKey({ apiKey: oldKey });
  const work = service.person({ ...query, personId: '41' }).catch(error => error);
  const signal = await entered.promise;
  if (action === 'close') await service.close(); else await service.setKey({ apiKey: action === 'delete' ? '' : newKey });
  expect(signal.aborted).toBe(true);
  pending.resolve(json(profile()));
  expect(await work).toMatchObject({ code: action === 'close' ? 'kinopoisk_closed' : 'kinopoisk_stale' });
  if (action !== 'close') expect(await service.status()).toMatchObject({ configured: action !== 'delete' });
});

it('serializes replacement and deletion without committing an operation reported as stale', async () => {
  const pending = deferred<Response>(), entered = deferred<void>();
  const { service, storagePath } = await fixture(call => {
    if (call.headers.get('X-API-KEY') === newKey) { entered.resolve(); return pending.promise; }
  });
  await service.setKey({ apiKey: oldKey });
  const replacement = service.setKey({ apiKey: newKey });
  await entered.promise;
  const deletion = service.setKey({ apiKey: '' });
  pending.resolve(json(profile(66539)));
  expect(await replacement).toEqual({ configured: true, revision: 2 });
  expect(await deletion).toEqual({ configured: false, revision: 3 });
  expect(await service.status()).toEqual({ configured: false, revision: 3 });
  await expect(stat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('waits for key verification before starting a person request and uses only the committed key', async () => {
  const pending = deferred<Response>(), entered = deferred<void>();
  const { service, calls } = await fixture(call => {
    if (call.url.pathname === '/api/v1/staff/66539' && call.headers.get('X-API-KEY') === newKey) { entered.resolve(); return pending.promise; }
  });
  await service.setKey({ apiKey: oldKey });
  const replacement = service.setKey({ apiKey: newKey });
  await entered.promise;
  const person = service.person({ ...query, personId: '41' });
  await Promise.resolve(); await Promise.resolve();
  expect(calls.filter(call => call.url.pathname === '/api/v1/staff/41')).toHaveLength(0);
  pending.resolve(json(profile(66539))); await replacement;
  expect(await person).toMatchObject({ status: 'matched' });
  expect(calls.filter(call => call.url.pathname === '/api/v1/staff/41').map(call => call.headers.get('X-API-KEY'))).toEqual([newKey]);
});

it('accepts historical birth dates and still rejects nonexistent calendar dates', async () => {
  const historical = { ...query, personId: '41', birthDate: '1564-04-26' };
  const { service } = await fixture(call => call.url.pathname === '/api/v1/staff/41' ? json(profile(41, { birthday: historical.birthDate })) : undefined);
  expect(await service.person(historical)).toEqual({ status: 'disabled' });
  await service.setKey({ apiKey: oldKey });
  expect(await service.person(historical)).toMatchObject({ status: 'matched', person: { facts: expect.arrayContaining([{ label: 'Дата рождения', value: '26.04.1564' }]) } });
  await expect(service.person({ ...historical, birthDate: '1500-02-29' })).rejects.toMatchObject({ code: 'invalid_kinopoisk_request' });
});

it('blocks redirects, oversized responses, malformed JSON and bounded request timeouts', async () => {
  const responses: Array<() => Response | Promise<Response>> = [
    () => new Response(null, { status: 302, headers: { Location: 'https://outside.test/' } }),
    () => new Response('{}', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('{broken'),
    () => new Promise(() => {}),
  ];
  const { service, calls } = await fixture(call => call.url.pathname === '/api/v1/staff/41' ? responses.shift()!() : undefined, { requestTimeoutMs: 30 });
  await service.setKey({ apiKey: oldKey });
  for (const code of ['kinopoisk_unavailable', 'kinopoisk_response', 'kinopoisk_response', 'kinopoisk_response', 'kinopoisk_timeout']) {
    await expect(service.person({ ...query, personId: '41' })).rejects.toMatchObject({ code });
  }
  expect(calls.every(call => call.url.origin === 'https://kinopoiskapiunofficial.tech')).toBe(true);
});

it('uses the total person deadline across staff and profile reads', async () => {
  const { service } = await fixture(async call => {
    if (call.url.pathname === '/api/v1/staff') { await new Promise(resolve => setTimeout(resolve, 35)); return json([member()]); }
    if (call.url.pathname === '/api/v1/staff/41') return new Promise(() => {});
  }, { requestTimeoutMs: 100, personTimeoutMs: 55 });
  await service.setKey({ apiKey: oldKey });
  await expect(service.person(query)).rejects.toMatchObject({ code: 'kinopoisk_timeout' });
});

it('includes pending key verification in the person deadline without cancelling the key save', async () => {
  const pending = deferred<Response>(), entered = deferred<void>();
  const { service, calls } = await fixture(call => {
    if (call.url.pathname === '/api/v1/staff/66539') { entered.resolve(); return pending.promise; }
  }, { personTimeoutMs: 20 });
  const saving = service.setKey({ apiKey: newKey });
  await entered.promise;
  await expect(service.person(query)).rejects.toMatchObject({ code: 'kinopoisk_timeout' });
  expect(calls).toHaveLength(1);
  expect(calls[0].init.signal?.aborted).toBe(false);
  pending.resolve(json(profile(66539)));
  expect(await saving).toEqual({ configured: true, revision: 1 });
  expect(await service.status()).toEqual({ configured: true, revision: 1 });
});

it('does not echo corrupt private storage in errors or make network requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rezzka-kinopoisk-corrupt-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'kinopoisk-key.json'); await writeFile(storagePath, `broken ${oldKey}`);
  const service = createKinopoisk({ storagePath, fetch: async () => { throw new Error('Unexpected network'); } }); cleanup.push(() => service.close());
  const error = await service.status().catch(error => error);
  expect(error).toMatchObject({ code: 'kinopoisk_storage' }); expect(String(error)).not.toContain(oldKey);
});
