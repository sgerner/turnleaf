// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ANDROID_PERMISSIONS,
  assertMergedManifestPermissions,
  extractManifestPermissions,
  mergedManifestPath,
} from '../../../scripts/check-android-manifest.mjs';

const native = vi.hoisted(() => ({
  body: new Uint8Array(),
  deleted: [] as string[],
  renamed: false,
  connected: true,
  progressListener: null as
    | ((event: {
        transferId?: string;
        url?: string;
        bytes: number;
        contentLength: number;
        lengthComputable: boolean;
      }) => void)
    | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (value: string) => `web://${value}`,
  },
}));

vi.mock('../native/private-transfer', () => ({
  PRIVATE_TRANSFER_CONNECTION_FAILED: 'PRIVATE_TRANSFER_CONNECTION_FAILED',
  PrivateTransfer: {
    downloadFile: vi.fn(),
    abortTransfer: vi.fn(),
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
    readdir: vi.fn(),
    rmdir: vi.fn(),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: native.connected,
      connectionType: native.connected ? 'wifi' : 'none',
    })),
  },
}));

import { Filesystem } from '@capacitor/filesystem';
import { Network } from '@capacitor/network';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import { PRIVATE_TRANSFER_CONNECTION_FAILED, PrivateTransfer } from '../native/private-transfer';
import { cacheCover, downloadEpub, verifyDownloadedEpub } from './native-download';

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

beforeEach(() => {
  clearDiagnostics();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  native.body = new TextEncoder().encode(`<html>${'server error '.repeat(20)}</html>`);
  native.deleted = [];
  native.renamed = false;
  native.connected = true;
  native.progressListener = null;
  vi.mocked(Network.getStatus)
    .mockReset()
    .mockImplementation(async () => ({
      connected: native.connected,
      connectionType: native.connected ? 'wifi' : 'none',
    }));
  vi.mocked(PrivateTransfer.downloadFile)
    .mockReset()
    .mockResolvedValue({ status: 200, bytesWritten: 64 });
  vi.mocked(PrivateTransfer.abortTransfer).mockReset().mockResolvedValue(undefined);
  vi.mocked(PrivateTransfer.addListener)
    .mockReset()
    .mockImplementation(async (_event, listener) => {
      native.progressListener = listener;
      return { remove: vi.fn(async () => {}) };
    });
  vi.mocked(Filesystem.mkdir).mockReset().mockResolvedValue(undefined);
  vi.mocked(Filesystem.readdir).mockReset().mockResolvedValue({ files: [] });
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
    { reject: { code: PRIVATE_TRANSFER_CONNECTION_FAILED }, expectedStatus: undefined },
    {
      resolve: { status: 503, bytesWritten: 0 },
      expectedStatus: 503,
    },
  ])('retries a transient transfer failure and validates the replacement', async (scenario) => {
    vi.useFakeTimers();
    if ('reject' in scenario && scenario.reject) {
      vi.mocked(PrivateTransfer.downloadFile).mockRejectedValueOnce(scenario.reject);
    } else if ('resolve' in scenario && scenario.resolve) {
      vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce(scenario.resolve);
    }
    vi.mocked(PrivateTransfer.downloadFile).mockImplementationOnce(async () => {
      expect(native.deleted).toEqual(['books/server-book.epub.partial']);
      const epubBytes = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
      native.body = epubBytes;
      return { status: 200, bytesWritten: epubBytes.length };
    });

    const result = expect(
      downloadEpub('https://private.example/download', 'secret', 'server-book'),
    ).resolves.toMatchObject({ relativePath: 'books/server-book.epub' });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(2);
    expect(native.renamed).toBe(true);
    const log = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(log).toContain('endpoint=/api/Download/chapter');
    expect(log).toContain('detail=download-retry');
    if (scenario.expectedStatus) expect(log).toContain(`status=${scenario.expectedStatus}`);
    expect(log).not.toMatch(/private|secret|server-book/);
  });

  it.each([
    { status: 403, attempts: 1 },
    { status: 503, attempts: 2 },
  ])('stops after $attempts attempt(s) on HTTP $status', async ({ status, attempts }) => {
    vi.useFakeTimers();
    vi.mocked(PrivateTransfer.downloadFile).mockResolvedValue({
      status,
      bytesWritten: 0,
    });
    const result = expect(
      downloadEpub('https://books.example.com/download', 'secret', 'server-book'),
    ).rejects.toMatchObject({ status });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(attempts);
    expect(native.deleted).toHaveLength(attempts);
    expect(native.renamed).toBe(false);
  });

  it('removes an HTML/error body from the partial path before rename', async () => {
    await expect(
      downloadEpub('https://books.example.com/download', 'secret', 'server-book'),
    ).rejects.toThrow(/EPUB|ZIP|container/i);

    expect(native.renamed).toBe(false);
    expect(native.deleted).toContain('books/server-book.epub.partial');
    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(1);
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

  it('follows up to five same-origin 3xx hops and tracks active hop progress by transferId', async () => {
    const removeListener = vi.fn(async () => {});
    vi.mocked(PrivateTransfer.addListener).mockImplementationOnce(async (_event, callback) => {
      native.progressListener = callback;
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
      vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce({
        status: 302,
        location,
        bytesWritten: 0,
      });
    }
    vi.mocked(PrivateTransfer.downloadFile).mockImplementationOnce(async ({ transferId }) => {
      const staleHopId = vi.mocked(PrivateTransfer.downloadFile).mock.calls[0]?.[0].transferId;
      native.progressListener?.({
        ...(staleHopId ? { transferId: staleHopId } : {}),
        bytes: 10,
        contentLength: 100,
        lengthComputable: true,
      });
      native.progressListener?.({
        ...(transferId ? { transferId } : {}),
        bytes: 64,
        contentLength: 100,
        lengthComputable: true,
      });
      const epubBytes = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
      native.body = epubBytes;
      return { status: 200, bytesWritten: epubBytes.length };
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

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(6);
    for (const [options] of vi.mocked(PrivateTransfer.downloadFile).mock.calls) {
      expect(options).toMatchObject({
        relativePath: 'books/server-book.epub.partial',
        headers: { 'x-api-key': 'secret' },
      });
    }
    expect(vi.mocked(PrivateTransfer.downloadFile).mock.calls[5]?.[0].url).toBe(
      'https://books.example.com/kavita/download/final?chapterId=42',
    );
    expect(progressUpdates).toEqual([64]);
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('rejects more than five same-origin redirect hops during EPUB download', async () => {
    for (let step = 1; step <= 6; step += 1) {
      vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce({
        status: 302,
        location: `/download/step-${step}`,
        bytesWritten: 0,
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

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(6);
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
      label: 'fragment-only redirect loop',
      initialUrl: 'https://books.example.com/download#start',
      serverOrigin: 'https://books.example.com',
      redirects: ['/download#again'],
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
        vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce({
          status: 307,
          location,
          bytesWritten: 0,
        });
      }

      await expect(
        downloadEpub(initialUrl, 'secret', 'server-book', undefined, serverOrigin),
      ).rejects.toThrow(expectedMessage);

      expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(redirects.length);
      for (const [options] of vi.mocked(PrivateTransfer.downloadFile).mock.calls) {
        expect(options.relativePath).toBe('books/server-book.epub.partial');
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

    expect(PrivateTransfer.downloadFile).not.toHaveBeenCalled();
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
    expect(PrivateTransfer.downloadFile).not.toHaveBeenCalled();
  });

  it('streams a missing cover into app-private storage and renames atomically', async () => {
    vi.mocked(Filesystem.stat)
      .mockRejectedValueOnce({ code: 'OS-PLUG-FILE-0008' })
      .mockRejectedValueOnce({ code: 'OS-PLUG-FILE-0008' })
      .mockResolvedValueOnce({
        type: 'file',
        size: 128,
        name: 'covers/server_1/7.img.partial',
        mtime: 0,
        uri: 'file://covers/server_1/7.img.partial',
      });

    await expect(
      cacheCover('https://books.example.com/cover', 'secret', 7, undefined, 'server:1'),
    ).resolves.toBe('web://file://covers/server_1/7.img');

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: 'https://books.example.com/cover',
        relativePath: 'covers/server_1/7.img.partial',
        headers: { 'x-api-key': 'secret' },
        connectTimeout: 5_000,
        readTimeout: 5_000,
        transferId: expect.stringMatching(/^transfer-\d+-hop-0$/),
      }),
    );
    expect(Filesystem.rename).toHaveBeenCalledExactlyOnceWith({
      from: 'covers/server_1/7.img.partial',
      to: 'covers/server_1/7.img',
      directory: 'DATA',
    });
  });

  it('aborts an in-flight native cover stream and deletes the partial file when AbortSignal fires', async () => {
    vi.mocked(Filesystem.stat).mockRejectedValue({ code: 'OS-PLUG-FILE-0008' });
    const controller = new AbortController();
    let capturedTransferId: string | undefined;
    vi.mocked(PrivateTransfer.downloadFile).mockImplementationOnce(
      ({ transferId }) =>
        new Promise((_resolve, reject) => {
          capturedTransferId = transferId;
          controller.signal.addEventListener(
            'abort',
            () => reject({ code: PRIVATE_TRANSFER_CONNECTION_FAILED }),
            { once: true },
          );
          controller.abort();
        }),
    );

    await expect(
      cacheCover('https://books.example.com/cover', 'secret', 7, controller.signal),
    ).rejects.toMatchObject({ code: PRIVATE_TRANSFER_CONNECTION_FAILED });

    expect(capturedTransferId).toBeDefined();
    expect(PrivateTransfer.abortTransfer).toHaveBeenCalledExactlyOnceWith({
      transferId: capturedTransferId,
    });
    expect(native.deleted).toContain('covers/default/7.img.partial');
  });

  it('follows validated same-origin 3xx cover redirects into app-private storage', async () => {
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
    vi.mocked(PrivateTransfer.downloadFile)
      .mockResolvedValueOnce({
        status: 302,
        location: '/kavita/api/Image/series-cover?seriesId=7',
        bytesWritten: 0,
      })
      .mockImplementationOnce(async () => {
        downloaded = true;
        return { status: 200, bytesWritten: 68 };
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

    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(PrivateTransfer.downloadFile).mock.calls[0]?.[0]).toMatchObject({
      url: 'https://books.example.com/api/Image/series-cover?seriesId=7',
      relativePath: 'covers/server-1/7.img.partial',
      headers: { 'x-api-key': 'secret' },
    });
    expect(vi.mocked(PrivateTransfer.downloadFile).mock.calls[1]?.[0]).toMatchObject({
      url: 'https://books.example.com/kavita/api/Image/series-cover?seriesId=7',
      relativePath: 'covers/server-1/7.img.partial',
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
        vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce({
          status: 302,
          location,
          bytesWritten: 0,
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

      expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(redirects.length);
      for (const [options] of vi.mocked(PrivateTransfer.downloadFile).mock.calls) {
        expect(options.relativePath).toBe('covers/server-1/7.img.partial');
        expect(new URL(options.url).origin).toBe('https://books.example.com');
      }
      expect(native.renamed).toBe(false);
      expect(native.deleted).toContain('covers/server-1/7.img.partial');
    },
  );

  it('blocks native EPUB and cover transfers when the transport or WebView is offline', async () => {
    vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => {
      if (path === 'books' || path === 'covers/server-1' || path === 'covers/server-1/7.img') {
        throw new Error('missing');
      }
      return {
        type: 'file',
        size: native.body.length,
        name: path,
        mtime: 0,
        uri: `file://${path}`,
      };
    });
    vi.mocked(Network.getStatus).mockResolvedValueOnce({
      connected: false,
      connectionType: 'none',
    });
    await expect(
      downloadEpub('https://books.example.com/book.epub', 'secret', 'book-1', undefined),
    ).rejects.toMatchObject({
      kind: 'network',
      message: 'Kavita could not be reached while offline.',
    });
    expect(PrivateTransfer.downloadFile).not.toHaveBeenCalled();

    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
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
    ).rejects.toMatchObject({
      kind: 'network',
      message: 'Kavita could not be reached while offline.',
    });
    expect(PrivateTransfer.downloadFile).not.toHaveBeenCalled();

    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    vi.mocked(Network.getStatus)
      .mockResolvedValueOnce({ connected: true, connectionType: 'wifi' })
      .mockResolvedValueOnce({ connected: false, connectionType: 'none' });
    vi.mocked(PrivateTransfer.downloadFile).mockResolvedValueOnce({
      status: 302,
      location: 'https://books.example.com/cover-v2',
    });
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
    ).rejects.toMatchObject({
      kind: 'network',
      message: 'Kavita could not be reached while offline.',
    });
    expect(PrivateTransfer.downloadFile).toHaveBeenCalledTimes(1);
  });
});

describe('Android manifest and storage permission bounds', () => {
  it('omits @capacitor/file-transfer and preserves SDK 24-36 and unexported cache FileProvider bounds', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).not.toHaveProperty('@capacitor/file-transfer');
    expect(packageJson.devDependencies).not.toHaveProperty('@capacitor/file-transfer');

    const variablesGradle = readFileSync('android/variables.gradle', 'utf8');
    expect(variablesGradle).toMatch(/\bminSdkVersion\s*=\s*24\b/);
    expect(variablesGradle).toMatch(/\btargetSdkVersion\s*=\s*36\b/);

    const filePathsXml = readFileSync('android/app/src/main/res/xml/file_paths.xml', 'utf8');
    expect(filePathsXml).toContain('<cache-path name="shared_cache" path="shared/" />');
    expect(filePathsXml).not.toMatch(
      /external-path|external-files-path|external-cache-path|root-path/,
    );

    const sourceManifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    expect(extractManifestPermissions(sourceManifest)).toEqual(['android.permission.INTERNET']);
    expect(sourceManifest).toContain('android:name="androidx.core.content.FileProvider"');
    expect(sourceManifest).toContain('android:exported="false"');
  });

  it('enforces that merged Android manifests declare only INTERNET and ACCESS_NETWORK_STATE', () => {
    const validMergedManifest = `<?xml version="1.0" encoding="utf-8"?>
      <manifest xmlns:android="http://schemas.android.com/apk/res/android"
          package="app.turnleaf.reader">
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
        <uses-permission android:name="app.turnleaf.reader.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
      </manifest>`;
    expect(assertMergedManifestPermissions(validMergedManifest)).toEqual(
      ALLOWED_ANDROID_PERMISSIONS,
    );

    const legacyStorageManifest = `<?xml version="1.0" encoding="utf-8"?>
      <manifest xmlns:android="http://schemas.android.com/apk/res/android"
          package="app.turnleaf.reader">
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
        <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
      </manifest>`;
    expect(() => assertMergedManifestPermissions(legacyStorageManifest)).toThrow(
      /READ_EXTERNAL_STORAGE/,
    );

    const unexpectedPermissionManifest = `<?xml version="1.0" encoding="utf-8"?>
      <manifest xmlns:android="http://schemas.android.com/apk/res/android"
          package="app.turnleaf.reader">
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
        <uses-permission android:name="android.permission.USE_BIOMETRIC" />
      </manifest>`;
    expect(() => assertMergedManifestPermissions(unexpectedPermissionManifest)).toThrow(
      /USE_BIOMETRIC/,
    );

    for (const variant of ['debug', 'release'] as const) {
      const path = mergedManifestPath(variant);
      if (existsSync(path)) {
        expect(assertMergedManifestPermissions(readFileSync(path, 'utf8'), variant)).toEqual(
          ALLOWED_ANDROID_PERMISSIONS,
        );
      }
    }
  });
});
