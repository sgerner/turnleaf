// @vitest-environment node

import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  body: new Uint8Array() as Uint8Array<ArrayBufferLike>,
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
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem } from '@capacitor/filesystem';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import { EpubValidationError } from './epub-validation';
import { cacheCover, downloadEpub, verifyDownloadedEpub } from './native-download';

function encoded(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decoded(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function makeDeflatedArchive(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const write16 = (bytes: Uint8Array, offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  };
  const write32 = (bytes: Uint8Array, offset: number, value: number) => {
    write16(bytes, offset, value);
    write16(bytes, offset + 2, value >>> 16);
  };
  const items = entries.map((entry) => ({
    name: new TextEncoder().encode(entry.name),
    compressed: new Uint8Array(deflateRawSync(entry.data)),
    uncompressedSize: entry.data.length,
    crc: crc32(entry.data),
  }));
  const localSize = items.reduce(
    (sum, item) => sum + 30 + item.name.length + item.compressed.length,
    0,
  );
  const centralSize = items.reduce((sum, item) => sum + 46 + item.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;
  const localOffsets: number[] = [];
  for (const item of items) {
    localOffsets.push(offset);
    write32(out, offset, 0x04034b50);
    write16(out, offset + 4, 20);
    write16(out, offset + 6, 0x800);
    write16(out, offset + 8, 8);
    write32(out, offset + 14, item.crc);
    write32(out, offset + 18, item.compressed.length);
    write32(out, offset + 22, item.uncompressedSize);
    write16(out, offset + 26, item.name.length);
    offset += 30;
    out.set(item.name, offset);
    offset += item.name.length;
    out.set(item.compressed, offset);
    offset += item.compressed.length;
  }
  const centralOffset = offset;
  items.forEach((item, index) => {
    write32(out, offset, 0x02014b50);
    write16(out, offset + 4, 20);
    write16(out, offset + 6, 20);
    write16(out, offset + 8, 0x800);
    write16(out, offset + 10, 8);
    write32(out, offset + 16, item.crc);
    write32(out, offset + 20, item.compressed.length);
    write32(out, offset + 24, item.uncompressedSize);
    write16(out, offset + 28, item.name.length);
    write32(out, offset + 42, localOffsets[index]!);
    offset += 46;
    out.set(item.name, offset);
    offset += item.name.length;
  });
  write32(out, offset, 0x06054b50);
  write16(out, offset + 8, items.length);
  write16(out, offset + 10, items.length);
  write32(out, offset + 12, centralSize);
  write32(out, offset + 16, centralOffset);
  return out;
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
  vi.mocked(Filesystem.writeFile)
    .mockReset()
    .mockImplementation(async ({ data }) => {
      native.body = typeof data === 'string' ? decoded(data) : new Uint8Array();
      return { uri: 'file://books/written' };
    });
  vi.mocked(Filesystem.appendFile)
    .mockReset()
    .mockImplementation(async ({ data }) => {
      const appended = typeof data === 'string' ? decoded(data) : new Uint8Array();
      const combined = new Uint8Array(native.body.length + appended.length);
      combined.set(native.body, 0);
      combined.set(appended, native.body.length);
      native.body = combined;
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

  it('unwraps a multi-file chapter CBZ archive, saves only the matched EPUB, and passes verification', async () => {
    const primaryEpub = new Uint8Array(readFileSync('dev/kavita/data/Books/lorem-ipsum.epub'));
    const comment = new TextEncoder().encode('secondary-edition');
    const secondaryEpub = new Uint8Array(primaryEpub.length + comment.length);
    secondaryEpub.set(primaryEpub);
    secondaryEpub[primaryEpub.length - 2] = comment.length;
    secondaryEpub[primaryEpub.length - 1] = 0;
    secondaryEpub.set(comment, primaryEpub.length);

    const outerCbz = makeDeflatedArchive([
      { name: 'edition-1/edition-1.epub', data: primaryEpub },
      { name: 'edition-2/edition-2.epub', data: secondaryEpub },
      { name: 'scan/supplement.pdf', data: new TextEncoder().encode('%PDF-1.7 test') },
    ]);
    native.body = outerCbz;

    const downloaded = await downloadEpub(
      'https://books.example.com/api/Download/chapter?chapterId=1406',
      'secret',
      'primary-82-1406-2115',
      undefined,
      {
        fileName: 'edition-2.epub',
        expectedByteSize: secondaryEpub.length,
        epubIndex: 1,
      },
    );

    expect(downloaded).toMatchObject({
      relativePath: 'books/primary-82-1406-2115.epub',
      size: secondaryEpub.length,
    });
    expect(native.renamed).toBe(true);
    expect(native.body).toEqual(secondaryEpub);
    await expect(verifyDownloadedEpub(downloaded.relativePath)).resolves.toMatchObject({
      relativePath: 'books/primary-82-1406-2115.epub',
      size: secondaryEpub.length,
    });
  });

  it('deletes the temporary partial file and raises EpubValidationError when an outer archive lacks a matching EPUB', async () => {
    native.body = makeDeflatedArchive([
      { name: 'scan/supplement.pdf', data: new TextEncoder().encode('%PDF-1.7 only') },
    ]);

    await expect(
      downloadEpub(
        'https://books.example.com/api/Download/chapter?chapterId=1406',
        'secret',
        'primary-82-1406',
        undefined,
        { fileName: 'missing.epub', epubIndex: 0 },
      ),
    ).rejects.toBeInstanceOf(EpubValidationError);

    expect(native.renamed).toBe(false);
    expect(native.deleted).toContain('books/primary-82-1406.epub.partial');
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
});
