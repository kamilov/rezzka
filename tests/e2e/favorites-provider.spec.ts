import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Favorites from '../../src/provider-favorites';
import type * as Provider from '../../src/provider';
import type { SourceDocument, SourceRequest, TitleSummary } from '../../shared/source';

type HarnessWindow = Window & typeof globalThis & {
  favorites: typeof Favorites; provider: typeof Provider; favoritesFixtureExecuted?: boolean;
  pendingUpdate?: Promise<unknown>; authEvents?: number;
};
const origin = 'https://mirror.example';
const title: TitleSummary = { id: '701', url: origin + '/films/drama/701-first.html', title: 'Первый фильм', kind: 'film', poster: '' };
const fixture = async (name: string, url = origin + '/favorites/'): Promise<SourceDocument> => ({ body: await readFile(new URL(`../fixtures/provider/${name}`, import.meta.url), 'utf8'), url });
const reply = (route: Route, source: SourceDocument) => route.fulfill({ json: { returnValue: true, source } });
const denied = (route: Route, errorCode: string) => route.fulfill({ json: { returnValue: false, errorCode, errorText: 'Синтетическая ошибка источника.' } });
const toggleReply = (route: Route, value: unknown = { success: true }) => reply(route, { body: JSON.stringify(value), url: origin + '/ajax/favorites/' });
const membershipFixture = async (selected: boolean) => {
  const source = await fixture('favorites-membership.html', title.url);
  if (selected) source.body = source.body.replace('value="11">', 'value="11" checked>');
  return source;
};
const withCollections = (source: SourceDocument, items: { id: string; name: string }[]): SourceDocument => ({ ...source,
  body: source.body.replace('</div></div>', items.map(item => `<div class="hd-label-row"><input type="checkbox" class="user-fav-check" value="${item.id}"><label>${item.name}<small>(<b>0</b>)</small></label></div>`).join('') + '</div></div>'),
});
async function bridge(page: Page, handler: (route: Route, query: SourceRequest) => Promise<void>) {
  const requests: SourceRequest[] = [];
  await page.route('**/__bridge', async route => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: SourceRequest };
    expect(method).toBe('getSource'); requests.push(params); await handler(route, params);
  });
  return requests;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/provider/harness.html');
  await page.waitForFunction(() => Boolean((window as HarnessWindow).provider));
  await page.evaluate(async () => {
    const modulePath = '/src/provider-favorites.ts';
    (window as HarnessWindow).favorites = await import(/* @vite-ignore */ modulePath) as typeof Favorites;
  });
});

test('favorites scopes cards and pagination to the active account collection', async ({ page }) => {
  const first = await page.evaluate(source => (window as HarnessWindow).favorites.parseFavorites(source), await fixture('favorites.html'));
  expect(first.collections).toEqual([{ id: '11', name: 'Посмотреть позже', count: 3 }, { id: '22', name: 'Для вечера', count: 1 }]);
  expect(first.selectedCollectionId).toBe('11');
  expect(first.items.map(item => item.id)).toEqual(['701', '702']);
  expect(first.nextPage).toBe(2);
  const last = await page.evaluate(source => (window as HarnessWindow).favorites.parseFavorites(source, 2, '11'), await fixture('favorites-page-2.html', origin + '/favorites/11/page/2/?filter=added'));
  expect(last.items.map(item => item.id)).toEqual(['703']);
  expect(last.nextPage).toBeUndefined();
  expect(await page.evaluate(source => {
    try { (window as HarnessWindow).favorites.parseFavorites(source, 2, '11'); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, await fixture('favorites.html', origin + '/favorites/11/'))).toBe('markup');
  expect(await page.evaluate(() => (window as HarnessWindow).favoritesFixtureExecuted)).toBeUndefined();
});

test('explicit empty pages and no collections differ from unavailable, login and malformed data', async ({ page }) => {
  expect((await page.evaluate(source => (window as HarnessWindow).favorites.parseFavorites(source), await fixture('favorites-empty.html'))).items).toEqual([]);
  expect(await page.evaluate(source => (window as HarnessWindow).favorites.parseFavorites(source), await fixture('favorites-no-collections.html'))).toEqual({ collections: [], items: [] });
  const code = (source: SourceDocument, requested?: string) => page.evaluate(({ source, requested }) => {
    try { (window as HarnessWindow).favorites.parseFavorites(source, 1, requested); return 'no-error'; }
    catch (error) { return (error as { code: string }).code; }
  }, { source, requested });
  expect(await code(await fixture('login.html'))).toBe('authentication');
  expect(await code(await fixture('challenge.html'))).toBe('challenge');
  expect(await code(await fixture('favorites.html'), '22')).toBe('markup');
  expect(await code(await fixture('favorites-no-collections.html'), '11')).toBe('markup');
  const source = await fixture('favorites.html');
  for (const body of [
    '<h1>Сервис недоступен</h1>',
    source.body.replace('href="/favorites/11/"', 'href="https://other.example/favorites/11/"'),
    source.body.replace('href="/favorites/11/"', 'href="/favorites/11/?action=remove_cat"'),
    source.body.replace('data-cat_id="11"', 'data-cat_id="1234567890123"'),
    source.body.replace('cats_list_link active', 'cats_list_link'),
    source.body.replace('class="b-content__inline_items b-favorites_content__holder"', 'class="unrecognized-holder"'),
  ]) expect(await code({ ...source, body })).toBe('markup');
});

test('membership comes only from the requested title holder and preserves each collection state', async ({ page }) => {
  const source = await membershipFixture(false);
  const result = await page.evaluate(({ source, title }) => (window as HarnessWindow).favorites.parseFavoriteMembership(source, title), { source, title });
  expect(result).toEqual([{ id: '11', name: 'Посмотреть позже', selected: false }, { id: '22', name: 'Для вечера', selected: true }]);
  for (const body of [source.body.replace('id="user-favorites-holder" data-post_id="701"', 'id="user-favorites-holder" data-post_id="702"'), source.body.replace('id="user-favorites-list"', 'id="unknown-list"'), source.body.replace('value="11"', 'value="0"')]) {
    expect(await page.evaluate(({ source, title }) => {
      try { (window as HarnessWindow).favorites.parseFavoriteMembership(source, title); return 'no-error'; }
      catch (error) { return (error as { code: string }).code; }
    }, { source: { ...source, body }, title })).toBe('markup');
  }
});

test('loadFavorites forwards its default or selected collection and page', async ({ page }) => {
  const first = await fixture('favorites.html'), second = await fixture('favorites-page-2.html', origin + '/favorites/11/page/2/?filter=added');
  const requests = await bridge(page, (route, query) => reply(route, query.operation === 'favorites' && query.page === 2 ? second : first));
  await page.evaluate(async () => { await (window as HarnessWindow).favorites.loadFavorites(); await (window as HarnessWindow).favorites.loadFavorites({ collectionId: '11', page: 2 }); });
  expect(requests).toEqual([{ operation: 'favorites', page: 1 }, { operation: 'favorites', collectionId: '11', page: 2 }]);
});

test('adding and removing use a fresh read, one toggle and a verifying read; the desired state skips toggling', async ({ page }) => {
  let selected = false;
  const unchecked = await membershipFixture(false), checked = await membershipFixture(true);
  const requests = await bridge(page, async (route, query) => {
    if (query.operation === 'details') await reply(route, selected ? checked : unchecked);
    else if (query.operation === 'favoriteToggle') { selected = !selected; await toggleReply(route); }
    else throw new Error('Unexpected fixture operation');
  });
  const results = await page.evaluate(async title => {
    const api = (window as HarnessWindow).favorites;
    return [await api.setFavoriteMembership(title, '11', true), await api.setFavoriteMembership(title, '11', true), await api.setFavoriteMembership(title, '11', false)];
  }, title);
  expect(results.map(items => items.find(item => item.id === '11')?.selected)).toEqual([true, true, false]);
  expect(requests.map(request => request.operation)).toEqual(['details', 'favoriteToggle', 'details', 'details', 'details', 'favoriteToggle', 'details']);
  expect(requests.filter(request => request.operation === 'favoriteToggle')).toEqual(Array(2).fill({ operation: 'favoriteToggle', url: title.url, id: '701', collectionId: '11' }));
});

test('an explicit refusal is reported as plain text with verified membership', async ({ page }) => {
  const source = await membershipFixture(false);
  const requests = await bridge(page, (route, query) => query.operation === 'details' ? reply(route, source) : toggleReply(route, { success: false, message: '<b>Раздел закрыт</b><script>window.favoritesFixtureExecuted=true</script>' }));
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.setFavoriteMembership(title, '11', true); return null; }
    catch (error) { const value = error as Favorites.FavoriteUpdateError; return { name: value.name, message: value.message, memberships: value.memberships }; }
  }, title);
  expect(result).toMatchObject({ name: 'FavoriteUpdateError', message: 'Источник отказал в изменении: Раздел закрыт' });
  expect(result?.memberships?.find(item => item.id === '11')?.selected).toBe(false);
  expect(requests.map(request => request.operation)).toEqual(['details', 'favoriteToggle', 'details']);
  expect(await page.evaluate(() => (window as HarnessWindow).favoritesFixtureExecuted)).toBeUndefined();
});

for (const outcome of ['applied', 'unchanged', 'unreadable'] as const) {
  test(`uncertain toggle is checked only by reading: ${outcome}`, async ({ page }) => {
    let reads = 0;
    const before = await membershipFixture(false), after = await membershipFixture(outcome === 'applied');
    const requests = await bridge(page, async (route, query) => {
      if (query.operation === 'favoriteToggle') { await denied(route, 'source_mutation_unconfirmed'); return; }
      if (++reads === 1) await reply(route, before);
      else if (outcome === 'unreadable') await denied(route, 'source_network');
      else await reply(route, after);
    });
    const result = await page.evaluate(async title => {
      try { return { success: true, memberships: await (window as HarnessWindow).favorites.setFavoriteMembership(title, '11', true) }; }
      catch (error) { const value = error as Favorites.FavoriteUpdateError; return { success: false, name: value.name, memberships: value.memberships }; }
    }, title);
    expect(requests.map(request => request.operation)).toEqual(['details', 'favoriteToggle', 'details']);
    expect(result.success).toBe(outcome === 'applied');
    if (outcome === 'unreadable') expect(result.memberships).toBeUndefined();
    else expect(result.memberships?.find(item => item.id === '11')?.selected).toBe(outcome === 'applied');
  });
}

for (const heldOperation of ['details', 'favoriteToggle'] as const) {
  test(`changing the source generation while ${heldOperation} is pending prevents every later request`, async ({ page }) => {
    const source = await membershipFixture(false);
    let pending: Route | undefined;
    const requests = await bridge(page, async (route, query) => {
      if (query.operation === heldOperation && !pending) { pending = route; return; }
      await reply(route, source);
    });
    await page.evaluate(title => {
      const state = window as HarnessWindow;
      state.pendingUpdate = state.favorites.setFavoriteMembership(title, '11', true).then(() => ({ success: true }), error => ({ success: false, name: error.name, memberships: error.memberships }));
    }, title);
    await expect.poll(() => Boolean(pending)).toBe(true);
    await page.evaluate(() => (window as HarnessWindow).provider.resetProviderSession());
    if (heldOperation === 'details') await reply(pending!, source); else await toggleReply(pending!);
    const result = await page.evaluate(() => (window as HarnessWindow).pendingUpdate);
    expect(result).toEqual({ success: false, name: 'FavoriteUpdateError', memberships: undefined });
    expect(requests.map(request => request.operation)).toEqual(heldOperation === 'details' ? ['details'] : ['details', 'favoriteToggle']);
  });
}

test('concurrent actions for one title are rejected before any second read or toggle', async ({ page }) => {
  const unchecked = await membershipFixture(false), checked = await membershipFixture(true);
  let pending: Route | undefined, reads = 0;
  const requests = await bridge(page, async (route, query) => {
    if (query.operation === 'favoriteToggle') { await toggleReply(route); return; }
    if (++reads === 1) { pending = route; return; }
    await reply(route, checked);
  });
  await page.evaluate(title => { (window as HarnessWindow).pendingUpdate = (window as HarnessWindow).favorites.setFavoriteMembership(title, '11', true); }, title);
  await expect.poll(() => Boolean(pending)).toBe(true);
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.setFavoriteMembership(title, '11', false); return 'no-error'; }
    catch (error) { return (error as Error).name; }
  }, title);
  expect(result).toBe('FavoriteUpdateError');
  expect(requests).toHaveLength(1);
  await reply(pending!, unchecked);
  await page.evaluate(() => (window as HarnessWindow).pendingUpdate);
  expect(requests.map(request => request.operation)).toEqual(['details', 'favoriteToggle', 'details']);
});

test('authentication failure opens the shared gate without another verification request', async ({ page }) => {
  const source = await membershipFixture(false);
  const requests = await bridge(page, (route, query) => query.operation === 'details' ? reply(route, source) : denied(route, 'auth_required'));
  await page.evaluate(() => { const state = window as HarnessWindow; state.authEvents = 0; state.provider.subscribeToSourceAuth(() => { state.authEvents!++; }); });
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.setFavoriteMembership(title, '11', true); return null; }
    catch (error) { return (error as { code?: string }).code; }
  }, title);
  expect(result).toBe('auth_required');
  expect(await page.evaluate(() => (window as HarnessWindow).authEvents)).toBe(1);
  expect(requests.map(request => request.operation)).toEqual(['details', 'favoriteToggle']);
});

test('creating a list trims the name, verifies its new response ID, and never adds the current title', async ({ page }) => {
  const before = withCollections(await membershipFixture(false), [{ id: '33', name: 'Выходные' }]);
  const after = withCollections(before, [{ id: '44', name: 'Выходные · принятое источником имя' }, { id: '55', name: 'Выходные' }]);
  let reads = 0;
  const requests = await bridge(page, (route, query) => query.operation === 'favoriteCreate'
    ? toggleReply(route, { success: true, id: 44, name: 'Выходные' })
    : reply(route, ++reads === 1 ? before : after));
  const result = await page.evaluate(title => (window as HarnessWindow).favorites.createFavoriteCollection(title, '  Выходные  '), title);
  expect(result.collectionId).toBe('44');
  expect(result.memberships.find(item => item.id === '44')?.selected).toBe(false);
  expect(requests).toEqual([{ operation: 'details', url: title.url }, { operation: 'favoriteCreate', url: title.url, id: title.id, name: 'Выходные' }, { operation: 'details', url: title.url }]);
});

test('empty, long, and control-containing names are rejected before any source request', async ({ page }) => {
  const requests = await bridge(page, route => denied(route, 'unexpected_request'));
  const errors = await page.evaluate(async title => {
    const errors: string[] = [];
    for (const name of ['  ', 'а'.repeat(101), 'Строка\nдругая', '\nНазвание', 'Название\t', 'Название\u0000']) {
      try { await (window as HarnessWindow).favorites.createFavoriteCollection(title, name); errors.push('no-error'); }
      catch (error) { errors.push((error as Error).name); }
    }
    return errors;
  }, title);
  expect(errors).toEqual(Array(6).fill('FavoriteUpdateError'));
  expect(requests).toEqual([]);
});

for (const outcome of ['applied', 'unchanged', 'unreadable', 'ambiguous'] as const) {
  test(`uncertain creation is reconciled only from new collection IDs: ${outcome}`, async ({ page }) => {
    const before = withCollections(await membershipFixture(false), [{ id: '33', name: 'Новый список' }]);
    const after = withCollections(before, outcome === 'applied' ? [{ id: '44', name: 'Новый список' }] : outcome === 'ambiguous' ? [{ id: '44', name: 'Новый список' }, { id: '55', name: 'Новый список' }] : []);
    let reads = 0;
    const requests = await bridge(page, (route, query) => {
      if (query.operation === 'favoriteCreate') return denied(route, 'source_mutation_unconfirmed');
      if (++reads === 1) return reply(route, before);
      return outcome === 'unreadable' ? denied(route, 'source_network') : reply(route, after);
    });
    const result = await page.evaluate(async title => {
      try { return { success: true, ...await (window as HarnessWindow).favorites.createFavoriteCollection(title, 'Новый список') }; }
      catch (error) { const value = error as Favorites.FavoriteUpdateError; return { success: false, creationUncertain: value.creationUncertain, memberships: value.memberships }; }
    }, title);
    expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate', 'details']);
    expect(result.success).toBe(outcome === 'applied');
    if (result.success) expect('collectionId' in result && result.collectionId).toBe('44');
    else {
      expect('creationUncertain' in result && result.creationUncertain).toBe(true);
      expect(result.memberships?.length).toBe(outcome === 'unreadable' ? undefined : outcome === 'ambiguous' ? 5 : 3);
    }
  });
}

test('a repeated uncertain name only reads until the original new ID appears', async ({ page }) => {
  const before = withCollections(await membershipFixture(false), [{ id: '33', name: 'Выходные' }]);
  const after = withCollections(before, [{ id: '44', name: 'Выходные' }]);
  let reads = 0;
  const requests = await bridge(page, (route, query) => query.operation === 'favoriteCreate'
    ? denied(route, 'source_mutation_unconfirmed') : reply(route, ++reads < 4 ? before : after));
  const results = await page.evaluate(async title => {
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try { results.push(await (window as HarnessWindow).favorites.createFavoriteCollection(title, ' Выходные ')); }
      catch (error) { results.push({ creationUncertain: (error as Favorites.FavoriteUpdateError).creationUncertain }); }
    }
    return results;
  }, title);
  expect(results).toMatchObject([{ creationUncertain: true }, { creationUncertain: true }, { collectionId: '44' }]);
  expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate', 'details', 'details', 'details']);
});

test('an existing response ID cannot confirm a newly created list with the same name', async ({ page }) => {
  const before = withCollections(await membershipFixture(false), [{ id: '33', name: 'Выходные' }]);
  const after = withCollections(before, [{ id: '44', name: 'Выходные' }]);
  let reads = 0;
  const requests = await bridge(page, (route, query) => query.operation === 'favoriteCreate'
    ? toggleReply(route, { success: true, id: '33' }) : reply(route, ++reads === 1 ? before : after));
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.createFavoriteCollection(title, 'Выходные'); return null; }
    catch (error) { const value = error as Favorites.FavoriteUpdateError; return { creationUncertain: value.creationUncertain, count: value.memberships?.length }; }
  }, title);
  expect(result).toEqual({ creationUncertain: true, count: 4 });
  expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate', 'details']);
});

test('a refused creation reports safe text and keeps verified membership without an uncertain marker', async ({ page }) => {
  const source = await membershipFixture(false);
  const requests = await bridge(page, (route, query) => query.operation === 'favoriteCreate'
    ? toggleReply(route, { success: false, message: '<b>Слишком много списков</b><script>window.favoritesFixtureExecuted=true</script>' }) : reply(route, source));
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.createFavoriteCollection(title, 'Выходные'); return null; }
    catch (error) { const value = error as Favorites.FavoriteUpdateError; return { message: value.message, creationUncertain: value.creationUncertain, count: value.memberships?.length }; }
  }, title);
  expect(result).toEqual({ message: 'Источник отказал в создании: Слишком много списков', creationUncertain: false, count: 2 });
  expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate', 'details']);
  expect(await page.evaluate(() => (window as HarnessWindow).favoritesFixtureExecuted)).toBeUndefined();
});

for (const phase of ['before', 'create', 'after'] as const) {
  test(`changing generation during the ${phase} creation request prevents all later requests`, async ({ page }) => {
    const before = await membershipFixture(false), after = withCollections(before, [{ id: '44', name: 'Выходные' }]);
    let reads = 0, pending: Route | undefined;
    const requests = await bridge(page, async (route, query) => {
      if (query.operation === 'details') reads++;
      if (!pending && ((phase === 'before' && reads === 1) || (phase === 'create' && query.operation === 'favoriteCreate') || (phase === 'after' && reads === 2))) { pending = route; return; }
      if (query.operation === 'favoriteCreate') await toggleReply(route, { success: true, id: '44' }); else await reply(route, before);
    });
    await page.evaluate(title => {
      const state = window as HarnessWindow;
      state.pendingUpdate = state.favorites.createFavoriteCollection(title, 'Выходные').then(() => 'success', error => error.name);
    }, title);
    await expect.poll(() => Boolean(pending)).toBe(true);
    await page.evaluate(() => (window as HarnessWindow).provider.resetProviderSession());
    if (phase === 'create') await toggleReply(pending!, { success: true, id: '44' }); else await reply(pending!, phase === 'after' ? after : before);
    expect(await page.evaluate(() => (window as HarnessWindow).pendingUpdate)).toBe('FavoriteUpdateError');
    expect(requests.map(query => query.operation)).toEqual(phase === 'before' ? ['details'] : phase === 'create' ? ['details', 'favoriteCreate'] : ['details', 'favoriteCreate', 'details']);
  });
}

test('creation blocks concurrent creation across titles and membership changes for the current title', async ({ page }) => {
  const before = await membershipFixture(false), after = withCollections(before, [{ id: '44', name: 'Выходные' }]);
  let reads = 0, pending: Route | undefined;
  const requests = await bridge(page, async (route, query) => {
    if (query.operation === 'favoriteCreate') { await toggleReply(route, { success: true, id: '44' }); return; }
    if (++reads === 1) { pending = route; return; }
    await reply(route, after);
  });
  await page.evaluate(title => { (window as HarnessWindow).pendingUpdate = (window as HarnessWindow).favorites.createFavoriteCollection(title, 'Выходные'); }, title);
  await expect.poll(() => Boolean(pending)).toBe(true);
  const errors = await page.evaluate(async title => {
    const api = (window as HarnessWindow).favorites, errors: string[] = [];
    try { await api.createFavoriteCollection({ ...title, id: '702', url: title.url.replace('701-first', '702-second') }, 'Ещё один'); }
    catch (error) { errors.push((error as Error).name); }
    try { await api.setFavoriteMembership(title, '11', true); }
    catch (error) { errors.push((error as Error).name); }
    return errors;
  }, title);
  expect(errors).toEqual(['FavoriteUpdateError', 'FavoriteUpdateError']);
  expect(requests).toHaveLength(1);
  await reply(pending!, before);
  await page.evaluate(() => (window as HarnessWindow).pendingUpdate);
  expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate', 'details']);
});

test('creation authentication failure reaches the shared gate and never retries or verifies', async ({ page }) => {
  const source = await membershipFixture(false);
  const requests = await bridge(page, (route, query) => query.operation === 'favoriteCreate' ? denied(route, 'auth_required') : reply(route, source));
  await page.evaluate(() => { const state = window as HarnessWindow; state.authEvents = 0; state.provider.subscribeToSourceAuth(() => { state.authEvents!++; }); });
  const result = await page.evaluate(async title => {
    try { await (window as HarnessWindow).favorites.createFavoriteCollection(title, 'Выходные'); return null; }
    catch (error) { return (error as { code?: string }).code; }
  }, title);
  expect(result).toBe('auth_required');
  expect(await page.evaluate(() => (window as HarnessWindow).authEvents)).toBe(1);
  expect(requests.map(query => query.operation)).toEqual(['details', 'favoriteCreate']);
});
