import { isIP } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export const DEV_PROXY_PREFIX = '/__kavita__/';
export const DEV_PROXY_ORIGINS_ENV = 'TURNLEAF_DEV_PROXY_ORIGINS';
export const MAX_PROXY_BODY_BYTES = 1024 * 1024;
export const PROXY_TIMEOUT_MS = 12_000;

const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'content-type', 'x-api-key']);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'location',
  'set-cookie',
  'transfer-encoding',
]);

export type ProxyTargetResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'malformed' | 'protocol' | 'credentials' | 'origin' };

export class DevProxyError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 502 | 504,
    message: string,
  ) {
    super(message);
  }
}

export function decodeProxyTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DevProxyError(400, 'The Kavita development proxy target is malformed.');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isIP(normalized) === 4) return normalized.split('.')[0] === '127';
  return normalized === '::1';
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export function parseAllowedOrigins(raw = process.env[DEV_PROXY_ORIGINS_ENV] ?? ''): Set<string> {
  const origins = new Set<string>();
  for (const value of raw.split(',')) {
    const candidate = value.trim();
    if (!candidate) continue;

    try {
      const url = new URL(candidate);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Ignore malformed allowlist entries and keep the proxy fail-closed.
    }
  }
  return origins;
}

export function validateProxyTarget(
  value: string,
  allowedOrigins: ReadonlySet<string> = parseAllowedOrigins(),
): ProxyTargetResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!isHttpUrl(url)) return { ok: false, reason: 'protocol' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (
    !isLoopbackHostname(url.hostname) &&
    (url.protocol !== 'https:' || !allowedOrigins.has(url.origin))
  ) {
    return { ok: false, reason: 'origin' };
  }
  return { ok: true, url };
}

export function proxyRequestHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(lower, item);
    } else {
      headers.set(lower, value);
    }
  }
  return headers;
}

export async function readProxyBody(
  req: Pick<IncomingMessage, 'method' | 'headers'> & AsyncIterable<Buffer | string>,
  maxBytes = MAX_PROXY_BODY_BYTES,
): Promise<Buffer | undefined> {
  if (!req.method || req.method === 'GET' || req.method === 'HEAD') return undefined;

  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0) {
      throw new DevProxyError(400, 'The request body length is invalid.');
    }
    if (length > maxBytes) {
      throw new DevProxyError(413, 'The request body is too large for the development proxy.');
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new DevProxyError(413, 'The request body is too large for the development proxy.');
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks, total) : undefined;
}

export async function fetchProxyTarget(
  target: URL,
  init: RequestInit,
  {
    fetchImpl = fetch,
    timeoutMs = PROXY_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(target, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new DevProxyError(502, 'The Kavita development proxy does not follow redirects.');
    }
    return response;
  } catch (error) {
    if (error instanceof DevProxyError) throw error;
    if (controller.signal.aborted) {
      throw new DevProxyError(504, 'Kavita did not respond before the proxy timeout.');
    }
    throw new DevProxyError(502, 'Kavita could not be reached through the development proxy.');
  } finally {
    clearTimeout(timer);
  }
}

export function proxyResponseHeaders(response: Response): [string, string][] {
  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.push([key, value]);
  });
  return headers;
}

export async function sendProxyResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of proxyResponseHeaders(response)) res.setHeader(key, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}
