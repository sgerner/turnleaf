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
      json: async () => ({ chapterId: 7, pageNum: 9 }),
    });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  const progress = await new KavitaClient('https://books.example.com', 'abc123').getProgress(7);

  expect(progress.pageNum).toBe(9);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
