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
    addListener: vi.fn(),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    stat: vi.fn(),
    mkdir: vi.fn(),
    getUri: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem } from '@capacitor/filesystem';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import {
  cacheCover,
  deleteDownloadedEpub,
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
  vi.mocked(FileTransfer.addListener)
    .mockReset()
    .mockResolvedValue({ remove: vi.fn(async () => {}) });
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
  vi.mocked(Filesystem.writeFile)
    .mockReset()
    .mockImplementation(async ({ data }) => {
      if (typeof data === 'string') {
        const binary = atob(data);
        native.body = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }
      return { uri: 'file://books/written.epub' };
    });
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
        'The operation failed with an error - Read timed out at https://private.example/secret-book (x-api-key=secret-key)',
      data: { exception: 'SocketTimeoutException: connect timed out' },
    });

    const result = expect(
      downloadEpub(
        'https://private.example/api/Download/chapter?chapterId=9&title=secret-book',
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
    // The partial file is not unlinked while FileTransfer is still writing to it.
    expect(native.deleted.filter((path) => `file://${path}` === cancelledAttemptUri)).toHaveLength(
      0,
    );

    // Start a fresh download before the stalled native transfer settles.
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    vi.mocked(FileTransfer.downloadFile).mockResolvedValueOnce({} as never);
    await expect(
      downloadEpub('https://private.example/download', 'secret-api-key', 'Secret-Book'),
    ).resolves.toMatchObject({ relativePath: 'books/Secret-Book.epub' });

    const secondAttemptUri = vi.mocked(FileTransfer.downloadFile).mock.calls[1]?.[0].path;
    expect(secondAttemptUri).not.toBe(cancelledAttemptUri);
    expect(native.deleted.filter((path) => `file://${path}` === cancelledAttemptUri)).toHaveLength(
      0,
    );

    // When the stalled native transfer finally settles, only its isolated partial path is deleted once.
    resolveStalledTransfer?.({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.deleted).not.toContain('books/Secret-Book.epub');
    expect(native.deleted.filter((path) => `file://${path}` === cancelledAttemptUri)).toHaveLength(
      1,
    );

    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('detail=download-cancelled');
    expect(log).not.toMatch(/private\.example|secret-api-key|Secret-Book/i);
  });

  it('rolls back finalPath when aborted during Filesystem.rename even if a newer attempt fails', async () => {
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    const diskFiles = new Set<string>();
    let resolveFirstRename: (() => void) | undefined;
    vi.mocked(Filesystem.rename).mockImplementationOnce(
      ({ from, to }) =>
        new Promise<void>((resolve) => {
          resolveFirstRename = () => {
            diskFiles.delete(from);
            diskFiles.add(to);
            native.renamed = true;
            resolve();
          };
        }),
    );
    vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
      diskFiles.delete(path);
      native.deleted.push(path);
    });

    const controller = new AbortController();
    const first = downloadEpub(
      'https://books.example.com/download',
      'secret',
      'race-fail-book',
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(Filesystem.rename).toHaveBeenCalledTimes(1));
    const firstPartial = vi.mocked(Filesystem.rename).mock.calls[0]?.[0].from as string;
    diskFiles.add(firstPartial);

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    // Start a second download for the same book that fails non-retryably (404),
    // which previously cleared latestAttemptByBook in its finally block.
    vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: 404 },
    });
    await expect(
      downloadEpub('https://books.example.com/download', 'secret', 'race-fail-book'),
    ).rejects.toThrow();

    resolveFirstRename?.();
    await vi.waitFor(() => expect(native.deleted).toContain('books/race-fail-book.epub'));
    expect(diskFiles.has('books/race-fail-book.epub')).toBe(false);
    expect(native.deleted).not.toContain(firstPartial);
  });

  it('serializes an aborted in-flight Filesystem.rename before a replacement download commits', async () => {
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    const disk = new Map<string, string>();
    const ops: string[] = [];
    let resolveFirstRename: (() => void) | undefined;

    vi.mocked(Filesystem.rename)
      .mockImplementationOnce(
        ({ from, to }) =>
          new Promise<void>((resolve) => {
            resolveFirstRename = () => {
              ops.push(`rename:1:${from}->${to}`);
              disk.delete(from);
              disk.set(to, 'attempt-1');
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async ({ from, to }) => {
        ops.push(`rename:2:${from}->${to}`);
        disk.delete(from);
        disk.set(to, 'attempt-2');
      });
    vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
      ops.push(`delete:${path}`);
      disk.delete(path);
      native.deleted.push(path);
    });

    const controller = new AbortController();
    const first = downloadEpub(
      'https://books.example.com/download',
      'secret',
      'race-replace-book',
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(Filesystem.rename).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const second = downloadEpub(
      'https://books.example.com/download',
      'secret',
      'race-replace-book',
    );
    // Second download cannot rename until the first attempt's locked rename + rollback completes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Filesystem.rename).toHaveBeenCalledTimes(1);

    resolveFirstRename?.();
    const secondFile = await second;
    expect(secondFile.relativePath).toBe('books/race-replace-book.epub');
    expect(secondFile.ownerToken).toEqual(expect.any(Number));
    expect(disk.get('books/race-replace-book.epub')).toBe('attempt-2');
    expect(ops).toEqual([
      expect.stringMatching(
        /^rename:1:books\/race-replace-book\..+\.epub\.partial->books\/race-replace-book\.epub$/,
      ),
      'delete:books/race-replace-book.epub',
      expect.stringMatching(
        /^rename:2:books\/race-replace-book\..+\.epub\.partial->books\/race-replace-book\.epub$/,
      ),
    ]);
  });

  it('orders deleteDownloadedEpub after an in-flight Filesystem.rename and skips stale owner tokens', async () => {
    native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
    const disk = new Set<string>(['books/race-delete-book.epub']);
    let resolveRename: (() => void) | undefined;

    vi.mocked(Filesystem.rename).mockImplementationOnce(
      ({ from, to }) =>
        new Promise<void>((resolve) => {
          resolveRename = () => {
            disk.delete(from);
            disk.add(to);
            resolve();
          };
        }),
    );
    vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
      disk.delete(path);
      native.deleted.push(path);
    });

    const controller = new AbortController();
    const redownload = downloadEpub(
      'https://books.example.com/download',
      'secret',
      'race-delete-book',
      undefined,
      controller.signal,
      undefined,
      { preserveExistingOnAbort: true },
    );
    await vi.waitFor(() => expect(Filesystem.rename).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(redownload).rejects.toMatchObject({ name: 'AbortError' });

    const explicitDelete = deleteDownloadedEpub('books/race-delete-book.epub');
    resolveRename?.();
    await explicitDelete;
    expect(disk.has('books/race-delete-book.epub')).toBe(false);

    // Next fresh download owns the path; a stale ownerToken cleanup must not delete it.
    vi.mocked(Filesystem.rename).mockImplementationOnce(async ({ from, to }) => {
      disk.delete(from);
      disk.add(to);
    });
    const fresh = await downloadEpub(
      'https://books.example.com/download',
      'secret',
      'race-delete-book',
    );
    await deleteDownloadedEpub('books/race-delete-book.epub', (fresh.ownerToken ?? 1) - 1);
    expect(disk.has('books/race-delete-book.epub')).toBe(true);
  });

  it('defers partial file deletion until repaired-archive writeFile settles on abort', async () => {
    vi.stubGlobal(
      'DOMParser',
      class {
        parseFromString() {
          return {
            documentElement: {
              localName: 'package',
              namespaceURI: 'http://www.idpf.org/2007/opf',
              children: [
                { localName: 'metadata', children: [] },
                {
                  localName: 'manifest',
                  children: [
                    {
                      localName: 'item',
                      getAttribute: (attr: string) =>
                        attr === 'id' ? 'chapter' : attr === 'href' ? 'chapter.xhtml' : null,
                    },
                  ],
                },
                {
                  localName: 'spine',
                  children: [
                    {
                      localName: 'itemref',
                      getAttribute: (attr: string) => (attr === 'idref' ? 'chapter' : null),
                    },
                  ],
                },
              ],
            },
          };
        }
      },
    );
    try {
      const write16 = (bytes: Uint8Array, offset: number, value: number) => {
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >>> 8) & 0xff;
      };
      const write32 = (bytes: Uint8Array, offset: number, value: number) => {
        write16(bytes, offset, value);
        write16(bytes, offset + 2, value / 0x10000);
      };
      const entries = [
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
        {
          name: 'OEBPS/content.opf',
          data: new TextEncoder().encode(
            '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>' +
              '<item id="chapter" href="chapter.xhtml"/></manifest>' +
              '<spine><itemref idref="chapter"/></spine></package>',
          ),
        },
        { name: 'OEBPS/chapter.xhtml', data: new TextEncoder().encode('<html/>') },
      ].map((entry) => ({ name: new TextEncoder().encode(entry.name), data: entry.data }));
      const localSize = entries.reduce(
        (sum, entry) => sum + 30 + entry.name.length + entry.data.length,
        0,
      );
      const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
      const repairable = new Uint8Array(localSize + centralSize + 22);
      let offset = 0;
      const localOffsets: number[] = [];
      for (const entry of entries) {
        localOffsets.push(offset);
        write32(repairable, offset, 0x04034b50);
        write16(repairable, offset + 4, 20);
        write16(repairable, offset + 26, entry.name.length);
        offset += 30;
        repairable.set(entry.name, offset);
        offset += entry.name.length;
        repairable.set(entry.data, offset);
        offset += entry.data.length;
      }
      const centralOffset = offset;
      entries.forEach((entry, index) => {
        write32(repairable, offset, 0x02014b50);
        write16(repairable, offset + 4, 20);
        write16(repairable, offset + 6, 20);
        write16(repairable, offset + 28, entry.name.length);
        write32(repairable, offset + 20, entry.data.length);
        write32(repairable, offset + 24, entry.data.length);
        write32(repairable, offset + 42, localOffsets[index]!);
        offset += 46;
        repairable.set(entry.name, offset);
        offset += entry.name.length;
      });
      write32(repairable, offset, 0x06054b50);
      write16(repairable, offset + 8, entries.length);
      write16(repairable, offset + 10, entries.length);
      write32(repairable, offset + 12, centralSize);
      write32(repairable, offset + 16, centralOffset);
      native.body = repairable;

      let resolveWrite: (() => void) | undefined;
      let writtenPath = '';
      vi.mocked(Filesystem.writeFile).mockImplementationOnce(
        ({ path }) =>
          new Promise((resolve) => {
            writtenPath = path;
            resolveWrite = () => resolve({ uri: `file://${path}` });
          }),
      );

      const controller = new AbortController();
      const pending = downloadEpub(
        'https://books.example.com/download',
        'secret',
        'repaired-abort-book',
        undefined,
        controller.signal,
      );
      await vi.waitFor(() => expect(Filesystem.writeFile).toHaveBeenCalledTimes(1));

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(native.deleted).not.toContain(writtenPath);

      resolveWrite?.();
      await vi.waitFor(() => expect(native.deleted).toContain(writtenPath));
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('disables automatic redirects, follows up to five same-origin 3xx hops, and tracks active hop progress', async () => {
    let progressHandler:
      | ((event: {
          type: 'download' | 'upload';
          url: string;
          bytes: number;
          contentLength: number;
          lengthComputable: boolean;
        }) => void)
      | undefined;
    const removeListener = vi.fn(async () => {});
    vi.mocked(FileTransfer.addListener).mockImplementationOnce(async (_event, callback) => {
      progressHandler = callback;
      return { remove: removeListener };
    });

    const hops = [
      '/kavita/download/step-1',
      '/kavita/download/step-2',
      'https://books.example.com/kavita/download/step-3',
      '/kavita/download/step-4',
      '/kavita/download/final?chapterId=42',
    ];
    for (const location of hops) {
      vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
        code: 'OS-PLUG-FLTR-0010',
        data: { httpStatus: 302, headers: { Location: location } },
      });
    }
    vi.mocked(FileTransfer.downloadFile).mockImplementationOnce(async ({ url }) => {
      progressHandler?.({
        type: 'download',
        url: 'https://books.example.com/api/Download/chapter?chapterId=42',
        bytes: 10,
        contentLength: 100,
        lengthComputable: true,
      });
      progressHandler?.({
        type: 'download',
        url,
        bytes: 64,
        contentLength: 100,
        lengthComputable: true,
      });
      native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
      return {};
    });

    const progressUpdates: number[] = [];
    await expect(
      downloadEpub(
        'https://books.example.com/api/Download/chapter?chapterId=42',
        'secret',
        'server-book',
        (percent) => progressUpdates.push(percent),
        undefined,
        'https://books.example.com',
      ),
    ).resolves.toMatchObject({ relativePath: 'books/server-book.epub' });

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(6);
    for (const [options] of vi.mocked(FileTransfer.downloadFile).mock.calls) {
      expect(options).toMatchObject({
        disableRedirects: true,
        headers: { 'x-api-key': 'secret' },
      });
    }
    expect(vi.mocked(FileTransfer.downloadFile).mock.calls[5]?.[0].url).toBe(
      'https://books.example.com/kavita/download/final?chapterId=42',
    );
    expect(progressUpdates).toEqual([64]);
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('rejects more than five same-origin redirect hops during EPUB download', async () => {
    for (let step = 1; step <= 6; step += 1) {
      vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
        code: 'OS-PLUG-FLTR-0010',
        data: { httpStatus: 302, headers: { location: `/download/step-${step}` } },
      });
    }

    await expect(
      downloadEpub(
        'https://books.example.com/download',
        'secret',
        'server-book',
        undefined,
        undefined,
        'https://books.example.com',
      ),
    ).rejects.toThrow('redirected too many times');

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(6);
    expect(native.renamed).toBe(false);
    expect(native.deleted).toEqual([
      expect.stringMatching(/^books\/server-book\.[a-z0-9-]+\.epub\.partial$/),
    ]);
  });

  it.each([
    {
      label: 'redirect loop',
      initialUrl: 'https://books.example.com/download',
      serverOrigin: 'https://books.example.com',
      redirects: ['/download/hop', '/download'],
      expectedMessage: 'redirected in a loop',
    },
    {
      label: 'cross-origin redirect',
      initialUrl: 'https://books.example.com/download',
      serverOrigin: 'https://books.example.com',
      redirects: ['https://attacker.example/download'],
      expectedMessage: 'redirected to a different server',
    },
    {
      label: 'HTTPS-to-HTTP downgrade',
      initialUrl: 'https://books.example.com/download',
      serverOrigin: 'https://books.example.com',
      redirects: ['http://books.example.com/download'],
      expectedMessage: 'redirected from HTTPS to insecure HTTP',
    },
    {
      label: 'embedded credentials in redirect',
      initialUrl: 'https://books.example.com/download',
      serverOrigin: 'https://books.example.com',
      redirects: ['https://reader:secret@books.example.com/download'],
      expectedMessage: 'redirected to a different server',
    },
    {
      label: 'sensitive query parameter in redirect',
      initialUrl: 'https://books.example.com/download',
      serverOrigin: 'https://books.example.com',
      redirects: ['/download?apiKey=leaked'],
      expectedMessage: 'redirected to a different server',
    },
  ])(
    'rejects $label in EPUB transfer before sending credentials to the unsafe target',
    async ({ initialUrl, serverOrigin, redirects, expectedMessage }) => {
      for (const location of redirects) {
        vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
          code: 'OS-PLUG-FLTR-0010',
          data: { httpStatus: 307, headers: { Location: location } },
        });
      }

      await expect(
        downloadEpub(initialUrl, 'secret', 'server-book', undefined, undefined, serverOrigin),
      ).rejects.toThrow(expectedMessage);

      expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(redirects.length);
      for (const [options] of vi.mocked(FileTransfer.downloadFile).mock.calls) {
        expect(options.disableRedirects).toBe(true);
        expect(new URL(options.url).origin).toBe(serverOrigin);
      }
      expect(native.renamed).toBe(false);
      expect(native.deleted).toEqual([
        expect.stringMatching(/^books\/server-book\.[a-z0-9-]+\.epub\.partial$/),
      ]);
    },
  );

  it('rejects an EPUB transfer when the initial URL does not match the configured server origin', async () => {
    await expect(
      downloadEpub(
        'https://other.example.com/download',
        'secret',
        'server-book',
        undefined,
        undefined,
        'https://books.example.com',
      ),
    ).rejects.toThrow('redirected to a different server');

    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
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

  it('follows validated same-origin 3xx cover redirects with disableRedirects enabled', async () => {
    let downloaded = false;
    vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => {
      if (path === 'covers/server-1') throw new Error('missing directory');
      if (path === 'covers/server-1/7.img' && !downloaded) throw new Error('uncached');
      return {
        type: 'file',
        size: 68,
        name: path,
        mtime: 0,
        uri: `file://${path}`,
      };
    });
    vi.mocked(FileTransfer.downloadFile)
      .mockRejectedValueOnce({
        code: 'OS-PLUG-FLTR-0010',
        data: {
          httpStatus: 302,
          headers: { Location: '/kavita/api/Image/series-cover?seriesId=7' },
        },
      })
      .mockImplementationOnce(async () => {
        downloaded = true;
        return {};
      });

    await expect(
      cacheCover(
        'https://books.example.com/api/Image/series-cover?seriesId=7',
        'secret',
        7,
        undefined,
        'server-1',
        true,
        'https://books.example.com',
      ),
    ).resolves.toBe('web://file://covers/server-1/7.img');

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(FileTransfer.downloadFile).mock.calls[0]?.[0]).toMatchObject({
      url: 'https://books.example.com/api/Image/series-cover?seriesId=7',
      disableRedirects: true,
      headers: { 'x-api-key': 'secret' },
    });
    expect(vi.mocked(FileTransfer.downloadFile).mock.calls[1]?.[0]).toMatchObject({
      url: 'https://books.example.com/kavita/api/Image/series-cover?seriesId=7',
      disableRedirects: true,
      headers: { 'x-api-key': 'secret' },
    });
    expect(native.renamed).toBe(true);
  });

  it.each([
    {
      label: 'loop',
      redirects: ['/cover/next', '/cover'],
      expectedMessage: 'redirected in a loop',
    },
    {
      label: 'cross-origin',
      redirects: ['https://cdn.other.example/cover.png'],
      expectedMessage: 'redirected to a different server',
    },
    {
      label: 'HTTPS downgrade',
      redirects: ['http://books.example.com/cover'],
      expectedMessage: 'redirected from HTTPS to insecure HTTP',
    },
  ])(
    'rejects $label cover redirects without leaking x-api-key and cleans up partial cover files',
    async ({ redirects, expectedMessage }) => {
      vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => {
        if (path === 'covers/server-1' || path === 'covers/server-1/7.img') {
          throw new Error('missing');
        }
        return {
          type: 'file',
          size: 0,
          name: path,
          mtime: 0,
          uri: `file://${path}`,
        };
      });
      for (const location of redirects) {
        vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
          code: 'OS-PLUG-FLTR-0010',
          data: { httpStatus: 302, headers: { location } },
        });
      }

      await expect(
        cacheCover(
          'https://books.example.com/cover',
          'secret',
          7,
          undefined,
          'server-1',
          true,
          'https://books.example.com',
        ),
      ).rejects.toThrow(expectedMessage);

      expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(redirects.length);
      for (const [options] of vi.mocked(FileTransfer.downloadFile).mock.calls) {
        expect(options.disableRedirects).toBe(true);
        expect(new URL(options.url).origin).toBe('https://books.example.com');
      }
      expect(native.renamed).toBe(false);
      expect(native.deleted).toContain('covers/server-1/7.img.partial');
    },
  );
});
