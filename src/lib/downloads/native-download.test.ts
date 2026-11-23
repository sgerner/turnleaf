// @vitest-environment node

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  body: new Uint8Array(),
  deleted: [] as string[],
  renamed: false,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (value: string) => `web://${value}`,
  },
}));

vi.mock('@capacitor/file-transfer', () => ({
  FileTransfer: {
    downloadFile: vi.fn(),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    stat: vi.fn(),
    mkdir: vi.fn(),
    getUri: vi.fn(),
    readFile: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem } from '@capacitor/filesystem';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import {
  cacheCover,
  downloadEpub,
  EPUB_CONNECT_TIMEOUT_MS,
  EPUB_READ_TIMEOUT_MS,
  verifyDownloadedEpub,
} from './native-download';

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

beforeEach(() => {
  clearDiagnostics();
  native.body = new TextEncoder().encode(`<html>${'server error '.repeat(20)}</html>`);
  native.deleted = [];
  native.renamed = false;
  vi.mocked(FileTransfer.downloadFile)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(Filesystem.mkdir).mockReset().mockResolvedValue(undefined);
  vi.mocked(Filesystem.rename)
    .mockReset()
    .mockImplementation(async () => {
      native.renamed = true;
    });
  vi.mocked(Filesystem.deleteFile)
    .mockReset()
    .mockImplementation(async ({ path }) => {
      native.deleted.push(path);
    });
  vi.mocked(Filesystem.getUri)
    .mockReset()
    .mockImplementation(async ({ path }) => ({
      uri: `file://${path}`,
    }));
  vi.mocked(Filesystem.stat)
    .mockReset()
    .mockImplementation(async ({ path }) => {
      if (path === 'books') throw new Error('missing directory');
      return {
        type: 'file',
        size: native.body.length,
        name: path,
        mtime: 0,
        uri: `file://${path}`,
      };
    });
  vi.mocked(Filesystem.readFile)
    .mockReset()
    .mockImplementation(async ({ offset = 0, length = -1 }) => ({
      data: encoded(native.body.slice(offset, length > 0 ? offset + length : undefined)),
    }));
});

afterEach(() => vi.useRealTimers());

describe('native EPUB download boundary', () => {
  it.each([
    { code: 'OS-PLUG-FLTR-0008' },
    {
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: 503, body: 'private book title', source: 'https://private.example' },
    },
  ])('retries a transient transfer failure and validates the replacement', async (error) => {
    vi.useFakeTimers();
    vi.mocked(FileTransfer.downloadFile)
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => {
        expect(native.deleted).toEqual([
          expect.stringMatching(/^books\/server-book\.[a-z0-9-]+\.epub\.partial$/),
        ]);
        native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
        return {};
      });

    const result = expect(
      downloadEpub('https://private.example/download', 'secret', 'server-book'),
    ).resolves.toMatchObject({ relativePath: 'books/server-book.epub' });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(2);
    for (const [options] of vi.mocked(FileTransfer.downloadFile).mock.calls) {
      expect(options).toMatchObject({
        connectTimeout: EPUB_CONNECT_TIMEOUT_MS,
        readTimeout: EPUB_READ_TIMEOUT_MS,
      });
    }
    expect(vi.mocked(FileTransfer.downloadFile).mock.calls[0]?.[0].path).not.toBe(
      vi.mocked(FileTransfer.downloadFile).mock.calls[1]?.[0].path,
    );
    expect(native.renamed).toBe(true);
    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('endpoint=/api/Download/chapter');
    expect(log).toContain('detail=download-retry');
    if (error.data) expect(log).toContain('status=503');
    expect(log).not.toMatch(/private|secret|server-book/);
  });

  it.each([
    { status: 403, attempts: 1 },
    { status: 503, attempts: 2 },
  ])('stops after $attempts attempt(s) on HTTP $status', async ({ status, attempts }) => {
    vi.useFakeTimers();
    vi.mocked(FileTransfer.downloadFile).mockRejectedValue({
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: status },
    });
    const result = expect(
      downloadEpub('https://books.example.com/download', 'secret', 'server-book'),
    ).rejects.toMatchObject({ status });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(attempts);
    expect(native.deleted).toHaveLength(attempts);
    expect(native.renamed).toBe(false);
  });

  it('removes an HTML/error body from the partial path before rename', async () => {
    await expect(
      downloadEpub('https://books.example.com/download', 'secret', 'server-book'),
    ).rejects.toThrow(/EPUB|ZIP|container/i);

    expect(native.renamed).toBe(false);
    expect(native.deleted).toEqual([
      expect.stringMatching(/^books\/server-book\.[a-z0-9-]+\.epub\.partial$/),
    ]);
    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('passes explicit bounded timeouts and records redacted timeout diagnostics', async () => {
    vi.useFakeTimers();
    vi.mocked(FileTransfer.downloadFile).mockRejectedValue({
      code: 'OS-PLUG-FLTR-0011',
      message:
        'The operation failed with an error - Read timed out at https://private.example/secret-book',
      data: { exception: 'SocketTimeoutException: connect timed out' },
    });

    const result = expect(
      downloadEpub(
        'https://private.example/api/Download/chapter?chapterId=9&apiKey=secret-key',
        'secret-key',
        'secret-book-title',
      ),
    ).rejects.toMatchObject({ timedOut: true });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(EPUB_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(EPUB_READ_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(2);
    expect(FileTransfer.downloadFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
    );
    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('detail=download-timeout');
    expect(log).not.toMatch(/private\.example|secret-key|secret-book/);
  });

  it('rejects immediately with AbortError when cancelled mid-transfer and isolates attempt files', async () => {
    let resolveStalledTransfer: ((value: unknown) => void) | undefined;
    vi.mocked(FileTransfer.downloadFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStalledTransfer = resolve;
        }) as never,
    );

    const controller = new AbortController();
    const stalledPromise = downloadEpub(
      'https://private.example/download',
      'secret-api-key',
      'Secret-Book',
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1));
    const cancelledAttemptUri = vi.mocked(FileTransfer.downloadFile).mock.calls[0]?.[0].path;
    controller.abort();

    await expect(stalledPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.renamed).toBe(false);

    // Start a fresh download before the stalled native transfer settles.
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    vi.mocked(FileTransfer.downloadFile).mockResolvedValueOnce({} as never);
    await expect(
      downloadEpub('https://private.example/download', 'secret-api-key', 'Secret-Book'),
    ).resolves.toMatchObject({ relativePath: 'books/Secret-Book.epub' });

    const secondAttemptUri = vi.mocked(FileTransfer.downloadFile).mock.calls[1]?.[0].path;
    expect(secondAttemptUri).not.toBe(cancelledAttemptUri);

    // When the stalled native transfer finally settles, only its isolated partial path is deleted.
    resolveStalledTransfer?.({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.deleted).not.toContain('books/Secret-Book.epub');
    expect(
      native.deleted.filter((path) => `file://${path}` === cancelledAttemptUri).length,
    ).toBeGreaterThanOrEqual(2);

    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('detail=download-cancelled');
    expect(log).not.toMatch(/private\.example|secret-api-key|Secret-Book/i);
  });

  it('skips the retry delay and exits immediately when cancelled during backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({ code: 'OS-PLUG-FLTR-0008' });

    const pending = downloadEpub(
      'https://books.example.com/download',
      'secret',
      'server-book',
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1));
    controller.abort();

    // Rejects without advancing the 750 ms retry timer and without making a second attempt.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1);
    expect(native.renamed).toBe(false);
  });

  it('does not inspect or delete a path outside the private books directory', async () => {
    await expect(verifyDownloadedEpub('../outside.epub')).resolves.toBeNull();
    expect(Filesystem.stat).not.toHaveBeenCalled();
    expect(Filesystem.deleteFile).not.toHaveBeenCalled();
  });

  it.each(['stat', 'readFile', 'getUri'] as const)(
    'preserves the EPUB when %s fails and allows a later retry',
    async (operation) => {
      native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
      vi.mocked(Filesystem[operation]).mockRejectedValueOnce(new Error('Temporary storage error'));

      await expect(verifyDownloadedEpub('books/book.epub')).rejects.toThrow(
        'Temporary storage error',
      );
      expect(native.deleted).toEqual([]);
      await expect(verifyDownloadedEpub('books/book.epub')).resolves.toMatchObject({
        relativePath: 'books/book.epub',
      });
    },
  );

  it('preserves a downloaded EPUB when the filesystem returns a short read', async () => {
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    vi.mocked(Filesystem.readFile).mockResolvedValueOnce({ data: '' });

    await expect(verifyDownloadedEpub('books/book.epub')).rejects.toThrow('read was incomplete');
    expect(native.deleted).toEqual([]);
  });

  it('distinguishes a missing file from a transient filesystem error', async () => {
    vi.mocked(Filesystem.stat).mockRejectedValueOnce({ code: 'OS-PLUG-FILE-0008' });
    await expect(verifyDownloadedEpub('books/book.epub')).resolves.toBeNull();
    expect(native.deleted).toEqual([]);
  });

  it('clears a file whose contents fail EPUB validation', async () => {
    await expect(verifyDownloadedEpub('books/book.epub')).resolves.toBeNull();
    expect(native.deleted).toEqual(['books/book.epub']);
  });
});

describe('native cover cache', () => {
  it('serves a cached cover without checking or creating its parent directories', async () => {
    await expect(cacheCover('https://books.example.com/cover', 'secret', 7)).resolves.toBe(
      'web://file://covers/default/7.img',
    );

    expect(Filesystem.stat).toHaveBeenCalledExactlyOnceWith({
      path: 'covers/default/7.img',
      directory: 'DATA',
    });
    expect(Filesystem.mkdir).not.toHaveBeenCalled();
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
  });

  it('re-evaluates a dynamic allowDownload check after filesystem setup so offline transitions skip FileTransfer', async () => {
    let online = true;
    vi.mocked(Filesystem.stat).mockRejectedValue({ code: 'OS-PLUG-FILE-0008' });
    vi.mocked(Filesystem.getUri).mockImplementationOnce(async ({ path }) => {
      online = false;
      return { uri: `file://${path}` };
    });

    await expect(
      cacheCover('https://books.example.com/cover', 'secret', 7, undefined, 'srv-1', () => online),
    ).rejects.toThrow('Offline');

    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
  });
});
