import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { CommentsPage, CommentText, TitleComment, TitleSummary } from '../shared/source';
import { loadComments } from './provider-comments';
import { getProviderGeneration } from './provider';
import { isDemoTitle } from './demo-source';
import { TVButton, TVFocusScope, useTVFocusEnabled, canFocusFromPointer } from './navigation';
import { LoadMoreTrigger } from './LoadMoreTrigger';
import './comments.css';

type Result = CommentsPage & { loaded: boolean; loading: boolean; error: string; failedPage?: number };
const empty = (): Result => ({ items: [], loaded: false, loading: false, error: '' });

function Spoiler({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className="comment-spoiler">
    <TVButton id={id} selected={open} onPress={() => setOpen(value => !value)}>{open ? 'Скрыть спойлер' : 'Показать спойлер'}</TVButton>
    {open && <span className="comment-spoiler-content">{children}</span>}
  </span>;
}

function Text({ nodes, prefix }: { nodes: CommentText[]; prefix: string }) {
  return <>{nodes.map((node, index) => {
    const id = `${prefix}-${index}`;
    if (node.kind === 'text') return <span key={id}>{node.text}</span>;
    if (node.kind === 'break') return <br key={id} />;
    const children = <Text nodes={node.children} prefix={id} />;
    switch (node.kind) {
      case 'bold': return <strong key={id}>{children}</strong>;
      case 'italic': return <em key={id}>{children}</em>;
      case 'underline': return <u key={id}>{children}</u>;
      case 'strike': return <s key={id}>{children}</s>;
      case 'spoiler': return <Spoiler key={id} id={`${id}-spoiler`}>{children}</Spoiler>;
    }
  })}</>;
}

function Comment({ comment, active, onFocused }: { comment: TitleComment; active: boolean; onFocused?: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const enabled = useTVFocusEnabled() && active;
  const id = `comment-${comment.id}`;
  const { ref, focused, focusSelf } = useFocusable({
    focusKey: id, focusable: enabled,
    onFocus: () => { ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); onFocused?.(); },
    onArrowPress: direction => {
      const element = body.current;
      if (!element || getCurrentFocusKey() !== id || (direction !== 'up' && direction !== 'down')) return true;
      const before = element.scrollTop;
      const maximum = element.scrollHeight - element.clientHeight;
      const step = Math.max(80, element.clientHeight * .65);
      const next = direction === 'down' ? Math.min(maximum, before + step) : Math.max(0, before - step);
      if (Math.abs(next - before) < 1) return true;
      element.scrollTop = next;
      return false;
    },
  });
  return <article ref={ref} tabIndex={enabled ? 0 : -1} className={`comment-card ${focused ? 'is-focused' : ''}`} data-testid={id} data-focused={focused || undefined}
    aria-label={`Комментарий: ${comment.author}`} style={{ marginInlineStart: `${Math.min(3, Math.max(0, comment.indent)) * 1.2}rem` }}
    onFocus={event => { if (event.target === event.currentTarget && enabled) focusSelf(); }} onPointerEnter={() => { if (enabled && canFocusFromPointer()) focusSelf(); }}>
    <header className="comment-heading"><span className="comment-author">{comment.author}</span>{comment.date && <span className="comment-date">{comment.date}</span>}
      {comment.likes !== undefined && <span className="comment-likes" aria-label={`Понравилось: ${comment.likes}`}><span aria-hidden="true">♡ </span>{comment.likes}</span>}
    </header>
    <div className="comment-body" ref={body}><Text nodes={comment.content} prefix={id} /></div>
  </article>;
}

export default function CommentsPanel({ title, active }: { title: TitleSummary; active: boolean }) {
  const [result, setResult] = useState<Result>(empty);
  const generation = getProviderGeneration(), demo = isDemoTitle(title);
  const identity = JSON.stringify([generation, title.url]);
  const owner = useRef(''), epoch = useRef(0), pending = useRef<object | null>(null);
  const started = useRef(false), focusTimer = useRef<number | undefined>(undefined);
  const snapshot = useRef({ title, active, result, identity, demo }); snapshot.current = { title, active, result, identity, demo };

  const fetchPage = async (page: number, replace = false, initiator?: string) => {
    const state = snapshot.current;
    if (!state.active || state.demo || pending.current) return;
    const ticket = epoch.current, request = {}; pending.current = request;
    setResult(previous => ({ ...previous, loading: true, error: '', failedPage: undefined }));
    try {
      const next = await loadComments(state.title, page);
      if (ticket !== epoch.current || state.identity !== snapshot.current.identity) return;
      const previous = replace ? [] : state.result.items;
      const items = [...new Map([...previous, ...next.items].map(item => [item.id, item])).values()];
      const nextPage = items.length > previous.length && next.nextPage && next.nextPage > page ? next.nextPage : undefined;
      setResult({ ...next, items, nextPage, loaded: true, loading: false, error: '' });
      if (initiator) {
        window.clearTimeout(focusTimer.current);
        focusTimer.current = window.setTimeout(() => {
          if (ticket === epoch.current && state.identity === snapshot.current.identity && snapshot.current.active && getCurrentFocusKey() === initiator) {
            void setFocus(items.length ? `comment-${items[Math.min(previous.length, items.length - 1)].id}` : 'details-discussion-close');
          }
        }, 40);
      }
    } catch (reason) {
      if (ticket === epoch.current && state.identity === snapshot.current.identity) setResult(previous => ({ ...previous, loaded: true, loading: false, failedPage: page, error: reason instanceof Error ? reason.message : 'Не удалось загрузить комментарии.' }));
    } finally { if (pending.current === request) pending.current = null; }
  };
  useEffect(() => {
    if (owner.current !== identity) {
      owner.current = identity; epoch.current++; pending.current = null; started.current = false;
      window.clearTimeout(focusTimer.current); setResult(empty());
    }
    if (active && !demo && !started.current) { started.current = true; void fetchPage(1, true); }
  }, [active, identity, demo]);
  useEffect(() => () => { epoch.current++; pending.current = null; window.clearTimeout(focusTimer.current); }, []);
  const more = () => {
    const state = snapshot.current;
    if (state.active && !state.result.loading && !state.result.error && state.result.nextPage) void fetchPage(state.result.nextPage);
  };
  const shown = owner.current === identity ? result : empty();
  return <TVFocusScope active={active}><section className="comments-panel" data-testid="comments-panel" aria-busy={shown.loading}>
    {shown.total !== undefined && <p className="section-note comments-total">Всего: {shown.total}</p>}
    {demo ? <p className="section-note">Комментарии источника доступны после выхода из деморежима.</p> : <>
      <div className="comments-list">{shown.items.map((comment, index) => <Comment key={`${identity}:${comment.id}`} comment={comment} active={active} onFocused={index >= shown.items.length - 2 ? more : undefined} />)}</div>
      {shown.loading && <p className="section-note" role="status">{shown.items.length ? 'Загружаем следующие комментарии…' : 'Загружаем комментарии…'}</p>}
      {shown.error && <div className="inline-error" role="alert"><p>{shown.error}</p><TVButton id="comments-retry" onPress={() => void fetchPage(shown.failedPage ?? 1, shown.failedPage === 1, 'comments-retry')}>Повторить</TVButton></div>}
      {shown.loaded && !shown.loading && !shown.error && !shown.items.length && <p className="comments-empty section-note" role="status">Комментариев пока нет.</p>}
      {shown.nextPage && <LoadMoreTrigger enabled={active && !shown.loading && !shown.error} onLoad={more} />}
    </>}
  </section></TVFocusScope>;
}
