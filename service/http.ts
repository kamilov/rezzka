import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

export function fail(res: ServerResponse, error: unknown): void {
  const known = error instanceof HttpError;
  json(res, known ? error.status : 500, {
    returnValue: false,
    errorCode: known ? error.code : 'internal_error',
    errorText: known ? error.message : 'Не удалось выполнить запрос.',
  });
}

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export async function readJson(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'content_type', 'Ожидается application/json.');
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    req.resume();
    throw new HttpError(413, 'body_too_large', 'Запрос слишком большой.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const done = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      if (error) { req.resume(); reject(error); }
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) done(new HttpError(413, 'body_too_large', 'Запрос слишком большой.'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { done(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { done(new HttpError(400, 'invalid_json', 'Некорректный JSON.')); }
    };
    const onError = () => done(new HttpError(400, 'request_error', 'Не удалось прочитать запрос.'));
    const onAborted = () => done(new HttpError(400, 'request_aborted', 'Запрос прерван.'));
    const timer = setTimeout(() => done(new HttpError(408, 'request_timeout', 'Истекло время запроса.')), 5000);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
