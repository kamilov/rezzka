function httpUrl(value: string, base?: string): URL | undefined {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value)) return;
  try {
    const url = new URL(value, base);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* Malformed optional links do not invalidate the source title. */ }
}

function filmId(url: URL | undefined): string | undefined {
  if (!url || url.port || !['kinopoisk.ru', 'www.kinopoisk.ru'].includes(url.hostname)) return;
  const id = url.pathname.match(/^\/(?:film|series)\/([1-9]\d{0,11})\/?$/)?.[1];
  return id && Number(id) <= 15000000 ? id : undefined;
}

/** Source rating links may wrap an encoded URL; decode locally without following redirects. */
export function parseKinopoiskFilmId(doc: Document, base: string): string | undefined {
  const source = httpUrl(base);
  if (!source) return;
  const ids = new Set<string>();
  for (const link of doc.querySelectorAll('.b-post__info .kp a[href]')) {
    const url = httpUrl(link.getAttribute('href')?.trim() ?? '', base);
    let id = filmId(url);
    if (!id && url?.origin === source.origin) {
      const encoded = url.pathname.match(/^\/help\/([A-Za-z0-9+/]{1,2048}={0,2})\/$/)?.[1];
      if (encoded) {
        try { id = filmId(httpUrl(decodeURIComponent(atob(encoded)))); }
        catch { /* Invalid base64 or percent encoding is not an identity. */ }
      }
    }
    if (id) ids.add(id);
  }
  return ids.size === 1 ? ids.values().next().value : undefined;
}
