import type { FavoriteCollection, FavoriteMembership, FavoritesPage, SourceDocument, TitleSummary } from '../shared/source';
import { documentFrom, getProviderGeneration, isAuthenticationError, parseCatalog, ProviderError, sourceData } from './provider';
import { safeHttpUrl } from './provider-codec';

const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const attr = (node: Element | null | undefined, name: string): string => node?.getAttribute(name)?.trim() ?? '';
const positiveId = (value: string): boolean => /^[1-9]\d{0,11}$/.test(value);
const loginNotice = /авторизуйтесь|необходимо\s+(?:авторизоваться|войти)|войдите\s+(?:в|под)|только\s+для\s+зарегистрированных/i;
const markupError = () => new ProviderError('markup', 'Не удалось распознать избранное аккаунта. Обновите список или проверьте источник.');
const authError = () => new ProviderError('authentication', 'Войдите в аккаунт источника, чтобы открыть избранное.');

function accountDocument(source: SourceDocument): Document {
  const doc = documentFrom(source.body);
  if (attr(doc.querySelector('#member_user_id'), 'value') === '0' ||
      [...doc.querySelectorAll('.b-info__message')].some(node => loginNotice.test(text(node)))) throw authError();
  return doc;
}

export function parseFavorites(source: SourceDocument, page = 1, requestedCollectionId?: string): FavoritesPage {
  const doc = accountDocument(source), safeBase = safeHttpUrl(source.url);
  if (!safeBase || !Number.isSafeInteger(page) || page < 1 || (requestedCollectionId !== undefined && !positiveId(requestedCollectionId))) throw markupError();
  const base = new URL(safeBase);
  const route = base.pathname.match(/^(.*\/favorites\/)(?:([1-9]\d*)\/)?(?:page\/([1-9]\d*)\/)?$/);
  if (!route || Number(route[3] ?? '1') !== page || base.hash || [...base.searchParams].some(([key, value]) => key !== 'filter' || value !== 'added')) throw markupError();
  const collections: FavoriteCollection[] = [], ids = new Set<string>(), active: string[] = [];
  for (const row of doc.querySelectorAll('.b-favorites_content__cats_list_item')) {
    const id = attr(row, 'data-cat_id'), link = row.querySelector('a.b-favorites_content__cats_list_link');
    const safe = safeHttpUrl(attr(link, 'href'), base.href), name = text(row.querySelector('span.name'));
    if (!positiveId(id) || !safe || !name) throw markupError();
    const url = new URL(safe);
    if (ids.has(id) || url.origin !== base.origin || url.pathname !== `${route[1]}${id}/` || url.search || url.hash) throw markupError();
    const rawCount = text(row.querySelector('span.num-holder b')).replace(/\s/g, '');
    const count = /^\d+$/.test(rawCount) && Number.isSafeInteger(Number(rawCount)) ? Number(rawCount) : undefined;
    collections.push({ id, name, ...(count !== undefined ? { count } : {}) }); ids.add(id);
    if (link?.classList.contains('active')) active.push(id);
  }
  if (!collections.length) {
    const empty = doc.querySelector('.b-favorites_content__cats_nolist');
    if (!requestedCollectionId && empty && /в закладках.{0,30}ничего нет|нет (?:разделов|коллекций)|список пуст/i.test(text(empty))) return { collections: [], items: [] };
    throw markupError();
  }
  if (active.length !== 1 || (requestedCollectionId !== undefined && active[0] !== requestedCollectionId) || (route[2] && route[2] !== active[0])) throw markupError();
  const selectedCollectionId = active[0], holder = doc.querySelector('.b-favorites_content__holder');
  if (!holder) throw markupError();
  if (!holder.querySelector('.b-content__inline_item')) {
    const notice = text(holder.querySelector('.b-info__message, .b-content__inline_items-empty'));
    if (/на данной странице ваших закладок нет|(?:в закладках|в (?:этом|данном) разделе).{0,60}(?:ничего нет|пуст|нет (?:фильмов|закладок))|ничего не добавлено|раздел пуст/i.test(notice)) {
      return { collections, selectedCollectionId, items: [] };
    }
    throw markupError();
  }
  // Keep recommendations and pagination for another collection outside the parser input.
  const navigation = doc.createElement('div'); navigation.className = 'b-navigation';
  for (const link of doc.querySelectorAll('.b-navigation a[href], .navigation a[href], .pagination a[href]')) {
    const safe = safeHttpUrl(attr(link, 'href'), base.href);
    if (!safe) continue;
    const url = new URL(safe), match = url.pathname.match(/^(.*\/favorites\/)\d+\/(?:page\/([1-9]\d*)\/)?$/);
    if (url.origin !== base.origin || !match || !url.pathname.startsWith(`${route[1]}${selectedCollectionId}/`) || url.hash ||
        [...url.searchParams].some(([key, value]) => key !== 'filter' || value !== 'added')) continue;
    navigation.append(link.cloneNode(true));
  }
  const parsed = parseCatalog({ url: source.url, body: holder.outerHTML + navigation.outerHTML }, page);
  const items = parsed.items.filter(item => {
    const url = new URL(item.url);
    return url.origin === base.origin && !url.search && !url.hash;
  });
  if (!items.length) throw markupError();
  return { ...parsed, items, collections, selectedCollectionId };
}

export function loadFavorites({ collectionId, page = 1 }: { collectionId?: string; page?: number } = {}): Promise<FavoritesPage> {
  return sourceData({ operation: 'favorites', page, ...(collectionId !== undefined ? { collectionId } : {}) }, source => parseFavorites(source, page, collectionId));
}

function titleAddress(title: TitleSummary): string {
  const safe = safeHttpUrl(title.url);
  if (!safe || !positiveId(title.id)) throw markupError();
  const url = new URL(safe);
  if (url.search || url.hash || url.pathname.match(/\/([1-9]\d*)(?:-[^/]+)?\.html$/)?.[1] !== title.id) throw markupError();
  return url.href;
}

export function parseFavoriteMembership(source: SourceDocument, title: TitleSummary): FavoriteMembership[] {
  const expected = new URL(titleAddress(title)), actual = safeHttpUrl(source.url), doc = accountDocument(source);
  if (!actual || new URL(actual).origin !== expected.origin) throw markupError();
  const holder = doc.querySelector('#user-favorites-holder'), list = holder?.querySelector('#user-favorites-list');
  if (!holder || attr(holder, 'data-post_id') !== title.id || !list) throw markupError();
  const result: FavoriteMembership[] = [], ids = new Set<string>();
  for (const row of list.querySelectorAll('.hd-label-row')) {
    const input = row.querySelector<HTMLInputElement>('input.user-fav-check[type="checkbox"]');
    const id = attr(input, 'value'), label = row.querySelector('label')?.cloneNode(true) as Element | undefined;
    label?.querySelectorAll('small, .num-holder').forEach(node => node.remove());
    const name = text(label);
    if (!input || !positiveId(id) || !name || ids.has(id)) throw markupError();
    result.push({ id, name, selected: input.checked }); ids.add(id);
  }
  if (list.querySelectorAll('input.user-fav-check').length !== result.length) throw markupError();
  return result;
}

export function loadFavoriteMembership(title: TitleSummary): Promise<FavoriteMembership[]> {
  return sourceData({ operation: 'details', url: titleAddress(title) }, source => parseFavoriteMembership(source, title));
}

export class FavoriteUpdateError extends Error {
  constructor(message: string, public readonly memberships?: FavoriteMembership[], public readonly creationUncertain = false) { super(message); this.name = 'FavoriteUpdateError'; }
}
const updates = new Map<string, { generation: number }>();
const creations = new Map<string, { generation: number }>();
type PendingCreation = { generation: number; beforeIds: Set<string>; name: string; responseId?: string };
const pendingCreations = new Map<string, PendingCreation>();
const checkGeneration = (generation: number) => {
  if (getProviderGeneration() !== generation) throw new FavoriteUpdateError('Аккаунт или источник изменился. Обновите избранное перед следующим действием.');
};
function sessionError(error: unknown): boolean {
  if (isAuthenticationError(error)) return true;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return code === 'source_changed' || code.startsWith('auth_');
}
function parseFavoriteMutation(source: SourceDocument): { success: boolean; message?: string; id?: string } {
  let data: unknown;
  try { data = JSON.parse(source.body); }
  catch {
    const doc = accountDocument(source);
    try { data = JSON.parse(doc.body.textContent ?? ''); } catch { throw markupError(); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('success' in data) || typeof data.success !== 'boolean') throw markupError();
  let message: string | undefined;
  if ('message' in data && typeof data.message === 'string') {
    const doc = new DOMParser().parseFromString(data.message, 'text/html');
    doc.querySelectorAll('script, style').forEach(node => node.remove());
    message = text(doc.body).slice(0, 300) || undefined;
    if (!data.success && message && loginNotice.test(message)) throw authError();
  }
  const id = 'id' in data && (typeof data.id === 'string' || typeof data.id === 'number') ? String(data.id) : '';
  return { success: data.success, message, ...(positiveId(id) ? { id } : {}) };
}

export async function setFavoriteMembership(title: TitleSummary, collectionId: string, selected: boolean): Promise<FavoriteMembership[]> {
  const url = titleAddress(title), generation = getProviderGeneration(), key = `${new URL(url).origin}|${title.id}`;
  if (!positiveId(collectionId) || typeof selected !== 'boolean') throw new FavoriteUpdateError('Не удалось определить раздел избранного. Обновите список.');
  if (updates.get(key)?.generation === generation) throw new FavoriteUpdateError('Дождитесь завершения предыдущего изменения избранного.');
  const request = { generation }; updates.set(key, request);
  try {
    let before: FavoriteMembership[];
    try { before = await loadFavoriteMembership(title); }
    catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      throw new FavoriteUpdateError('Не удалось проверить избранное. Обновите список перед изменением.');
    }
    checkGeneration(generation);
    const current = before.find(item => item.id === collectionId);
    if (!current) throw new FavoriteUpdateError('Этот раздел больше недоступен. Обновите список избранного.', before);
    if (current.selected === selected) return before;
    let refusal: string | undefined;
    try {
      const result = await sourceData({ operation: 'favoriteToggle', url, id: title.id, collectionId }, parseFavoriteMutation);
      checkGeneration(generation);
      if (!result.success) refusal = result.message ? `Источник отказал в изменении: ${result.message}` : 'Источник отказал в изменении избранного.';
    } catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      // The server may have applied the toggle before the reply was lost. Never repeat it.
    }
    checkGeneration(generation);
    let after: FavoriteMembership[];
    try { after = await loadFavoriteMembership(title); }
    catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      throw new FavoriteUpdateError(refusal ?? 'Не удалось подтвердить изменение. Состояние избранного неизвестно. Обновите список.');
    }
    checkGeneration(generation);
    if (refusal) throw new FavoriteUpdateError(refusal, after);
    if (after.find(item => item.id === collectionId)?.selected === selected) return after;
    throw new FavoriteUpdateError('Изменение не подтверждено источником. Показано последнее проверенное состояние избранного.', after);
  } finally { if (updates.get(key) === request) updates.delete(key); }
}

function confirmedCollection(pending: PendingCreation, memberships: FavoriteMembership[]): string | undefined {
  const added = memberships.filter(item => !pending.beforeIds.has(item.id));
  if (pending.responseId) return added.find(item => item.id === pending.responseId)?.id;
  const matches = added.filter(item => item.name === pending.name);
  return matches.length === 1 ? matches[0].id : undefined;
}

export async function createFavoriteCollection(title: TitleSummary, name: string): Promise<{ memberships: FavoriteMembership[]; collectionId: string }> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new FavoriteUpdateError('Введите название списка: от 1 до 100 символов, без переносов строк.');
  }
  const url = titleAddress(title), generation = getProviderGeneration(), origin = new URL(url).origin;
  const key = `${origin}|${title.id}`, normalizedName = trimmed.replace(/\s+/g, ' '), pendingKey = `${origin}|${normalizedName}`;
  if (updates.get(key)?.generation === generation || creations.get(origin)?.generation === generation) {
    throw new FavoriteUpdateError('Дождитесь завершения предыдущего изменения избранного.');
  }
  const request = { generation }; updates.set(key, request); creations.set(origin, request);
  try {
    const previous = pendingCreations.get(pendingKey);
    const unresolved = previous?.generation === generation ? previous : undefined;
    let before: FavoriteMembership[];
    try { before = await loadFavoriteMembership(title); }
    catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      throw new FavoriteUpdateError(unresolved ? 'Не удалось проверить создание списка. Проверьте списки перед следующим действием.' : 'Не удалось проверить списки аккаунта. Повторите загрузку перед созданием.', undefined, Boolean(unresolved));
    }
    checkGeneration(generation);
    if (unresolved) {
      const collectionId = confirmedCollection(unresolved, before);
      if (collectionId) {
        pendingCreations.delete(pendingKey);
        return { memberships: before, collectionId };
      }
      throw new FavoriteUpdateError('Предыдущее создание этого списка ещё не подтверждено. Проверьте списки; повторная отправка может создать дубликат.', before, true);
    }
    const pending: PendingCreation = { generation, beforeIds: new Set(before.map(item => item.id)), name: normalizedName };
    // Keep the original snapshot if the request or verification fails. A second attempt may only read it back.
    pendingCreations.set(pendingKey, pending);
    let refusal: string | undefined;
    try {
      const result = await sourceData({ operation: 'favoriteCreate', url, id: title.id, name: trimmed }, parseFavoriteMutation);
      checkGeneration(generation);
      if (result.success) pending.responseId = result.id;
      else {
        refusal = result.message ? `Источник отказал в создании: ${result.message}` : 'Источник отказал в создании списка.';
        pendingCreations.delete(pendingKey);
      }
    } catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      // There is no idempotency key. Never automatically repeat an uncertain creation.
    }
    checkGeneration(generation);
    let after: FavoriteMembership[];
    try { after = await loadFavoriteMembership(title); }
    catch (error) {
      if (sessionError(error)) throw error;
      checkGeneration(generation);
      throw new FavoriteUpdateError(refusal ?? 'Не удалось подтвердить создание списка. Проверьте списки; повторная отправка может создать дубликат.', undefined, !refusal);
    }
    checkGeneration(generation);
    if (refusal) throw new FavoriteUpdateError(refusal, after);
    const collectionId = confirmedCollection(pending, after);
    if (!collectionId) throw new FavoriteUpdateError('Создание списка не подтверждено источником. Проверьте списки; повторная отправка может создать дубликат.', after, true);
    pendingCreations.delete(pendingKey);
    return { memberships: after, collectionId };
  } finally {
    if (updates.get(key) === request) updates.delete(key);
    if (creations.get(origin) === request) creations.delete(origin);
  }
}
