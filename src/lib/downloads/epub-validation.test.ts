import { describe, expect, it, vi } from 'vitest';
import {
  EpubValidationError,
  MAX_EPUB_ENTRIES,
  MAX_EPUB_EXPANDED_SIZE,
  MAX_EPUB_FILE_SIZE,
  validateEpubArchive,
} from './epub-validation';

interface ZipTestEntry {
  name: string;
  data?: Uint8Array;
  declaredSize?: number;
}

function write16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  write16(bytes, offset, value);
  write16(bytes, offset + 2, value / 0x10000);
}

function makeZip(entries: ZipTestEntry[]): Uint8Array {
  const normalized = entries.map((entry) => ({
    name: new TextEncoder().encode(entry.name),
    data: entry.data ?? new Uint8Array(),
    declaredSize: entry.declaredSize ?? entry.data?.length ?? 0,
  }));
  const localSize = normalized.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = normalized.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;
  const localOffsets: number[] = [];
  for (const entry of normalized) {
    localOffsets.push(offset);
    write32(archive, offset, 0x04034b50);
    write16(archive, offset + 4, 20);
    write16(archive, offset + 26, entry.name.length);
    offset += 30;
    archive.set(entry.name, offset);
    offset += entry.name.length;
    archive.set(entry.data, offset);
    offset += entry.data.length;
  }
  const centralOffset = offset;
  normalized.forEach((entry, index) => {
    write32(archive, offset, 0x02014b50);
    write16(archive, offset + 4, 20);
    write16(archive, offset + 6, 20);
    write16(archive, offset + 28, entry.name.length);
    write32(archive, offset + 20, entry.data.length);
    write32(archive, offset + 24, entry.declaredSize);
    write32(archive, offset + 42, localOffsets[index]!);
    offset += 46;
    archive.set(entry.name, offset);
    offset += entry.name.length;
  });
  write32(archive, offset, 0x06054b50);
  write16(archive, offset + 8, normalized.length);
  write16(archive, offset + 10, normalized.length);
  write32(archive, offset + 12, centralSize);
  write32(archive, offset + 16, centralOffset);
  return archive;
}

function validEntries(extra: ZipTestEntry[] = []): ZipTestEntry[] {
  return [
    { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: new TextEncoder().encode(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
    },
    { name: 'OEBPS/cover.jpg', data: new Uint8Array(100_000) },
    ...extra,
  ];
}

async function expectInvalid(archive: Uint8Array, fileSize = archive.length): Promise<void> {
  await expect(
    validateEpubArchive(fileSize, async (offset, length) => archive.slice(offset, offset + length)),
  ).rejects.toBeInstanceOf(EpubValidationError);
}

describe('EPUB container validation', () => {
  it('accepts a valid illustrated EPUB while using bounded range reads', async () => {
    const archive = makeZip(validEntries());
    const reads: Array<{ offset: number; length: number }> = [];
    await validateEpubArchive(archive.length, async (offset, length) => {
      reads.push({ offset, length });
      return archive.slice(offset, offset + length);
    });

    expect(reads.length).toBe(5);
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThan(archive.length);
  });

  it('rejects an HTML error body, even when it is larger than the old size check', async () => {
    const body = new TextEncoder().encode(`<html>${'error '.repeat(20)}</html>`);
    await expectInvalid(body);
  });

  it('rejects truncated ZIP data and a missing container entry', async () => {
    const archive = makeZip(validEntries());
    await expectInvalid(archive.slice(0, -3), archive.length);
    await expectInvalid(
      makeZip([{ name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') }]),
    );
  });

  it('rejects malformed container XML even when the ZIP structure is intact', async () => {
    await expectInvalid(
      makeZip([
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
        { name: 'META-INF/container.xml', data: new TextEncoder().encode('<container>') },
      ]),
    );
  });

  it('rejects path traversal and excessive entry counts', async () => {
    await expectInvalid(
      makeZip(validEntries([{ name: '../outside.xhtml', data: new Uint8Array([1]) }])),
    );
    const entries = Array.from({ length: MAX_EPUB_ENTRIES - 1 }, (_, index) => ({
      name: `OEBPS/page-${index}.xhtml`,
      data: new Uint8Array([1]),
    }));
    await expectInvalid(makeZip(validEntries(entries)));
  });

  it('rejects an archive whose declared expanded size exceeds the bound', async () => {
    const archive = makeZip(
      validEntries([
        {
          name: 'OEBPS/huge.bin',
          data: new Uint8Array([1]),
          declaredSize: MAX_EPUB_EXPANDED_SIZE,
        },
      ]),
    );
    await expectInvalid(archive);
  });

  it('rejects an oversized file before reading any bytes', async () => {
    const readRange = vi.fn(async () => new Uint8Array());
    await expect(validateEpubArchive(MAX_EPUB_FILE_SIZE + 1, readRange)).rejects.toBeInstanceOf(
      EpubValidationError,
    );
    expect(readRange).not.toHaveBeenCalled();
  });
});
