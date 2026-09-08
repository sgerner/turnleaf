import { describe, expect, it } from 'vitest';
import {
  DevProxyError,
  decodeProxyTarget,
  fetchProxyTarget,
  parseAllowedOrigins,
  proxyRequestHeaders,
  proxyResponseHeaders,
  readProxyBody,
  validateProxyTarget,
} from './dev-proxy';

function request(
  method: string,
  chunks: (Buffer | string)[],
  headers: Record<string, string> = {},
): Parameters<typeof readProxyBody>[0] {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

describe('development proxy target validation', () => {
  it('allows loopback HTTP and HTTPS targets', () => {
    expect(validateProxyTarget('http://localhost:5000/api/Health')).toMatchObject({ ok: true });
    expect(validateProxyTarget('https://127.0.0.1:5000/api/Health')).toMatchObject({ ok: true });
    expect(validateProxyTarget('http://[::1]:5000/api/Health')).toMatchObject({ ok: true });
  });

  it('rejects malformed, non-HTTP, credentialed, and non-loopback targets', () => {
    expect(() => decodeProxyTarget('%')).toThrowError(DevProxyError);
    expect(decodeProxyTarget(encodeURIComponent('https://localhost:5000'))).toBe(
      'https://localhost:5000',
    );
    expect(validateProxyTarget('not a URL')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateProxyTarget('file:///etc/passwd')).toEqual({ ok: false, reason: 'protocol' });
    expect(validateProxyTarget('http://user:password@localhost:5000')).toEqual({
      ok: false,
      reason: 'credentials',
    });
    expect(validateProxyTarget('http://192.168.1.20:5000')).toEqual({
      ok: false,
      reason: 'origin',
    });
  });

  it('allows an explicitly configured non-loopback origin', () => {
    const allowed = parseAllowedOrigins(
      'https://192.168.1.20:5000,http://192.168.1.21:5000,not-a-url,ftp://host',
    );
    expect(allowed).toEqual(new Set(['https://192.168.1.20:5000']));
    expect(validateProxyTarget('https://192.168.1.20:5000/api/Health', allowed)).toMatchObject({
      ok: true,
    });
    expect(validateProxyTarget('http://192.168.1.21:5000/api/Health', allowed)).toMatchObject({
      ok: false,
      reason: 'origin',
    });
  });
});

describe('development proxy request boundaries', () => {
  it('forwards API headers while stripping browser and forwarding credentials', () => {
    const headers = proxyRequestHeaders({
      accept: 'application/json',
      authorization: 'Bearer browser-secret',
      connection: 'keep-alive',
      cookie: 'session=secret',
      'content-length': '12',
      'content-type': 'application/json',
      forwarded: 'for=127.0.0.1',
      host: 'localhost:5173',
      'x-api-key': 'kavita-key',
      'x-forwarded-for': '127.0.0.1',
    });

    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe('kavita-key');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
  });

  it('limits request body size before buffering it', async () => {
    await expect(readProxyBody(request('POST', ['12345']), 4)).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(
      readProxyBody(request('POST', ['12345'], { 'content-length': '5' }), 4),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(readProxyBody(request('GET', ['ignored']), 1)).resolves.toBeUndefined();
  });

  it('converts redirects, timeouts, and upstream failures into safe proxy errors', async () => {
    await expect(
      fetchProxyTarget(
        new URL('http://localhost:5000'),
        {
          method: 'GET',
          headers: new Headers(),
        },
        {
          fetchImpl: async () =>
            new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 502 });

    await expect(
      fetchProxyTarget(
        new URL('http://localhost:5000'),
        { method: 'GET' },
        {
          timeoutMs: 5,
          fetchImpl: (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
            }),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 504 });

    await expect(
      fetchProxyTarget(
        new URL('http://localhost:5000'),
        { method: 'GET' },
        {
          fetchImpl: async () => {
            throw new Error('offline');
          },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('does not forward redirect or cookie response headers', () => {
    const response = new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        location: 'https://evil.example',
        'set-cookie': 'session=secret',
      },
    });

    expect(proxyResponseHeaders(response)).toEqual([['content-type', 'text/plain']]);
  });

  it('uses the typed proxy error for invalid body lengths', async () => {
    await expect(
      readProxyBody(request('POST', [], { 'content-length': 'invalid' })),
    ).rejects.toBeInstanceOf(DevProxyError);
  });
});
