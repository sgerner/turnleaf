const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;

/** Maximum native file size that Turnleaf will make available as an EPUB. */
export const MAX_EPUB_FILE_SIZE = 512 * 1024 * 1024;
/** Maximum uncompressed size represented by an EPUB's central directory. */
export const MAX_EPUB_EXPANDED_SIZE = 1024 * 1024 * 1024;
/** Keep central-directory inspection bounded even for a hostile entry count. */
export const MAX_EPUB_ENTRIES = 10_000;
export const MAX_EPUB_CENTRAL_DIRECTORY_SIZE = 16 * 1024 * 1024;
const MAX_CONTAINER_XML_SIZE = 1024 * 1024;
const INITIAL_READ_SIZE = 4096;
const ZIP_TAIL_READ_SIZE = ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH + ZIP_MAX_COMMENT_LENGTH;

export interface EpubArchiveEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
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
    if (flags & 0x1 || flags & 0x40 || (compressionMethod !== 0 && compressionMethod !== 8)) {
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
      flags,
      compressionMethod,
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
    entry.flags !== 0 ||
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
  if (flags !== 0 || compressionMethod !== 0 || nameLength !== 8 || extraLength !== 0) {
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

async function validateContainerEntry(
  entry: EpubArchiveEntry,
  archiveOffset: number,
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<void> {
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
      const body = new Response(stream).body;
      if (!body) throw new EpubValidationError('The EPUB container entry is malformed.');
      uncompressed = await readBoundedStream(body);
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
  validateContainerXml(uncompressed);
}

/**
 * Inspect only the ZIP header, end record, and central directory. The caller
 * supplies a range reader so native files are never loaded wholesale merely
 * to decide whether they are safe to mark as available.
 */
export async function validateEpubArchive(
  fileSize: number,
  readRange: EpubRangeReader,
): Promise<void> {
  if (!Number.isSafeInteger(fileSize) || fileSize < ZIP_END_OF_CENTRAL_DIRECTORY_LENGTH) {
    throw new EpubValidationError('The downloaded EPUB is empty or too small.');
  }
  if (fileSize > MAX_EPUB_FILE_SIZE) {
    throw new EpubValidationError('The downloaded EPUB is too large.');
  }

  const headLength = Math.min(fileSize, INITIAL_READ_SIZE);
  const head = await readRange(0, headLength);
  requireRange(head, headLength, 'The downloaded EPUB is truncated.');
  const tailLength = Math.min(fileSize, ZIP_TAIL_READ_SIZE);
  const tailOffset = fileSize - tailLength;
  const tail = await readRange(tailOffset, tailLength);
  requireRange(tail, tailLength, 'The EPUB ZIP end record is truncated.');

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
    entries === 0xffff ||
    centralDirectorySize > MAX_EPUB_CENTRAL_DIRECTORY_SIZE ||
    centralDirectorySize < entries * 46 ||
    centralDirectoryOffset + centralDirectorySize !== tailOffset + endOffset
  ) {
    throw new EpubValidationError('The EPUB ZIP central directory is invalid.');
  }

  const centralDirectory = await readRange(centralDirectoryOffset, centralDirectorySize);
  requireRange(centralDirectory, centralDirectorySize, 'The EPUB central directory is truncated.');
  const archiveEntries = parseCentralDirectory(centralDirectory, entries, centralDirectoryOffset);
  const totalExpandedSize = archiveEntries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0,
  );
  if (totalExpandedSize > MAX_EPUB_EXPANDED_SIZE) {
    throw new EpubValidationError('The EPUB expands beyond the supported size.');
  }

  const mimetype = archiveEntries[0];
  const container = archiveEntries.find((entry) => entry.name === 'META-INF/container.xml');
  if (!mimetype || !container) {
    throw new EpubValidationError('The EPUB is missing its required container files.');
  }
  if (
    container.name.endsWith('/') ||
    container.uncompressedSize === 0 ||
    container.uncompressedSize > MAX_CONTAINER_XML_SIZE
  ) {
    throw new EpubValidationError('The EPUB container.xml entry is invalid.');
  }
  validateMimetypeEntry(head, mimetype);
  await validateContainerEntry(container, centralDirectoryOffset, fileSize, readRange);
}
