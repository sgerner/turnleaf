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

it('builds authenticated cover URLs with the api key query parameter', () => {
  const client = new KavitaClient('https://books.example.com', 'abc123');
  expect(client.coverUrl(4)).toBe(
    'https://books.example.com/api/Image/series-cover?seriesId=4&apiKey=abc123',
  );
});

it('builds authenticated download URLs with the api key query parameter', () => {
  const client = new KavitaClient('https://books.example.com', 'key with spaces');
  expect(client.downloadUrl(42)).toBe(
    'https://books.example.com/api/Download/chapter?chapterId=42&apiKey=key%20with%20spaces',
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
