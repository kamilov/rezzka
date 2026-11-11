import type { CommentsPage, CommentText, SourceDocument, TitleComment, TitleSummary } from '../shared/source';
import { documentFrom, ProviderError, sourceData } from './provider';
import { safeHttpUrl } from './provider-codec';

const positiveId = (value: string) => /^[1-9]\d{0,11}$/.test(value);
const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const markupError = () => new ProviderError('markup', 'Не удалось распознать комментарии источника. Повторите загрузку.');
const own = (row: Element, selector: string): Element | undefined => [...row.querySelectorAll(selector)].find(node => node.closest('li.comments-tree-item') === row);

function titleAddress(title: TitleSummary): string {
  const safe = safeHttpUrl(title.url);
  if (!safe || !positiveId(title.id)) throw markupError();
  const url = new URL(safe);
  if (url.search || url.hash || url.pathname.match(/\/(\d+)(?:-|\.html|\/|$)/)?.[1] !== title.id) throw markupError();
  return url.href;
}

function commentText(root: Element): CommentText[] {
  let remaining = 5000;
  const walk = (parent: Node, depth: number): CommentText[] => {
    const result: CommentText[] = [];
    const append = (item: CommentText) => {
      const previous = result.at(-1);
      if (item.kind === 'text' && previous?.kind === 'text') previous.text += item.text;
      else result.push(item);
    };
    for (const node of parent.childNodes) {
      if (--remaining < 0 || depth > 32) break;
      if (node.nodeType === Node.TEXT_NODE) { append({ kind: 'text', text: (node.textContent ?? '').replace(/\s+/g, ' ') }); continue; }
      if (!(node instanceof Element)) continue;
      if (node.matches('script, style, template, noscript, iframe, object, embed, img, picture, video, audio, svg, math, canvas, input, button, select, textarea, .title_spoiler, li.comments-tree-item')) continue;
      if (node.tagName === 'BR') { append({ kind: 'break' }); continue; }
      const children = walk(node, depth + 1);
      if (!children.length) continue;
      const kind = node.classList.contains('text_spoiler') ? 'spoiler'
        : ['B', 'STRONG'].includes(node.tagName) ? 'bold'
          : ['I', 'EM'].includes(node.tagName) ? 'italic'
            : node.tagName === 'U' ? 'underline'
              : ['S', 'STRIKE', 'DEL'].includes(node.tagName) ? 'strike' : undefined;
      if (kind) append({ kind, children });
      else {
        const block = ['DIV', 'P', 'BLOCKQUOTE', 'UL', 'OL', 'LI'].includes(node.tagName);
        if (block && result.length && result.at(-1)?.kind !== 'break') append({ kind: 'break' });
        children.forEach(append);
        if (block) append({ kind: 'break' });
      }
    }
    while (result[0]?.kind === 'break' || (result[0]?.kind === 'text' && !result[0].text.trim())) result.shift();
    while (result.at(-1)?.kind === 'break' || (result.at(-1)?.kind === 'text' && !(result.at(-1) as { text: string }).text.trim())) result.pop();
    return result;
  };
  const result = walk(root, 0);
  if (result[0]?.kind === 'text') result[0].text = result[0].text.trimStart();
  const last = result.at(-1); if (last?.kind === 'text') last.text = last.text.trimEnd();
  return result;
}

function nextCommentsPage(navigation: string, titleId: string, page: number, empty: boolean): number | undefined {
  if (!navigation.trim()) return undefined;
  const doc = documentFrom(navigation), holder = doc.querySelector('.b-navigation');
  if (!holder) throw markupError();
  const current = [...holder.children].filter(node => node.tagName === 'SPAN' && !node.matches('.no-page, .disabled') && /^\d+$/.test(text(node)));
  if (current.length > 1 || (current[0] && Number(text(current[0])) !== page)) throw markupError();
  let next: number | undefined;
  for (const link of holder.querySelectorAll('a[onclick]')) {
    if (link.closest('.no-page, .disabled, [aria-disabled="true"]')) continue;
    // Read the site's literal pagination arguments without evaluating its JavaScript.
    const call = (link.getAttribute('onclick') ?? '').match(/^\s*sof\.comments\.loadComments\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(?:false|true)\s*,\s*0\s*\)\s*;?\s*(?:return\s+false\s*;?)?\s*$/);
    if (call?.[1] === titleId && Number(call[2]) === page + 1 && page < 10000) next = page + 1;
  }
  if (empty && next) throw markupError();
  return next;
}

export function parseComments(source: SourceDocument, title: TitleSummary, page = 1): CommentsPage {
  const expected = new URL(titleAddress(title)), safe = safeHttpUrl(source.url);
  if (!safe || !Number.isSafeInteger(page) || page < 1 || page > 10000) throw markupError();
  const url = new URL(safe);
  if (url.origin !== expected.origin || !url.pathname.endsWith('/ajax/get_comments/') || url.hash ||
      url.searchParams.get('news_id') !== title.id || url.searchParams.get('cstart') !== String(page)) throw markupError();
  let data: unknown;
  try { data = JSON.parse(source.body); }
  catch { documentFrom(source.body); throw markupError(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw markupError();
  if ('success' in data && data.success === false) {
    const message = 'message' in data && typeof data.message === 'string' ? text(documentFrom(data.message).body) : '';
    if (/авторизуйтесь|необходимо\s+(?:авторизоваться|войти)|войдите\s+(?:в|под)/i.test(message)) throw new ProviderError('authentication', 'Источник требует входа для просмотра комментариев.');
    throw new ProviderError('unavailable', 'Источник не загрузил комментарии. Повторите попытку.');
  }
  if (!('comments' in data) || typeof data.comments !== 'string' || !('navigation' in data) || typeof data.navigation !== 'string') throw markupError();
  const doc = documentFrom(data.comments), rows = [...doc.querySelectorAll('li.comments-tree-item')], items: TitleComment[] = [], ids = new Set<string>();
  if (!rows.length && data.comments.trim()) throw markupError();
  for (const row of rows) {
    const holder = own(row, 'div[id^="comment-id-"]'), id = holder?.id.match(/^comment-id-([1-9]\d{0,11})$/)?.[1];
    const dataId = row.getAttribute('data-id');
    const author = own(row, 'span.name'), date = own(row, 'span.date'), body = own(row, 'div.text > div');
    if (!id || (dataId !== null && dataId !== id) || !author || !text(author) || !date || !body) throw markupError();
    if (ids.has(id)) continue;
    const indentText = row.getAttribute('data-indent') ?? '0', indent = /^\d{1,3}$/.test(indentText) ? Number(indentText) : NaN;
    if (!Number.isSafeInteger(indent)) throw markupError();
    const parent = row.parentElement?.closest('li.comments-tree-item');
    const parentId = parent ? own(parent, 'div[id^="comment-id-"]')?.id.match(/^comment-id-([1-9]\d{0,11})$/)?.[1] : undefined;
    const avatar = safeHttpUrl(own(row, 'div.ava img')?.getAttribute('src'), source.url);
    const likesText = text(own(row, 'span.b-comment__likes_count i')).replace(/\s/g, '');
    const likes = /^-?\d+$/.test(likesText) && Number.isSafeInteger(Number(likesText)) ? Number(likesText) : undefined;
    items.push({ id, author: text(author), date: text(date), content: commentText(body), indent,
      ...(parentId ? { parentId } : {}), ...(avatar ? { avatar } : {}), ...(likes !== undefined ? { likes } : {}) });
    ids.add(id);
  }
  const nextPage = nextCommentsPage(data.navigation, title.id, page, !items.length);
  return { items, ...(nextPage ? { nextPage } : {}) };
}

export function loadComments(title: TitleSummary, page = 1): Promise<CommentsPage> {
  const url = titleAddress(title);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return Promise.reject(markupError());
  return sourceData({ operation: 'comments', url, id: title.id, page }, source => parseComments(source, title, page));
}
