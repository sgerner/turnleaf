const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_ENCRYPTION_FLAGS = 0x1 | 0x40;
const ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;

/** Maximum native file size that Turnleaf will make available as an EPUB. */
export const MAX_EPUB_FILE_SIZE = 512 * 1024 * 1024;
/** Maximum uncompressed size represented by an EPUB's central directory. */
export const MAX_EPUB_EXPANDED_SIZE = 1024 * 1024 * 1024;
/** Keep central-directory inspection bounded even for a hostile entry count. */
export const MAX_EPUB_ENTRIES = 10_000;
const MAX_EPUB_CENTRAL_DIRECTORY_SIZE = 16 * 1024 * 1024;
const MAX_REPAIR_FILE_SIZE = 16 * 1024 * 1024;
const CONTAINER_PATH = 'META-INF/container.xml';
const MAX_CONTAINER_XML_SIZE = 1024 * 1024;
const ARCHIVE_READ_CHUNK_SIZE = 1024 * 1024;
const INITIAL_READ_SIZE = 4096;
const ZIP_TAIL_READ_SIZE = ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH + ZIP_MAX_COMMENT_LENGTH;

interface EpubArchiveEntry {
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface EpubArchiveTarget {
  fileName?: string | null | undefined;
  expectedByteSize?: number | null | undefined;
  epubIndex?: number | null | undefined;
}

export interface EpubRangeReader {
  (offset: number, length: number): Promise<Uint8Array>;
}

export class EpubValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubValidationError';
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function hasSignature(bytes: Uint8Array, offset: number, signature: number): boolean {
  return offset >= 0 && offset + 4 <= bytes.length && readUint32(bytes, offset) === signature;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: utf8 }).decode(bytes);
  } catch {
    throw new EpubValidationError('The EPUB contains an invalid filename encoding.');
  }
}

function validatePath(name: string): void {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new EpubValidationError('The EPUB contains an unsafe archive path.');
  }
  const segments = name.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '' && index !== segments.length - 1) {
      throw new EpubValidationError('The EPUB contains a malformed archive path.');
    }
    if (segment === '.' || segment === '..') {
      throw new EpubValidationError('The EPUB contains a path traversal entry.');
    }
    if (
      [...segment].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new EpubValidationError('The EPUB contains an invalid archive path.');
    }
  }
}

function requireRange(bytes: Uint8Array, expectedLength: number, message: string): void {
  if (bytes.length !== expectedLength) throw new EpubValidationError(message);
}

function parseCentralDirectory(
  bytes: Uint8Array,
  expectedEntries: number,
  archiveOffset: number,
): EpubArchiveEntry[] {
  const entries: EpubArchiveEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let offset = 0;

  for (let index = 0; index < expectedEntries; index += 1) {
    if (!hasSignature(bytes, offset, ZIP_CENTRAL_DIRECTORY_ENTRY)) {
      throw new EpubValidationError('The EPUB central directory is malformed.');
    }
    if (offset + 46 > bytes.length) {
      throw new EpubValidationError('The EPUB central directory is truncated.');
    }

    const flags = readUint16(bytes, offset + 8);
    const compressionMethod = readUint16(bytes, offset + 10);
    const crc32 = readUint32(bytes, offset + 16);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const diskNumber = readUint16(bytes, offset + 34);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.length) {
      throw new EpubValidationError('The EPUB central directory entry is truncated.');
    }
    if (diskNumber !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new EpubValidationError('The EPUB uses an unsupported ZIP layout.');
    }
    if (flags & ZIP_ENCRYPTION_FLAGS || (compressionMethod !== 0 && compressionMethod !== 8)) {
      throw new EpubValidationError('The EPUB uses an unsupported or encrypted ZIP entry.');
    }

    const name = decodeName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      Boolean(flags & 0x800),
    );
    validatePath(name);
    if (names.has(name))
      throw new EpubValidationError('The EPUB contains duplicate archive paths.');
    names.add(name);
    if (localOffsets.has(localHeaderOffset)) {
      throw new EpubValidationError('The EPUB contains overlapping local file headers.');
    }
    localOffsets.add(localHeaderOffset);

    if (localHeaderOffset > archiveOffset - 30) {
      throw new EpubValidationError('The EPUB contains an out-of-bounds local file header.');
    }
    if (localHeaderOffset + 30 + compressedSize > archiveOffset) {
      throw new EpubValidationError('The EPUB contains a truncated file entry.');
    }

    entries.push({
      name,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += recordLength;
  }

  if (offset !== bytes.length) {
    throw new EpubValidationError('The EPUB central directory contains trailing data.');
  }
  return entries;
}

function validateMimetypeEntry(head: Uint8Array, entry: EpubArchiveEntry): void {
  if (
    entry.name !== 'mimetype' ||
    entry.localHeaderOffset !== 0 ||
    entry.compressionMethod !== 0 ||
    entry.compressedSize !== 20 ||
    entry.uncompressedSize !== 20
  ) {
    throw new EpubValidationError('The EPUB must begin with an uncompressed mimetype entry.');
  }
  if (!hasSignature(head, 0, ZIP_LOCAL_FILE_HEADER) || head.length < 30) {
    throw new EpubValidationError('The EPUB local file header is malformed.');
  }

  const flags = readUint16(head, 6);
  const compressionMethod = readUint16(head, 8);
  const nameLength = readUint16(head, 26);
  const extraLength = readUint16(head, 28);
  const dataOffset = 30 + nameLength + extraLength;
  if (
    flags & ZIP_ENCRYPTION_FLAGS ||
    compressionMethod !== 0 ||
    nameLength !== 8 ||
    extraLength !== 0
  ) {
    throw new EpubValidationError('The EPUB mimetype local header is malformed.');
  }
  if (dataOffset + 20 > head.length) {
    throw new EpubValidationError('The EPUB mimetype entry is truncated.');
  }
  const localName = decodeName(head.subarray(30, dataOffset - extraLength), false);
  if (localName !== 'mimetype') {
    throw new EpubValidationError('The EPUB mimetype local header is malformed.');
  }
  const mimetype = new TextDecoder().decode(head.subarray(dataOffset, dataOffset + 20));
  if (mimetype !== 'application/epub+zip') {
    throw new EpubValidationError('The downloaded file is not an EPUB container.');
  }
}

function validateContainerXml(bytes: Uint8Array): void {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EpubValidationError('The EPUB container.xml encoding is invalid.');
  }
  if (typeof DOMParser === 'undefined') {
    if (!/<container(?:\s|>)/i.test(xml) || !/<rootfile\b[^>]*\bfull-path\s*=/i.test(xml)) {
      throw new EpubValidationError('The EPUB container.xml document is malformed.');
    }
    return;
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'container') {
    throw new EpubValidationError('The EPUB container.xml document is malformed.');
  }
  const rootFile = Array.from(document.getElementsByTagName('*')).find(
    (element) => element.localName === 'rootfile',
  );
  if (!rootFile?.getAttribute('full-path')) {
    throw new EpubValidationError('The EPUB container.xml document is missing its rootfile.');
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_CONTAINER_XML_SIZE) {
        throw new EpubValidationError('The EPUB container entry is too large.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readXmlEntry(
  entry: EpubArchiveEntry,
  archiveOffset: number,
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<Uint8Array | undefined> {
  const localHeader = await readRange(entry.localHeaderOffset, 30);
  requireRange(localHeader, 30, 'The EPUB container local header is truncated.');
  if (!hasSignature(localHeader, 0, ZIP_LOCAL_FILE_HEADER)) {
    throw new EpubValidationError('The EPUB container local header is malformed.');
  }
  const localFlags = readUint16(localHeader, 6);
  const localMethod = readUint16(localHeader, 8);
  const nameLength = readUint16(localHeader, 26);
  const extraLength = readUint16(localHeader, 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (
    localMethod !== entry.compressionMethod ||
    dataOffset < entry.localHeaderOffset ||
    dataOffset + entry.compressedSize > archiveOffset ||
    dataOffset + entry.compressedSize > fileSize
  ) {
    throw new EpubValidationError('The EPUB container entry is truncated.');
  }
  if (localFlags & 0x1 || localFlags & 0x40) {
    throw new EpubValidationError('The EPUB container entry is encrypted.');
  }

  // Container XML is deliberately bounded to one MiB above. Reading just this
  // entry lets us catch malformed stored XML while leaving large illustrated
  // assets out of JavaScript memory.
  const compressed = await readRange(dataOffset, entry.compressedSize);
  requireRange(compressed, entry.compressedSize, 'The EPUB container entry is truncated.');
  let uncompressed = compressed;
  if (entry.compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
    try {
      const stream = new Blob([new Uint8Array(compressed).buffer as ArrayBuffer])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      uncompressed = await readBoundedStream(stream);
    } catch {
      throw new EpubValidationError('The EPUB container entry is malformed.');
    }
  } else if (entry.compressionMethod === 8) {
    // Older WebViews may not expose DecompressionStream. The central directory
    // and bounds checks still protect the file, and EPUB.js will inflate it on
    // open; do not reject otherwise valid illustrated EPUBs solely for that API.
    return;
  }
  if (
    uncompressed.length !== entry.uncompressedSize ||
    uncompressed.length > MAX_CONTAINER_XML_SIZE
  ) {
    throw new EpubValidationError('The EPUB container entry is malformed.');
  }
  return uncompressed;
}

function createContainerRecords(
  packagePath: string,
  centralDirectory: Uint8Array,
  centralDirectoryOffset: number,
  entryCount: number,
): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(CONTAINER_PATH);
  const xml = encoder.encode(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile media-type="application/oebps-package+xml" full-path="' +
      packagePath +
      '"/></rootfiles></container>',
  );
  let crc = 0xffffffff;
  for (const byte of xml) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc ^= 0xffffffff;

  // Replace the old directory with the new entry, updated directory and end record.
  // Offsets to all original entries remain valid.
  const localSize = 30 + name.length + xml.length;
  const newEntryOffset = localSize + centralDirectory.length;
  const endOffset = newEntryOffset + 46 + name.length;
  const bytes = new Uint8Array(endOffset + ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
  view.setUint16(4, 20, true);
  view.setUint16(12, 33, true); // January 1, 1980 in DOS date format.
  view.setUint32(14, crc, true);
  view.setUint32(18, xml.length, true);
  view.setUint32(22, xml.length, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  bytes.set(xml, 30 + name.length);
  bytes.set(centralDirectory, localSize);

  view.setUint32(newEntryOffset, ZIP_CENTRAL_DIRECTORY_ENTRY, true);
  view.setUint16(newEntryOffset + 4, 20, true);
  bytes.set(bytes.subarray(4, 30), newEntryOffset + 6);
  view.setUint32(newEntryOffset + 42, centralDirectoryOffset, true);
  bytes.set(name, newEntryOffset + 46);

  view.setUint32(endOffset, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(endOffset + 8, entryCount + 1, true);
  view.setUint16(endOffset + 10, entryCount + 1, true);
  view.setUint32(endOffset + 12, endOffset - localSize, true);
  view.setUint32(endOffset + 16, centralDirectoryOffset + localSize, true);
  return bytes;
}

async function findRecoveryPackage(
  entries: EpubArchiveEntry[],
  archiveOffset: number,
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<string | undefined> {
  const candidates = entries.filter((entry) => /\.opf$/i.test(entry.name));
  const entry = candidates[0];
  if (
    candidates.length !== 1 ||
    !entry ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(entry.name) ||
    entry.compressedSize > MAX_CONTAINER_XML_SIZE ||
    entry.uncompressedSize > MAX_CONTAINER_XML_SIZE ||
    typeof DOMParser === 'undefined'
  ) {
    return;
  }

  const bytes = await readXmlEntry(entry, archiveOffset, fileSize, readRange);
  if (!bytes) return;
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  if (/<!DOCTYPE/i.test(xml)) return;
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (root.localName !== 'package' || root.namespaceURI !== 'http://www.idpf.org/2007/opf') return;
  const children = Array.from(root.children);
  const metadata = children.find((child) => child.localName === 'metadata');
  const manifest = children.find((child) => child.localName === 'manifest');
  const spine = children.find((child) => child.localName === 'spine');
  if (!metadata || !manifest || !spine) return;

  const names = new Set(entries.map((archiveEntry) => archiveEntry.name));
  const base = new URL(entry.name, 'https://epub.invalid/');
  const itemIds = new Set<string>();
  for (const item of manifest.children) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (item.localName !== 'item' || !id || !href || itemIds.has(id)) return;
    try {
      const url = new URL(href, base);
      if (
        url.origin !== base.origin ||
        url.pathname.endsWith('/') ||
        !names.has(decodeURIComponent(url.pathname.slice(1)))
      ) {
        return;
      }
    } catch {
      return;
    }
    itemIds.add(id);
  }

  const chapters = Array.from(spine.children).filter((child) => child.localName === 'itemref');
  if (
    chapters.length > 0 &&
    chapters.every((chapter) => itemIds.has(chapter.getAttribute('idref') ?? ''))
  ) {
    return entry.name;
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface InspectedZipArchive {
  head: Uint8Array;
  centralDirectory: Uint8Array;
  centralDirectoryOffset: number;
  entryCount: number;
  archiveEntries: EpubArchiveEntry[];
  readBufferedRange: EpubRangeReader;
}

async function inspectZipArchive(
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<InspectedZipArchive> {
  if (!Number.isSafeInteger(fileSize) || fileSize < ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH) {
    throw new EpubValidationError('The downloaded EPUB is empty or too small.');
  }
  if (fileSize > MAX_EPUB_FILE_SIZE) {
    throw new EpubValidationError('The downloaded EPUB is too large.');
  }

  const headLength = Math.min(fileSize, INITIAL_READ_SIZE);
  const tailLength = Math.min(fileSize, ZIP_TAIL_READ_SIZE);
  const tailOffset = fileSize - tailLength;
  const tailRead = readRange(tailOffset, tailLength);
  const [head, tail] = await Promise.all([
    tailOffset === 0
      ? tailRead.then((bytes) => bytes.subarray(0, headLength))
      : readRange(0, headLength),
    tailRead,
  ]);
  requireRange(head, headLength, 'The downloaded EPUB is truncated.');
  requireRange(tail, tailLength, 'The EPUB ZIP end record is truncated.');

  const readBufferedRange: EpubRangeReader = (offset, length) => {
    if (offset >= 0 && offset + length <= head.length) {
      return Promise.resolve(head.subarray(offset, offset + length));
    }
    if (offset >= tailOffset && offset + length <= fileSize) {
      const start = offset - tailOffset;
      return Promise.resolve(tail.subarray(start, start + length));
    }
    return readRange(offset, length);
  };

  let endOffset = -1;
  for (let offset = tail.length - ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH; offset >= 0; offset -= 1) {
    if (!hasSignature(tail, offset, ZIP_END_OF_CENTRAL_DIRECTORY)) continue;
    const commentLength = readUint16(tail, offset + 20);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength === tail.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new EpubValidationError('The EPUB ZIP end record is missing.');

  const entriesOnDisk = readUint16(tail, endOffset + 8);
  const entries = readUint16(tail, endOffset + 10);
  const centralDirectorySize = readUint32(tail, endOffset + 12);
  const centralDirectoryOffset = readUint32(tail, endOffset + 16);
  const diskNumber = readUint16(tail, endOffset + 4);
  const centralDirectoryDisk = readUint16(tail, endOffset + 6);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0 ||
    entries > MAX_EPUB_ENTRIES ||
    centralDirectorySize > MAX_EPUB_CENTRAL_DIRECTORY_SIZE ||
    centralDirectorySize < entries * 46 ||
    centralDirectoryOffset + centralDirectorySize !== tailOffset + endOffset
  ) {
    throw new EpubValidationError('The EPUB ZIP central directory is invalid.');
  }

  const centralDirectory = await readBufferedRange(centralDirectoryOffset, centralDirectorySize);
  requireRange(centralDirectory, centralDirectorySize, 'The EPUB central directory is truncated.');
  const archiveEntries = parseCentralDirectory(centralDirectory, entries, centralDirectoryOffset);
  const totalExpandedSize = archiveEntries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0,
  );
  if (totalExpandedSize > MAX_EPUB_EXPANDED_SIZE) {
    throw new EpubValidationError('The EPUB expands beyond the supported size.');
  }

  return {
    head,
    centralDirectory,
    centralDirectoryOffset,
    entryCount: entries,
    archiveEntries,
    readBufferedRange,
  };
}

async function validateTopLevelEpub(
  inspected: InspectedZipArchive,
  fileSize: number,
  allowContainerRecovery: boolean,
): Promise<Uint8Array | undefined> {
  const {
    head,
    centralDirectory,
    centralDirectoryOffset,
    entryCount: entries,
    archiveEntries,
    readBufferedRange,
  } = inspected;
  const mimetype = archiveEntries[0];
  const container = archiveEntries.find((entry) => entry.name === CONTAINER_PATH);
  if (!mimetype || !container) {
    const error = new EpubValidationError('The EPUB is missing its required container files.');
    if (
      !allowContainerRecovery ||
      !mimetype ||
      fileSize > MAX_REPAIR_FILE_SIZE ||
      entries >= MAX_EPUB_ENTRIES
    ) {
      throw error;
    }
    validateMimetypeEntry(head, mimetype);
    const packagePath = await findRecoveryPackage(
      archiveEntries,
      centralDirectoryOffset,
      fileSize,
      readBufferedRange,
    );
    if (!packagePath) throw error;

    const records = createContainerRecords(
      packagePath,
      centralDirectory,
      centralDirectoryOffset,
      entries,
    );
    const repaired = new Uint8Array(centralDirectoryOffset + records.length);
    const prefix = await readBufferedRange(0, centralDirectoryOffset);
    requireRange(prefix, centralDirectoryOffset, 'The downloaded EPUB is truncated.');
    repaired.set(prefix);
    repaired.set(records, centralDirectoryOffset);
    return repaired;
  }
  if (
    container.name.endsWith('/') ||
    container.uncompressedSize === 0 ||
    container.uncompressedSize > MAX_CONTAINER_XML_SIZE
  ) {
    throw new EpubValidationError('The EPUB container.xml entry is invalid.');
  }
  validateMimetypeEntry(head, mimetype);
  const xml = await readXmlEntry(container, centralDirectoryOffset, fileSize, readBufferedRange);
  if (xml) validateContainerXml(xml);
}

function sanitizeTargetFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const tail = /[\\/]/.test(fileName)
    ? (fileName.split(/[\\/]/).at(-1) ?? '')
    : fileName.replace(/^[A-Za-z]:/, '');
  const trimmed = tail.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  return trimmed.normalize('NFC');
}

function entryBasename(entryName: string): string {
  return (entryName.split('/').at(-1) ?? '').normalize('NFC');
}

function selectBySizeOrOrder(
  candidates: EpubArchiveEntry[],
  allEpubEntries: EpubArchiveEntry[],
  expectedSize: number | null,
  epubIndex: number | null,
): EpubArchiveEntry | undefined {
  if (expectedSize !== null) {
    const sizeMatches = candidates.filter((entry) => entry.uncompressedSize === expectedSize);
    if (sizeMatches.length === 1) return sizeMatches[0];
    if (sizeMatches.length > 1 && epubIndex !== null && sizeMatches[epubIndex]) {
      return sizeMatches[epubIndex];
    }
    if (sizeMatches.length > 0) return sizeMatches[0];
  }
  if (epubIndex !== null) {
    if (candidates === allEpubEntries) return allEpubEntries[epubIndex];
    return candidates[epubIndex] ?? candidates[0];
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function selectTargetEpubEntry(
  epubEntries: EpubArchiveEntry[],
  target?: EpubArchiveTarget,
): EpubArchiveEntry {
  const wantedName = sanitizeTargetFileName(target?.fileName);
  const expectedSize =
    typeof target?.expectedByteSize === 'number' &&
    Number.isSafeInteger(target.expectedByteSize) &&
    target.expectedByteSize > 0
      ? target.expectedByteSize
      : null;
  const epubIndex =
    typeof target?.epubIndex === 'number' &&
    Number.isSafeInteger(target.epubIndex) &&
    target.epubIndex >= 0
      ? target.epubIndex
      : target && (wantedName !== null || expectedSize !== null || target.epubIndex !== undefined)
        ? null
        : 0;

  if (wantedName !== null) {
    const exactMatches = epubEntries.filter((entry) => entryBasename(entry.name) === wantedName);
    if (exactMatches.length === 1) return exactMatches[0]!;
    if (exactMatches.length > 1) {
      const narrowed = selectBySizeOrOrder(exactMatches, epubEntries, expectedSize, epubIndex);
      if (narrowed) return narrowed;
    }
    const lowerWanted = wantedName.toLowerCase();
    const caseMatches = epubEntries.filter(
      (entry) => entryBasename(entry.name).toLowerCase() === lowerWanted,
    );
    if (caseMatches.length === 1) return caseMatches[0]!;
    if (caseMatches.length > 1) {
      const narrowed = selectBySizeOrOrder(caseMatches, epubEntries, expectedSize, epubIndex);
      if (narrowed) return narrowed;
    }
  }

  if (expectedSize !== null) {
    const sizeMatches = epubEntries.filter((entry) => entry.uncompressedSize === expectedSize);
    if (sizeMatches.length === 1) return sizeMatches[0]!;
    if (sizeMatches.length > 1) {
      if (epubIndex !== null && sizeMatches[epubIndex]) return sizeMatches[epubIndex]!;
      return sizeMatches[0]!;
    }
  }

  if (epubIndex !== null && epubIndex < epubEntries.length) {
    return epubEntries[epubIndex]!;
  }

  throw new EpubValidationError(
    'The downloaded chapter archive did not include the requested EPUB file.',
  );
}

async function inflateBoundedEntry(
  dataOffset: number,
  compressedSize: number,
  expectedUncompressedSize: number,
  readRange: EpubRangeReader,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new EpubValidationError('This device cannot extract compressed chapter archives.');
  }
  let readPosition = 0;
  const compressedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (readPosition >= compressedSize) {
        controller.close();
        return;
      }
      const chunkLength = Math.min(ARCHIVE_READ_CHUNK_SIZE, compressedSize - readPosition);
      const chunk = await readRange(dataOffset + readPosition, chunkLength);
      requireRange(chunk, chunkLength, 'The downloaded chapter archive is truncated.');
      readPosition += chunkLength;
      controller.enqueue(chunk);
    },
  });

  const decompressedStream = compressedStream.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  const reader = decompressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > expectedUncompressedSize || total > MAX_EPUB_FILE_SIZE) {
        await reader.cancel().catch(() => {});
        throw new EpubValidationError('The extracted EPUB exceeds its declared size.');
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof EpubValidationError) throw error;
    throw new EpubValidationError('The chapter archive entry could not be extracted.');
  } finally {
    reader.releaseLock();
  }

  if (total !== expectedUncompressedSize) {
    throw new EpubValidationError('The extracted EPUB size did not match the chapter archive.');
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function extractArchiveEntry(
  entry: EpubArchiveEntry,
  archiveOffset: number,
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<Uint8Array> {
  if (entry.uncompressedSize < ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH) {
    throw new EpubValidationError('The extracted EPUB is empty or too small.');
  }
  if (entry.uncompressedSize > MAX_EPUB_FILE_SIZE) {
    throw new EpubValidationError('The extracted EPUB is too large.');
  }

  const localHeader = await readRange(entry.localHeaderOffset, 30);
  requireRange(localHeader, 30, 'The chapter archive local header is truncated.');
  if (!hasSignature(localHeader, 0, ZIP_LOCAL_FILE_HEADER)) {
    throw new EpubValidationError('The chapter archive local header is malformed.');
  }
  const localFlags = readUint16(localHeader, 6);
  const localMethod = readUint16(localHeader, 8);
  const nameLength = readUint16(localHeader, 26);
  const extraLength = readUint16(localHeader, 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (localFlags & ZIP_ENCRYPTION_FLAGS) {
    throw new EpubValidationError('The chapter archive contains an encrypted entry.');
  }
  if (
    localMethod !== entry.compressionMethod ||
    (localMethod !== 0 && localMethod !== 8) ||
    nameLength === 0 ||
    dataOffset < entry.localHeaderOffset ||
    dataOffset + entry.compressedSize > archiveOffset ||
    dataOffset + entry.compressedSize > fileSize
  ) {
    throw new EpubValidationError('The chapter archive entry header is invalid.');
  }

  const localNameBytes = await readRange(entry.localHeaderOffset + 30, nameLength);
  requireRange(localNameBytes, nameLength, 'The chapter archive entry name is truncated.');
  const localName = decodeName(localNameBytes, Boolean(localFlags & 0x800));
  validatePath(localName);

  let extracted: Uint8Array;
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new EpubValidationError('The stored chapter archive entry size is invalid.');
    }
    extracted = new Uint8Array(entry.uncompressedSize);
    for (let offset = 0; offset < entry.compressedSize; offset += ARCHIVE_READ_CHUNK_SIZE) {
      const length = Math.min(ARCHIVE_READ_CHUNK_SIZE, entry.compressedSize - offset);
      const chunk = await readRange(dataOffset + offset, length);
      requireRange(chunk, length, 'The downloaded chapter archive is truncated.');
      extracted.set(chunk, offset);
    }
  } else {
    extracted = await inflateBoundedEntry(
      dataOffset,
      entry.compressedSize,
      entry.uncompressedSize,
      readRange,
    );
  }

  if (entry.crc32 !== 0 && computeCrc32(extracted) !== entry.crc32) {
    throw new EpubValidationError('The extracted EPUB failed integrity verification.');
  }
  return extracted;
}

/**
 * Inspect only the ZIP header, end record, and central directory. The caller
 * supplies a range reader so native files are never loaded wholesale merely
 * to decide whether they are safe to mark as available. When recovery is enabled,
 * return a repaired copy only for a small archive with an identifiable package.
 */
export async function validateEpubArchive(
  fileSize: number,
  readRange: EpubRangeReader,
  allowContainerRecovery = false,
): Promise<Uint8Array | undefined> {
  const inspected = await inspectZipArchive(fileSize, readRange);
  return validateTopLevelEpub(inspected, fileSize, allowContainerRecovery);
}

/**
 * Validate a downloaded chapter response that may be either a direct EPUB file
 * or a Kavita multi-file outer `.cbz` archive. Returns undefined when the file
 * on disk is already a valid EPUB, or returns the extracted/repaired inner EPUB
 * bytes after validating its EPUB container.
 */
export async function prepareDownloadedEpub(
  fileSize: number,
  readRange: EpubRangeReader,
  target?: EpubArchiveTarget,
): Promise<Uint8Array | undefined> {
  const inspected = await inspectZipArchive(fileSize, readRange);
  if (inspected.archiveEntries[0]?.name === 'mimetype') {
    return validateTopLevelEpub(inspected, fileSize, true);
  }

  const epubEntries = inspected.archiveEntries.filter(
    (entry) => !entry.name.endsWith('/') && /\.epub$/i.test(entry.name),
  );
  if (!epubEntries.length) {
    throw new EpubValidationError('The downloaded chapter archive does not contain an EPUB file.');
  }
  const selected = selectTargetEpubEntry(epubEntries, target);
  const extracted = await extractArchiveEntry(
    selected,
    inspected.centralDirectoryOffset,
    fileSize,
    inspected.readBufferedRange,
  );
  const repaired = await validateEpubArchive(
    extracted.length,
    async (offset, length) => extracted.subarray(offset, offset + length),
    true,
  );
  if (repaired) {
    await validateEpubArchive(repaired.length, async (offset, length) =>
      repaired.subarray(offset, offset + length),
    );
    return repaired;
  }
  return extracted;
}
