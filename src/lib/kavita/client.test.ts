import { beforeEach, expect, it, vi } from 'vitest';
import { KavitaClient } from './client';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

beforeEach(() => {
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
      headers: expect.objectContaining({
        'x-api-key': 'abc123',
      }),
    }),
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
    json: async () => [{ id: 1, name: 'Books', type: '2' }],
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
    json: async () => ({ chapters: [] }),
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
