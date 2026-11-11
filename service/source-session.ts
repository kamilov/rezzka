import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

type Cookie = { name: string; value: string; path: string; secure: boolean; expiresAt?: number };
const accountNames = new Set(['dle_user_id', 'dle_password']);
const validName = (name: unknown): name is string => typeof name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name);
const validValue = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !/[^\x21-\x7e]|[,;]/.test(value);

/** Cookies never cross an origin boundary and are never exposed to the UI. */
export class SourceCookies {
  private values = new Map<string, Cookie>();
  constructor(saved: unknown = []) {
    for (const item of Array.isArray(saved) ? saved.slice(0, 64) : []) {
      if (!item || typeof item !== 'object' || !validName(item.name) || !validValue(item.value) ||
          typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.length > 2048 || /[\u0000-\u001f\u007f]/.test(item.path) ||
          typeof item.secure !== 'boolean' || (item.expiresAt !== undefined && (!Number.isFinite(item.expiresAt) || item.expiresAt <= Date.now()))) continue;
      this.values.set(item.name + '\n' + item.path, { name: item.name, value: item.value, path: item.path, secure: item.secure, expiresAt: item.expiresAt });
    }
  }
  receive(url: URL, headers: string[], allowAccount = true): void {
    for (const header of headers.slice(0, 64)) {
      if (header.length > 4096) continue;
      const parts = header.split(';'), pair = parts.shift() || '', equal = pair.indexOf('=');
      if (equal < 1) continue;
      const name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim();
      if (!validName(name) || !validValue(value) || (!allowAccount && accountNames.has(name.toLowerCase()))) continue;
      const attrs = new Map<string, string>();
      for (const part of parts) {
        const index = part.indexOf('=');
        attrs.set((index < 0 ? part : part.slice(0, index)).trim().toLowerCase(), index < 0 ? '' : part.slice(index + 1).trim());
      }
      const domain = attrs.get('domain');
      if (domain !== undefined && domain.replace(/^\./, '').toLowerCase() !== url.hostname.toLowerCase()) continue;
      const requestedPath = attrs.get('path');
      const path = requestedPath?.startsWith('/') ? requestedPath : url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
      if (path.length > 2048 || /[\u0000-\u001f\u007f]/.test(path)) continue;
      const secure = attrs.has('secure');
      if ((secure && url.protocol !== 'https:') || (name.startsWith('__Secure-') && !secure) ||
          (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/'))) continue;
      let expiresAt: number | undefined;
      const maxAge = attrs.get('max-age');
      if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) expiresAt = Date.now() + Math.min(Number(maxAge), 365 * 24 * 3600) * 1000;
      else if (attrs.has('expires')) { const parsed = Date.parse(attrs.get('expires')!); if (Number.isFinite(parsed)) expiresAt = parsed; }
      const key = name + '\n' + path;
      if (!value || (expiresAt !== undefined && expiresAt <= Date.now())) { this.values.delete(key); continue; }
      if (this.values.size >= 64 && !this.values.has(key)) this.values.delete(this.values.keys().next().value!);
      this.values.set(key, { name, value, path, secure, expiresAt });
    }
  }
  header(url: URL): string {
    const matching: Cookie[] = [];
    for (const [key, item] of this.values) {
      if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) { this.values.delete(key); continue; }
      if (item.secure && url.protocol !== 'https:') continue;
      if (url.pathname === item.path || url.pathname.startsWith(item.path.endsWith('/') ? item.path : item.path + '/')) matching.push(item);
    }
    let result = '';
    for (const item of matching.sort((a, b) => b.path.length - a.path.length)) {
      const pair = `${item.name}=${item.value}`;
      if (result.length + pair.length + 2 <= 8192) result += (result ? '; ' : '') + pair;
    }
    return result;
  }
  authenticated(base: URL): boolean {
    const cookies = new Map(this.header(base).split('; ').filter(Boolean).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    return /^\d+$/.test(cookies.get('dle_user_id') || '') && Number(cookies.get('dle_user_id')) > 0 && !!cookies.get('dle_password');
  }
  technical(): SourceCookies { return new SourceCookies(this.serialize().filter(item => !accountNames.has(item.name.toLowerCase()) && item.name.toLowerCase() !== 'phpsessid')); }
  serialize(): Cookie[] {
    return [...this.values.values()].filter(item => item.expiresAt === undefined || item.expiresAt > Date.now());
  }
}

export interface SavedSourceSession { schemaVersion: 1; origin: string; username: string; cookies: unknown[] }
export async function readSourceSession(path: string): Promise<SavedSourceSession | undefined> {
  let raw: string;
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 512 * 1024) return;
      raw = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion !== 1 || typeof value.origin !== 'string' || new URL(value.origin).origin !== value.origin ||
        !['http:', 'https:'].includes(new URL(value.origin).protocol) || typeof value.username !== 'string' ||
        !value.username || value.username.length > 200 || /[\u0000-\u001f\u007f]/.test(value.username) || !Array.isArray(value.cookies)) return;
    return value;
  } catch { return; }
}

export async function writeSourceSession(path: string, value: SavedSourceSession | undefined, stillCurrent: () => boolean): Promise<void> {
  if (!value) {
    if (stillCurrent()) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    if (stillCurrent()) await rename(temporary, path);
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
