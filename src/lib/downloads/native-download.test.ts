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
    rename: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem } from '@capacitor/filesystem';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import {
  getCredentialState,
  markCredentialMissing,
  markCredentialRejected,
  resetCredentialState,
  syncLoadedCredential,
} from '../native/credentials';
import { cacheCover, downloadEpub, verifyDownloadedEpub } from './native-download';

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

beforeEach(() => {
  clearDiagnostics();
  resetCredentialState();
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
        expect(native.deleted).toEqual(['books/server-book.epub.partial']);
        native.body = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
        return {};
      });

    const result = expect(
      downloadEpub('https://private.example/download', 'secret', 'server-book'),
    ).resolves.toMatchObject({ relativePath: 'books/server-book.epub' });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(2);
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
    expect(native.deleted).toContain('books/server-book.epub.partial');
    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1);
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
        'https://books.example.com',
      ),
    ).rejects.toThrow('redirected too many times');

    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(6);
    expect(native.renamed).toBe(false);
    expect(native.deleted).toContain('books/server-book.epub.partial');
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
        downloadEpub(initialUrl, 'secret', 'server-book', undefined, serverOrigin),
      ).rejects.toThrow(expectedMessage);

      expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(redirects.length);
      for (const [options] of vi.mocked(FileTransfer.downloadFile).mock.calls) {
        expect(options.disableRedirects).toBe(true);
        expect(new URL(options.url).origin).toBe(serverOrigin);
      }
      expect(native.renamed).toBe(false);
      expect(native.deleted).toContain('books/server-book.epub.partial');
    },
  );

  it('rejects an EPUB transfer when the initial URL does not match the configured server origin', async () => {
    await expect(
      downloadEpub(
        'https://other.example.com/download',
        'secret',
        'server-book',
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

  it('continues serving cached local covers during credential lockout while skipping uncached transfers', async () => {
    const state = syncLoadedCredential('stale-key', 'server_primary_api_key');
    markCredentialRejected(state.epoch, 401);

    await expect(
      cacheCover(
        'https://books.example.com/cover',
        'stale-key',
        7,
        undefined,
        'primary',
        true,
        undefined,
        state.epoch,
      ),
    ).resolves.toBe('web://file://covers/primary/7.img');
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();

    vi.mocked(Filesystem.stat).mockRejectedValueOnce({ code: 'OS-PLUG-FILE-0008' });
    await expect(
      cacheCover(
        'https://books.example.com/cover',
        'stale-key',
        8,
        undefined,
        'primary',
        true,
        undefined,
        state.epoch,
      ),
    ).rejects.toThrow('Offline');
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();

    vi.mocked(Filesystem.stat).mockRejectedValueOnce({ code: 'OS-PLUG-FILE-0008' });
    await expect(cacheCover('https://books.example.com/cover', '   ', 9)).rejects.toThrow(
      'Offline',
    );
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
  });

  it('marks credentials rejected and logs a sanitized diagnostic on HTTP 401 or 403 cover responses', async () => {
    const state = syncLoadedCredential('stale-key', 'server_primary_api_key');
    vi.mocked(Filesystem.stat).mockRejectedValue({ code: 'OS-PLUG-FILE-0008' });
    vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: 401, source: 'https://private.example/cover' },
    });

    await expect(
      cacheCover(
        'https://private.example/cover',
        'stale-key',
        12,
        undefined,
        'primary',
        true,
        undefined,
        state.epoch,
      ),
    ).rejects.toMatchObject({ code: 'OS-PLUG-FLTR-0010', data: { httpStatus: 401 } });

    expect(getCredentialState()).toEqual({
      status: 'rejected',
      epoch: state.epoch,
      statusCode: 401,
    });
    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('endpoint=/api/Image/series-cover');
    expect(log).toContain('status=401');
    expect(log).not.toMatch(/private\.example|stale-key/);
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

describe('native EPUB credential gating', () => {
  it('refuses EPUB downloads with blank or rejected credentials without starting FileTransfer', async () => {
    await expect(
      downloadEpub('https://books.example.com/download', '   ', 'server-book'),
    ).rejects.toMatchObject({ status: 401 });
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();

    const state = syncLoadedCredential('stale-key', 'server_primary_api_key');
    markCredentialRejected(state.epoch, 401);
    await expect(
      downloadEpub(
        'https://books.example.com/download',
        'stale-key',
        'server-book',
        undefined,
        undefined,
        state.epoch,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
  });

  it('marks credentials rejected on EPUB HTTP 401 while keeping HTTP 403 permission errors distinct', async () => {
    const state = syncLoadedCredential('valid-key', 'server_primary_api_key');
    vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: 403 },
    });

    await expect(
      downloadEpub(
        'https://books.example.com/download',
        'valid-key',
        'server-book',
        undefined,
        undefined,
        state.epoch,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(getCredentialState()).toEqual({ status: 'ready', epoch: state.epoch });

    vi.mocked(FileTransfer.downloadFile).mockRejectedValueOnce({
      code: 'OS-PLUG-FLTR-0010',
      data: { httpStatus: 401 },
    });
    await expect(
      downloadEpub(
        'https://books.example.com/download',
        'valid-key',
        'server-book',
        undefined,
        undefined,
        state.epoch,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(getCredentialState()).toEqual({
      status: 'rejected',
      epoch: state.epoch,
      statusCode: 401,
    });
  });

  it('aborts EPUB retry and uncached cover transfer when credentials become missing during async setup', async () => {
    vi.useFakeTimers();
    const state = syncLoadedCredential('valid-key', 'server_primary_api_key');
    vi.mocked(FileTransfer.downloadFile).mockImplementationOnce(async () => {
      markCredentialMissing('server_primary_api_key');
      throw { code: 'OS-PLUG-FLTR-0008' };
    });

    const downloadAttempt = expect(
      downloadEpub(
        'https://books.example.com/download',
        'valid-key',
        'server-book',
        undefined,
        undefined,
        state.epoch,
      ),
    ).rejects.toBeDefined();
    await Promise.all([downloadAttempt, vi.runAllTimersAsync()]);
    expect(FileTransfer.downloadFile).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    const coverState = syncLoadedCredential('valid-key', 'server_primary_api_key');
    vi.mocked(FileTransfer.downloadFile).mockClear();
    vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => {
      if (path === 'covers/primary/99.img') {
        throw { code: 'OS-PLUG-FILE-0008' };
      }
      if (path === 'covers/primary') {
        markCredentialMissing('server_primary_api_key');
        throw { code: 'OS-PLUG-FILE-0008' };
      }
      return {
        type: 'file',
        size: 0,
        name: path,
        mtime: 0,
        uri: `file://${path}`,
      };
    });

    await expect(
      cacheCover(
        'https://books.example.com/cover',
        'valid-key',
        99,
        undefined,
        'primary',
        true,
        'https://books.example.com',
        coverState.epoch,
      ),
    ).rejects.toThrow('Offline');
    expect(FileTransfer.downloadFile).not.toHaveBeenCalled();
  });

  it('trips the credential breaker when an aborted cover transfer returns HTTP 401 and discards partial files if credentials become missing mid-transfer', async () => {
    const firstState = syncLoadedCredential('stale-cover-key', 'server_primary_api_key');
    const abortController = new AbortController();
    vi.mocked(Filesystem.stat).mockRejectedValue({ code: 'OS-PLUG-FILE-0008' });
    vi.mocked(FileTransfer.downloadFile).mockImplementationOnce(async () => {
      abortController.abort();
      throw { code: 'OS-PLUG-FLTR-0010', data: { httpStatus: 401 } };
    });

    await expect(
      cacheCover(
        'https://books.example.com/cover',
        'stale-cover-key',
        42,
        abortController.signal,
        'primary',
        true,
        'https://books.example.com',
        firstState.epoch,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCredentialState()).toEqual({
      status: 'rejected',
      epoch: firstState.epoch,
      statusCode: 401,
    });

    const secondState = syncLoadedCredential('active-key', 'server_primary_api_key');
    vi.mocked(Filesystem.rename).mockClear();
    vi.mocked(FileTransfer.downloadFile).mockImplementationOnce(async () => {
      markCredentialMissing('server_primary_api_key');
      return { path: 'file://books/server-book.epub.partial' };
    });

    await expect(
      downloadEpub(
        'https://books.example.com/download',
        'active-key',
        'server-book',
        undefined,
        'https://books.example.com',
        secondState.epoch,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Filesystem.rename).not.toHaveBeenCalled();
    expect(native.deleted).toContain('books/server-book.epub.partial');
  });
});
