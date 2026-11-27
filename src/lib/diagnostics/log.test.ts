// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  native: false,
  files: new Map<string, string>(),
  failRead: false,
  failWrite: false,
  failDelete: false,
  readGate: null as Promise<void> | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    getPlatform: () => (runtime.native ? 'android' : 'web'),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
    Documents: 'DOCUMENTS',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    readFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      if (runtime.readGate) await runtime.readGate;
      if (runtime.failRead) throw new Error('Native storage read failed');
      const key = `${directory}:${path}`;
      const data = runtime.files.get(key);
      if (data === undefined) throw new Error('File does not exist');
      return { data };
    }),
    writeFile: vi.fn(
      async ({ path, data, directory }: { path: string; data: string; directory: string }) => {
        if (runtime.failWrite) throw new Error('Native storage write failed');
        runtime.files.set(`${directory}:${path}`, data);
        return { uri: `file://${directory}/${path}` };
      },
    ),
    deleteFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      if (runtime.failDelete) throw new Error('Native storage delete failed');
      runtime.files.delete(`${directory}:${path}`);
    }),
  },
}));

import { Filesystem } from '@capacitor/filesystem';
import {
  clearDiagnostics,
  exportDiagnostics,
  getDiagnosticCount,
  hydrateDiagnostics,
  recordDiagnostic,
  subscribeDiagnostics,
} from './log';

describe('diagnostic log', () => {
  beforeEach(async () => {
    runtime.native = false;
    runtime.files.clear();
    runtime.failRead = false;
    runtime.failWrite = false;
    runtime.failDelete = false;
    runtime.readGate = null;
    window.localStorage.clear();
    vi.clearAllMocks();
    await clearDiagnostics();
  });

  it('exports useful response field details without a server URL or request data', () => {
    recordDiagnostic({
      category: 'validation',
      endpoint: 'http://private.example/library/api/Series/v2?apiKey=secret',
      status: 200,
      path: 'items[4].Name',
      expected: 'string or null',
      actualType: 'null',
      detail: 'invalid-field',
      // Extra fields from an untyped caller are deliberately ignored.
      body: { title: 'Private book title', apiKey: 'secret' },
    } as never);

    const text = exportDiagnostics({
      appVersion: '0.3.4+23',
      platform: 'android',
      kavitaVersion: '1.3.10',
    });
    expect(text).toContain('endpoint=/api/Series/v2');
    expect(text).toContain('status=200');
    expect(text).toContain('path=items[4].Name');
    expect(text).toContain('expected=string or null actual=null');
    expect(text).toContain('Platform: android');
    expect(text).toContain('Kavita version: 1.3.10');
    expect(text).not.toContain('private.example');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Private book title');
  });

  it('drops unsafe field paths and unrecognized types and details', () => {
    recordDiagnostic({
      category: 'response',
      endpoint: '/api/Series/v2',
      path: 'books[0].Secret Title',
      expected: 'Very private title',
      actualType: 'Private book title',
      detail: 'Private book title',
    });
    const text = exportDiagnostics({ appVersion: 'test', platform: 'web' });
    expect(text).not.toContain('Secret Title');
    expect(text).not.toContain('Private book title');
  });

  it('retains schema phrases and dollar-prefixed field paths', () => {
    recordDiagnostic({
      category: 'validation',
      endpoint: '/api/Series/series-detail',
      path: '$.series[2].detail',
      expected: 'series detail',
      actualType: 'object',
    });
    recordDiagnostic({
      category: 'validation',
      endpoint: '/api/Series/v2',
      path: '$[0].series',
      expected: 'known format',
      actualType: 'missing',
    });
    const text = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(text).toContain('path=$.series[2].detail expected=series detail actual=object');
    expect(text).toContain('path=$[0].series expected=known format actual=missing');
  });

  it('removes query strings, proxy prefixes, and numeric IDs from endpoints', () => {
    recordDiagnostic({
      category: 'request',
      endpoint: 'https://host.invalid/user-prefix/api/Series/123/cover?token=secret',
    });
    recordDiagnostic({
      category: 'request',
      endpoint: 'https://host.invalid/kavita/api/opds/secret-opds-token/libraries#clients',
    });
    recordDiagnostic({
      category: 'request',
      endpoint: 'https://İ.host.invalid/api-proxy/api/opds/secret-opds-token/api/v1?key=secret',
    });
    const exported = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(exported).toContain('endpoint=/api/Series/:id/cover');
    expect(exported).toContain('endpoint=/api/opds');
    expect(exported).not.toContain('endpoint=/api/v1');
    expect(exported).not.toContain('secret-opds-token');
    expect(exported).not.toContain('host.invalid');
  });

  it('keeps a bounded in-memory ring and can clear it', () => {
    for (let index = 0; index < 120; index += 1) {
      recordDiagnostic({
        category: 'response',
        endpoint: '/api/Series/v2',
        detail: 'invalid-response',
      });
    }
    expect(getDiagnosticCount()).toBe(100);
    expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain('Events: 100');
    void clearDiagnostics();
    expect(getDiagnosticCount()).toBe(0);
  });

  it('caps exported text even if unusually long routes and field paths are supplied', () => {
    for (let index = 0; index < 100; index += 1) {
      recordDiagnostic({
        category: 'validation',
        endpoint: `/api/${'A'.repeat(200)}`,
        path: `field${'A'.repeat(150)}`,
        expected: 'object',
        actualType: 'object',
      });
    }
    expect(
      exportDiagnostics({ appVersion: 'test', platform: 'android' }).length,
    ).toBeLessThanOrEqual(48_000);
  });

  it('records allowlisted startup and setup tokens while redacting raw non-API URLs', () => {
    recordDiagnostic({
      category: 'startup',
      endpoint: 'local/database',
      detail: 'database-open-failed',
    });
    recordDiagnostic({
      category: 'startup',
      endpoint: 'local/credentials',
      detail: 'credential-read-failed',
    });
    recordDiagnostic({
      category: 'validation',
      endpoint: 'https://secret.example.org:8443/custom-login?x-api-key=topsecret',
      detail: 'invalid-server-url',
    });

    const text = exportDiagnostics({ appVersion: '0.3.5', platform: 'android' });
    expect(text).toContain('startup endpoint=local/database detail=database-open-failed');
    expect(text).toContain('startup endpoint=local/credentials detail=credential-read-failed');
    expect(text).toContain('validation endpoint=[unknown endpoint] detail=invalid-server-url');
    expect(text).not.toContain('secret.example.org');
    expect(text).not.toContain('topsecret');
  });

  it('persists to localStorage on web, re-sanitizes on hydrate, and deletes on clear', async () => {
    recordDiagnostic({
      category: 'request',
      endpoint: 'https://private.example/api/Library/libraries?apiKey=secret-token',
      status: 401,
      detail: 'authentication',
    });

    const rawSaved = window.localStorage.getItem('turnleaf_diagnostics_v1');
    expect(rawSaved).toBeTruthy();
    expect(rawSaved).not.toContain('private.example');
    expect(rawSaved).not.toContain('secret-token');

    // Simulate app restart with tampered/unsanitized entries stored in localStorage.
    await clearDiagnostics();
    expect(window.localStorage.getItem('turnleaf_diagnostics_v1')).toBeNull();

    window.localStorage.setItem(
      'turnleaf_diagnostics_v1',
      JSON.stringify([
        {
          at: '2026-11-21T10:00:00.000Z',
          category: 'response',
          endpoint: 'https://leaked-host.example/reverse/api/Series/99?token=leaked-key',
          status: 502,
          path: 'books[0].Secret Book Title',
          detail: 'Leaked error payload',
          apiKey: 'leaked-key',
        },
        {
          at: 'Bearer secret-jwt',
          category: 'startup',
          endpoint: 'local/database',
          detail: 'database-open-failed',
        },
      ]),
    );

    await hydrateDiagnostics();
    expect(getDiagnosticCount()).toBe(2);
    const text = exportDiagnostics({ appVersion: '0.3.5', platform: 'web' });
    expect(text).toContain('2026-11-21T10:00:00.000Z response endpoint=/api/Series/:id status=502');
    expect(text).toContain(
      '1970-01-01T00:00:00.000Z startup endpoint=local/database detail=database-open-failed',
    );
    expect(text).not.toContain('leaked-host.example');
    expect(text).not.toContain('leaked-key');
    expect(text).not.toContain('Secret Book Title');
    expect(text).not.toContain('Leaked error payload');
    expect(text).not.toContain('Bearer');
  });

  it('persists to Directory.Data on native, prepends hydrated entries, trims to 100, and notifies subscribers', async () => {
    runtime.native = true;
    const counts: number[] = [];
    const unsubscribe = subscribeDiagnostics((count) => {
      counts.push(count);
    });

    const olderSaved = Array.from({ length: 98 }, (_, index) => ({
      at: `2026-11-20T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      category: 'request',
      endpoint: `/api/Series/${index + 1}`,
      detail: 'network-error',
    }));
    runtime.files.set('DATA:diagnostics.json', JSON.stringify(olderSaved));

    let resolveRead!: () => void;
    runtime.readGate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });

    const hydration = hydrateDiagnostics();

    // Record 5 new startup/request events before hydrateDiagnostics finishes reading Directory.Data.
    for (let index = 0; index < 5; index += 1) {
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'database-open-failed',
      });
    }
    expect(getDiagnosticCount()).toBe(5);

    resolveRead();
    await hydration;

    expect(getDiagnosticCount()).toBe(100);
    const text = exportDiagnostics({ appVersion: '0.3.5', platform: 'android' });
    // Combined 98 older + 5 newer trims the oldest 3, retaining 95 older + all 5 newer events.
    const lines = text.trim().split('\n');
    expect(lines.at(-1)).toContain('startup endpoint=local/database detail=database-open-failed');
    expect(lines[7]).toContain('2026-11-20T00:00:03.000Z request endpoint=/api/Series/:id');

    expect(Filesystem.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'diagnostics.json',
        directory: 'DATA',
      }),
    );

    await clearDiagnostics();
    expect(getDiagnosticCount()).toBe(0);
    expect(runtime.files.has('DATA:diagnostics.json')).toBe(false);
    expect(Filesystem.deleteFile).toHaveBeenCalledWith({
      path: 'diagnostics.json',
      directory: 'DATA',
    });
    expect(counts.at(-1)).toBe(0);
    unsubscribe();
  });

  it('swallows Directory.Data read, write, and delete failures so error screens never crash', async () => {
    runtime.native = true;
    runtime.failRead = true;
    runtime.failWrite = true;
    runtime.failDelete = true;

    await expect(hydrateDiagnostics()).resolves.toBeUndefined();
    expect(() =>
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'database-open-failed',
      }),
    ).not.toThrow();
    expect(getDiagnosticCount()).toBe(1);
    await expect(clearDiagnostics()).resolves.toBeUndefined();
    expect(getDiagnosticCount()).toBe(0);
  });
});
