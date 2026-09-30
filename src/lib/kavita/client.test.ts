import { beforeEach, expect, it, vi } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { KavitaClient } from './client';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';

const capacitorRuntime = vi.hoisted(() => ({ native: false }));

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

beforeEach(() => {
  clearDiagnostics();
  capacitorRuntime.native = false;
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

  await client.getCover(4);

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

it('requests the Kavita series list with POST', async () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');

  await client.getBookSeries();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    'https://books.example.com/api/Series/v2?PageNumber=1&PageSize=500',
    expect.objectContaining({
      method: 'POST',
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
  });
});

it('retries a failed progress read once', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 401,
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
  expect(log).toContain('status=200');
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
