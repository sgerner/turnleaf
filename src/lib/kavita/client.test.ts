// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { KavitaClient, KavitaError, KavitaOfflineError } from './client';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import {
  getCredentialState,
  markCredentialMissing,
  markCredentialUnreadable,
  resetCredentialState,
  saveApiKey,
  syncLoadedCredential,
} from '../native/credentials';

const capacitorRuntime = vi.hoisted(() => ({ native: false, connected: true }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitorRuntime.native,
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: capacitorRuntime.connected,
      connectionType: capacitorRuntime.connected ? 'wifi' : 'none',
    })),
  },
}));

beforeEach(() => {
  clearDiagnostics();
  resetCredentialState();
  capacitorRuntime.native = false;
  capacitorRuntime.connected = true;
  vi.mocked(Network.getStatus)
    .mockReset()
    .mockImplementation(async () => ({
      connected: capacitorRuntime.connected,
      connectionType: capacitorRuntime.connected ? 'wifi' : 'none',
    }));
  vi.mocked(CapacitorHttp.get).mockReset();
  vi.mocked(CapacitorHttp.request).mockReset();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [],
    blob: async () => new Blob(),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

it('builds cover URLs without putting the api key in the query string', () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');
  expect(client.coverUrl(4)).toBe('https://books.example.com/api/Image/series-cover?seriesId=4');
});

it('builds download URLs without putting the api key in the query string', () => {
  const client = new KavitaClient('https://books.example.com', 'key with spaces');
  expect(client.downloadUrl(42)).toBe(
    'https://books.example.com/api/Download/chapter?chapterId=42',
  );
});

it('loads covers with the api key header', async () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');

  const cover = await client.getCover(4);

  expect(cover).toBeInstanceOf(Blob);
  expect(fetch).toHaveBeenCalledWith(
    'https://books.example.com/api/Image/series-cover?seriesId=4',
    expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({
        'x-api-key': 'abc123',
      }),
    }),
  );
});

it('does not duplicate cover loading on native platforms where covers stream via FileTransfer', async () => {
  capacitorRuntime.native = true;
  const client = new KavitaClient('https://books.example.com', 'abc123');

  await expect(client.getCover(4)).rejects.toThrow('cacheCover');
  expect(CapacitorHttp.get).not.toHaveBeenCalled();
  expect(CapacitorHttp.request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('requests the Kavita series list with POST and an EPUB format filter', async () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');

  await client.getBookSeries();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    'https://books.example.com/api/Series/v2?PageNumber=1&PageSize=500',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        statements: [{ field: 21, comparison: 5, value: '3' }],
        combination: 0,
        sortOptions: { sortField: 1, isAscending: true },
        limitTo: 0,
      }),
      redirect: 'manual',
      headers: expect.objectContaining({
        'x-api-key': 'abc123',
      }),
    }),
  );
});

it('follows same-origin GET redirects', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 302,
      type: 'basic',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location' ? '/api/Series/series-detail/?seriesId=4' : null,
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      type: 'basic',
      headers: { get: () => null },
      json: async () => ({ chapters: [], specials: [], volumes: [], storylineChapters: [] }),
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await new KavitaClient('https://books.example.com', 'abc123').getSeriesDetail(4);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    redirect: 'manual',
    headers: { 'x-api-key': 'abc123' },
  });
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    'https://books.example.com/api/Series/series-detail/?seriesId=4',
  );
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    headers: { 'x-api-key': 'abc123' },
  });
});

it('follows same-origin POST redirects only when they preserve the method', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 307,
      type: 'basic',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location' ? '/api/Series/v2/?PageNumber=1&PageSize=500' : null,
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      type: 'basic',
      headers: { get: () => null },
      json: async () => [],
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await new KavitaClient('https://books.example.com', 'abc123').getBookSeries();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    headers: { 'x-api-key': 'abc123' },
  });
});

it('rejects cross-origin redirects before sending the auth key to the new origin', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 307,
    type: 'basic',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'location' ? 'https://other.example.com/api/Series/v2' : null,
    },
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toThrow('Kavita redirected to a different server');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects HTTPS-to-HTTP downgrade redirects before sending the auth key over HTTP', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 307,
    type: 'basic',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'location' ? 'http://books.example.com/api/Series/v2' : null,
    },
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toThrow('redirected from HTTPS to insecure HTTP');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects POST redirects that would change the request method', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 302,
    type: 'basic',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'location' ? '/api/Series/v2/' : null),
    },
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toThrow('redirected a POST request');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('explains browser redirects whose destination cannot be inspected safely', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 0,
    type: 'opaqueredirect',
    headers: { get: () => null },
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toThrow('browser could not safely verify the destination');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('follows native same-origin redirects with redirects disabled on each request', async () => {
  capacitorRuntime.native = true;
  vi.mocked(CapacitorHttp.request)
    .mockResolvedValueOnce({
      status: 307,
      headers: { Location: '/api/Series/v2/?PageNumber=1&PageSize=500' },
      data: '',
      url: '',
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '[]',
      url: '',
    });

  await new KavitaClient('https://books.example.com/kavita', 'abc123').getBookSeries();

  expect(CapacitorHttp.request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(CapacitorHttp.request).mock.calls[0]?.[0]).toMatchObject({
    url: 'https://books.example.com/kavita/api/Series/v2?PageNumber=1&PageSize=500',
    method: 'POST',
    data: {
      statements: [{ field: 21, comparison: 5, value: '3' }],
      combination: 0,
      sortOptions: { sortField: 1, isAscending: true },
      limitTo: 0,
    },
    disableRedirects: true,
    headers: { 'x-api-key': 'abc123' },
  });
  expect(vi.mocked(CapacitorHttp.request).mock.calls[1]?.[0]).toMatchObject({
    url: 'https://books.example.com/api/Series/v2/?PageNumber=1&PageSize=500',
    disableRedirects: true,
  });
});

it('preserves a Kavita base path in URLs used for covers and downloads', () => {
  const client = new KavitaClient('https://books.example.com/kavita/', 'abc123');

  expect(client.coverUrl(4)).toBe(
    'https://books.example.com/kavita/api/Image/series-cover?seriesId=4',
  );
  expect(client.downloadUrl(42)).toBe(
    'https://books.example.com/kavita/api/Download/chapter?chapterId=42',
  );
});

it('loads every series page for large libraries', async () => {
  const page = Array.from({ length: 500 }, (_, id) => ({
    id,
    name: `Book ${id}`,
    libraryId: 1,
    format: 3,
    pages: 1,
    pagesRead: 0,
    created: '2026-01-01',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: '',
  }));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => page,
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ ...page[0], id: 500, name: 'Book 500' }],
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  const series = await new KavitaClient('https://books.example.com', 'abc123').getBookSeries();

  expect(series).toHaveLength(501);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'https://books.example.com/api/Series/v2?PageNumber=2&PageSize=500',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('rejects malformed series payloads at the response boundary', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ unexpected: true }),
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toMatchObject({
    kind: 'invalid-response',
  });
});

it('accepts nullable optional series metadata without relaxing required series data', async () => {
  const payload = [
    {
      id: 1,
      name: null,
      libraryId: 1,
      format: 3,
      pages: 12,
      pagesRead: 0,
      created: '2026-09-01',
      latestReadDate: '0001-01-01T00:00:00',
      coverImage: null,
    },
  ];
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).resolves.toEqual(payload);
});

it('keeps missing series progress unknown instead of rejecting the library or inventing zero', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [
      {
        id: 1,
        name: null,
        libraryId: 1,
        format: 3,
        pages: 12,
        created: '2026-09-01',
        latestReadDate: '0001-01-01T00:00:00',
      },
    ],
  } as unknown as Response);

  const series = await new KavitaClient('https://books.example.com', 'abc123').getBookSeries();
  expect(series).toHaveLength(1);
  expect(series[0]?.pagesRead).toBeUndefined();
});

it('accepts Kavita chapter fields that its DTO defines as nullable', async () => {
  const detail = {
    chapters: [
      {
        id: 5,
        title: 'Chapter',
        titleName: 'Chapter',
        volumeId: 4,
        pages: 10,
        pagesRead: 0,
        summary: '',
        format: null,
        files: [{ id: 5, bytes: 1000, extension: null, format: 3 }],
        writers: [],
      },
    ],
    specials: [],
    volumes: [],
    storylineChapters: [],
  };
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => detail,
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getSeriesDetail(4),
  ).resolves.toMatchObject({
    ...detail,
    chapters: [{ ...detail.chapters[0], format: 3, lastReadingProgressUtc: null }],
  });
});

it('rejects a repeated series across pagination pages', async () => {
  const page = Array.from({ length: 500 }, (_, id) => ({
    id,
    name: `Book ${id}`,
    libraryId: 1,
    format: 3,
    pages: 1,
    pagesRead: 0,
    created: '2026-01-01',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: '',
  }));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => page,
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [page[0]],
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toMatchObject({
    kind: 'invalid-response',
  });
});

it.each([[[2, 4]], [[4]]])(
  'connects to supported EPUB library types %j',
  async (supportedTypes) => {
    const libraries = [...supportedTypes, 0, 1, 3, 5, 6].map((type, id) => ({
      id,
      name: `Library ${id}`,
      type,
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => libraries,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ version: 'test' }),
      } as unknown as Response);

    const result = await new KavitaClient('https://books.example.com', 'abc123').testConnection();

    expect(result.bookLibraries.map((library) => library.type)).toEqual(supportedTypes);
  },
);

it('rejects malformed library elements without inventing a server connection', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [{ id: 'not-an-id', name: 'Books', type: '2' }],
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').testConnection(),
  ).rejects.toMatchObject({
    kind: 'invalid-response',
  });
});

it('rejects malformed series details before callers map them', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ chapters: [], volumes: 'not-an-array' }),
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getSeriesDetail(4),
  ).rejects.toMatchObject({ kind: 'invalid-response' });
});

it('classifies malformed JSON as an invalid response', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Response);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getBookSeries(),
  ).rejects.toMatchObject({
    kind: 'invalid-response',
    message: 'Kavita returned malformed JSON at /api/Series/v2.',
  });
  expect(exportDiagnostics({ appVersion: 'test', platform: 'web' })).toContain(
    'validation endpoint=/api/Series/v2 detail=invalid-json',
  );
});

it('classifies native malformed JSON as an invalid response and ignores blank native bodies', async () => {
  capacitorRuntime.native = true;
  vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
    status: 200,
    headers: {},
    url: '',
    data: '{not-json',
  });

  const client = new KavitaClient('https://books.example.com', 'abc123');
  await expect(client.getBookSeries()).rejects.toMatchObject({
    kind: 'invalid-response',
    message: 'Kavita returned malformed JSON at /api/Series/v2.',
  });
  expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain(
    'validation endpoint=/api/Series/v2 detail=invalid-json',
  );

  clearDiagnostics();
  vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
    status: 200,
    headers: {},
    url: '',
    data: '   ',
  });
  await expect(
    client.saveProgress({
      libraryId: 1,
      seriesId: 2,
      volumeId: 3,
      chapterId: 4,
      pageNum: 5,
    }),
  ).resolves.toBeUndefined();
  expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain('Events: 0');
});

it('falls back cleanly when /api/Health returns non-JSON on browser and native transports', async () => {
  const libraries = [{ id: 1, name: 'Books', type: 2 }];
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => libraries,
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Ok');
      },
    } as unknown as Response);

  const client = new KavitaClient('https://books.example.com', 'abc123');
  await expect(client.testConnection()).resolves.toEqual({
    version: null,
    bookLibraries: libraries,
  });
  expect(exportDiagnostics({ appVersion: 'test', platform: 'web' })).toContain('Events: 0');

  capacitorRuntime.native = true;
  vi.mocked(CapacitorHttp.request)
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      url: '',
      data: JSON.stringify(libraries),
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      url: '',
      data: 'Ok',
    });

  await expect(client.testConnection()).resolves.toEqual({
    version: null,
    bookLibraries: libraries,
  });
  expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain('Events: 0');
});

it('distinguishes browser request timeouts from caller aborts and clears timers', async () => {
  vi.useFakeTimers();
  try {
    const abortableFetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', abortableFetch as unknown as typeof fetch);

    const client = new KavitaClient('https://books.example.com', 'abc123');

    const timedOut = expect(client.getSeriesDetail(4)).rejects.toMatchObject({
      kind: 'network',
      message: 'Kavita did not respond in time.',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await timedOut;
    expect(vi.getTimerCount()).toBe(0);

    const caller = new AbortController();
    const abortedByCaller = expect(client.getSeriesDetail(4, caller.signal)).rejects.toMatchObject({
      kind: 'network',
      message: 'Kavita could not be reached. Check the address and network.',
    });
    caller.abort();
    await abortedByCaller;
    expect(vi.getTimerCount()).toBe(0);

    const coverCaller = new AbortController();
    const abortedCover = expect(client.getCover(4, coverCaller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    coverCaller.abort();
    await abortedCover;
    expect(vi.getTimerCount()).toBe(0);

    const timedOutCover = expect(client.getCover(4)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await timedOutCover;
    expect(vi.getTimerCount()).toBe(0);

    let resolveJson: ((value: unknown) => void) | undefined;
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        }),
    } as unknown as Response);
    const pendingSeries = client.getBookSeries();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    resolveJson?.([]);
    await expect(pendingSeries).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('omits response diagnostics when getCover receives an error status while request and nativeRequest record them', async () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 404,
    headers: { get: () => null },
  } as unknown as Response);

  await expect(client.getCover(4)).rejects.toMatchObject({
    kind: 'server',
    status: 404,
  });
  expect(exportDiagnostics({ appVersion: 'test', platform: 'web' })).toContain('Events: 0');

  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 401,
    headers: { get: () => null },
  } as unknown as Response);
  await expect(client.getBookSeries()).rejects.toMatchObject({
    kind: 'authentication',
    status: 401,
  });

  capacitorRuntime.native = true;
  const nativeClient = new KavitaClient('https://books.example.com', 'native-key');
  vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
    status: 503,
    headers: {},
    url: '',
    data: '',
  });
  await expect(nativeClient.getSeriesDetail(4)).rejects.toMatchObject({
    kind: 'server',
    status: 503,
  });

  const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
  expect(log).toContain('response endpoint=/api/Series/v2 status=401');
  expect(log).toContain('response endpoint=/api/Series/series-detail status=503');
});

it('retries a transient 5xx progress read once', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        libraryId: 1,
        seriesId: 2,
        volumeId: 3,
        chapterId: 7,
        pageNum: 9,
      }),
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  const progress = await new KavitaClient('https://books.example.com', 'abc123').getProgress(7);

  expect(progress.pageNum).toBe(9);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not retry a progress read that returns not found', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await expect(
    new KavitaClient('https://books.example.com', 'abc123').getProgress(7),
  ).rejects.toMatchObject({
    kind: 'server',
    status: 404,
  });

  expect(fetchMock).toHaveBeenCalledOnce();
});

it('normalizes native HTTP JSON strings and exposes field diagnostics without server secrets', async () => {
  capacitorRuntime.native = true;
  vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
    status: 200,
    headers: {},
    url: '',
    data: JSON.stringify([
      {
        id: '12',
        libraryId: '1',
        format: 3,
        name: null,
        pages: null,
        pagesRead: null,
        latestReadDate: null,
      },
    ]),
  });
  const client = new KavitaClient('http://private.example:5000', 'private-api-key');
  await expect(client.getBookSeries()).resolves.toMatchObject([{ id: 12, pages: 0 }]);
  vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
    status: 200,
    headers: {},
    url: '',
    data: JSON.stringify({
      chapters: [
        { id: 'secret-book-title', volumeId: 1, format: 3, files: [{ id: 4, format: 3 }] },
      ],
    }),
  });
  await expect(client.getSeriesDetail(12)).rejects.toThrow(
    '$.chapters[0].id: expected integer, received string',
  );
  const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
  expect(log).not.toContain('status=200');
  expect(log).toContain('path=series[12].chapters[0].id');
  expect(log).toContain('actual=string');
  expect(log).not.toContain('private.example');
  expect(log).not.toContain('private-api-key');
  expect(log).not.toContain('secret-book-title');
});

it('uses the raw page length to continue pagination after excluding unrelated media', async () => {
  const mixed: Record<string, unknown>[] = Array.from({ length: 499 }, () => ({ format: 0 }));
  mixed.push({ id: 1, libraryId: 1, format: 3 });
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => mixed,
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ id: 2, libraryId: 1, format: 3 }],
    } as unknown as Response);
  const series = await new KavitaClient('http://books.example', 'key').getBookSeries();
  expect(series.map((item) => item.id)).toEqual([1, 2]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects duplicate EPUB IDs within a single page before reconciliation', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [
      { id: 1, libraryId: 1, format: 3 },
      { id: 1, libraryId: 1, format: 3 },
    ],
  } as unknown as Response);
  await expect(new KavitaClient('http://books.example', 'key').getBookSeries()).rejects.toThrow(
    'repeated series page',
  );
});

it('never sends empty or whitespace x-api-key headers on browser or native requests', async () => {
  const browserClient = new KavitaClient('https://books.example.com', '   ');
  expect(browserClient.canSendRequests()).toBe(false);
  await expect(browserClient.getBookSeries()).rejects.toThrow(KavitaError);
  await expect(browserClient.getCover(4)).rejects.toThrow('Enter a Kavita auth key.');
  expect(fetch).not.toHaveBeenCalled();

  capacitorRuntime.native = true;
  const nativeClient = new KavitaClient('https://books.example.com', '');
  await expect(nativeClient.getProgress(1)).rejects.toThrow('Enter a Kavita auth key.');
  expect(CapacitorHttp.request).not.toHaveBeenCalled();
});

it('trips the central credential breaker on 401 and 403 and blocks follow-up requests', async () => {
  const loaded = syncLoadedCredential('stale-key', 'server_primary_api_key');
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 401,
    headers: { get: () => null },
  } as unknown as Response);

  const client = new KavitaClient('https://books.example.com', 'stale-key', {
    credentialEpoch: loaded.epoch,
  });
  await expect(client.getBookSeries()).rejects.toMatchObject({
    kind: 'authentication',
    status: 401,
  });
  expect(getCredentialState()).toEqual({
    status: 'rejected',
    epoch: loaded.epoch,
    statusCode: 401,
  });

  const secondClient = new KavitaClient('https://books.example.com', 'stale-key', {
    credentialEpoch: loaded.epoch,
  });
  expect(secondClient.canSendRequests()).toBe(false);
  await expect(secondClient.getCover(4)).rejects.toMatchObject({
    kind: 'authentication',
    status: 401,
  });
  await expect(secondClient.getProgress(1)).rejects.toMatchObject({
    kind: 'authentication',
    status: 401,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('ignores a late 401 from an older client epoch after a replacement key is saved', async () => {
  const stale = syncLoadedCredential('stale-key', 'server_primary_api_key');
  let rejectInFlight!: (response: Response) => void;
  vi.mocked(fetch)
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          rejectInFlight = resolve;
        }),
    )
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [],
    } as unknown as Response);

  const staleClient = new KavitaClient('https://books.example.com', 'stale-key', {
    credentialEpoch: stale.epoch,
  });
  const pending = staleClient.getBookSeries();

  await saveApiKey('server_primary_api_key', 'fresh-key');
  const freshEpoch = getCredentialState().epoch;
  const freshClient = new KavitaClient('https://books.example.com', 'fresh-key', {
    credentialEpoch: freshEpoch,
  });

  rejectInFlight({
    ok: false,
    status: 401,
    headers: { get: () => null },
  } as unknown as Response);
  await expect(pending).rejects.toMatchObject({ kind: 'authentication', status: 401 });

  expect(getCredentialState()).toEqual({ status: 'ready', epoch: freshEpoch });
  expect(freshClient.canSendRequests()).toBe(true);
  await expect(freshClient.getBookSeries()).resolves.toEqual([]);
});

it('allows testConnection probes for a replacement key while saved credentials are rejected', async () => {
  const stale = syncLoadedCredential('stale-key', 'server_primary_api_key');
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 401,
    headers: { get: () => null },
  } as unknown as Response);
  await expect(
    new KavitaClient('https://books.example.com', 'stale-key', {
      credentialEpoch: stale.epoch,
    }).getBookSeries(),
  ).rejects.toThrow('Kavita rejected this auth key.');
  expect(getCredentialState().status).toBe('rejected');

  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ id: 1, name: 'Books', type: 2 }],
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ version: '0.8.8' }),
    } as unknown as Response);

  const probeResult = await new KavitaClient(
    'https://books.example.com',
    'replacement-key',
  ).testConnection();
  expect(probeResult).toEqual({
    version: '0.8.8',
    bookLibraries: [{ id: 1, name: 'Books', type: 2 }],
  });
});

it('trips the credential breaker when an in-flight native request returns 401 after abort', async () => {
  capacitorRuntime.native = true;
  const loaded = syncLoadedCredential('stale-key', 'server_primary_api_key');
  const controller = new AbortController();
  vi.mocked(CapacitorHttp.request).mockImplementationOnce(async () => {
    controller.abort();
    return {
      status: 401,
      headers: {},
      url: 'https://books.example.com/api/Series/v2',
      data: '',
    };
  });

  const client = new KavitaClient('https://books.example.com', 'stale-key', {
    credentialEpoch: loaded.epoch,
  });
  await expect(client.getBookSeries(controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(getCredentialState()).toEqual({
    status: 'rejected',
    epoch: loaded.epoch,
    statusCode: 401,
  });
  expect(client.canSendRequests()).toBe(false);
});

it('blocks non-probe requests and getProgress retries when credentials become missing or unreadable', async () => {
  capacitorRuntime.native = true;
  markCredentialMissing(null);

  const staleClient = new KavitaClient('https://books.example.com', 'leftover-key');
  expect(staleClient.canSendRequests()).toBe(false);
  await expect(staleClient.getBookSeries()).rejects.toMatchObject({
    kind: 'authentication',
  });
  expect(CapacitorHttp.request).not.toHaveBeenCalled();

  markCredentialUnreadable('server_primary_api_key');
  const unreadableClient = new KavitaClient('https://books.example.com', 'leftover-key');
  expect(unreadableClient.canSendRequests()).toBe(false);
  await expect(unreadableClient.getBookSeries()).rejects.toMatchObject({
    kind: 'authentication',
  });
  expect(CapacitorHttp.request).not.toHaveBeenCalled();

  // Probe requests for a candidate replacement key remain allowed while saved credentials are missing/unreadable
  vi.mocked(CapacitorHttp.request)
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      url: '',
      data: JSON.stringify([{ id: 1, name: 'Books', type: 2 }]),
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      url: '',
      data: JSON.stringify({ version: '0.8.9' }),
    });
  await expect(
    new KavitaClient('https://books.example.com', 'candidate-key').testConnection(),
  ).resolves.toEqual({
    version: '0.8.9',
    bookLibraries: [{ id: 1, name: 'Books', type: 2 }],
  });

  // getProgress does not retry a transient error if credentials become missing mid-request
  capacitorRuntime.native = false;
  const active = syncLoadedCredential('active-key', 'server_primary_api_key');
  const activeClient = new KavitaClient('https://books.example.com', 'active-key', {
    credentialEpoch: active.epoch,
  });
  const fetchMock = vi.fn().mockImplementationOnce(async () => {
    markCredentialMissing('server_primary_api_key');
    return {
      ok: false,
      status: 500,
      headers: { get: () => null },
    };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await expect(activeClient.getProgress(7)).rejects.toMatchObject({
    kind: 'server',
    status: 500,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects tampered baseUrl values before sending x-api-key over browser or native requests', async () => {
  for (const unsafeBaseUrl of [
    'ftp://books.example.com',
    'file:///etc/passwd',
    'https://user:pass@books.example.com',
    'https://books.example.com?api_key=leak',
    'https://books.example.com#fragment',
  ]) {
    await expect(new KavitaClient(unsafeBaseUrl, 'secret-key').getBookSeries()).rejects.toThrow(
      'Invalid Kavita server address.',
    );
    await expect(new KavitaClient(unsafeBaseUrl, 'secret-key').testConnection()).rejects.toThrow(
      'Invalid Kavita server address.',
    );
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(CapacitorHttp.request).not.toHaveBeenCalled();
});

it('gates initial, retry, and redirect dispatches against live native Network.getStatus() and beforeDispatch hooks', async () => {
  capacitorRuntime.native = true;
  const loaded = syncLoadedCredential('live-key', 'server_primary_api_key');
  const onOffline = vi.fn();

  // 1) Initial dispatch blocked when live native Network.getStatus() reports disconnected
  capacitorRuntime.connected = false;
  const client = new KavitaClient('https://books.example.com', 'live-key', {
    credentialEpoch: loaded.epoch,
    onOffline,
  });

  await expect(client.getBookSeries()).rejects.toBeInstanceOf(KavitaOfflineError);
  await expect(
    client.saveProgress({
      volumeId: 1,
      chapterId: 1,
      pageNum: 10,
      seriesId: 1,
      libraryId: 1,
      bookScrollId: null,
    }),
  ).rejects.toBeInstanceOf(KavitaOfflineError);
  expect(CapacitorHttp.request).not.toHaveBeenCalled();
  expect(onOffline).toHaveBeenCalledTimes(2);

  // 2) getProgress retry blocked when live native connectivity drops after attempt 1
  capacitorRuntime.connected = true;
  onOffline.mockClear();
  vi.mocked(CapacitorHttp.request).mockImplementationOnce(async () => {
    capacitorRuntime.connected = false;
    return {
      status: 503,
      headers: {},
      url: 'https://books.example.com/api/Reader/get-progress?chapterId=7',
      data: '',
    };
  });

  await expect(client.getProgress(7)).rejects.toBeInstanceOf(KavitaOfflineError);
  expect(CapacitorHttp.request).toHaveBeenCalledTimes(1);
  expect(onOffline).toHaveBeenCalledTimes(1);

  // 3) Native 307 redirect hop blocked when live native connectivity drops after hop 1
  capacitorRuntime.connected = true;
  onOffline.mockClear();
  vi.mocked(CapacitorHttp.request).mockReset();
  vi.mocked(CapacitorHttp.request).mockImplementationOnce(async () => {
    capacitorRuntime.connected = false;
    return {
      status: 307,
      headers: { location: '/next/api/Series/v2?PageNumber=1&PageSize=500' },
      url: 'https://books.example.com/api/Series/v2?PageNumber=1&PageSize=500',
      data: '',
    };
  });

  await expect(client.getBookSeries()).rejects.toBeInstanceOf(KavitaOfflineError);
  expect(CapacitorHttp.request).toHaveBeenCalledTimes(1);
  expect(onOffline).toHaveBeenCalledTimes(1);

  // 4) beforeDispatch hook blocks a second redirect hop in browser mode without leaking x-api-key
  capacitorRuntime.native = false;
  let hopAllowed = true;
  const gatedBrowserClient = new KavitaClient('https://books.example.com', 'live-key', {
    credentialEpoch: loaded.epoch,
    beforeDispatch: () => {
      if (!hopAllowed) throw new KavitaOfflineError();
    },
  });
  const redirectFetch = vi.fn().mockImplementationOnce(async () => {
    hopAllowed = false;
    return {
      ok: false,
      status: 307,
      type: 'basic',
      headers: { get: (name: string) => (name === 'location' ? '/redirected/series' : null) },
    };
  });
  vi.stubGlobal('fetch', redirectFetch as unknown as typeof fetch);

  await expect(gatedBrowserClient.getBookSeries()).rejects.toBeInstanceOf(KavitaOfflineError);
  expect(redirectFetch).toHaveBeenCalledTimes(1);

  // 5) Microtask offline transition right after Network.getStatus() resolves (without aborting
  //    init.signal, matching saveProgress during handleOfflineTransition) still blocks dispatch
  capacitorRuntime.native = true;
  capacitorRuntime.connected = true;
  vi.mocked(CapacitorHttp.request).mockReset();
  let libraryOffline = false;
  vi.mocked(Network.getStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        queueMicrotask(() => {
          resolve({ connected: true, connectionType: 'cellular' });
          queueMicrotask(() => {
            libraryOffline = true;
          });
        });
      }),
  );
  const microtaskGatedClient = new KavitaClient('https://books.example.com', 'live-key', {
    credentialEpoch: loaded.epoch,
    beforeDispatch: () => {
      if (libraryOffline) throw new KavitaOfflineError();
    },
  });
  const unAbortedSyncController = new AbortController();
  await expect(
    microtaskGatedClient.saveProgress(
      {
        volumeId: 1,
        chapterId: 1,
        pageNum: 12,
        seriesId: 1,
        libraryId: 1,
        bookScrollId: null,
      },
      unAbortedSyncController.signal,
    ),
  ).rejects.toBeInstanceOf(KavitaOfflineError);
  expect(CapacitorHttp.request).not.toHaveBeenCalled();
});
