import { recordDiagnostic } from '../diagnostics/log';
import type {
  KavitaAnnotation,
  KavitaChapter,
  KavitaFile,
  KavitaLibrary,
  KavitaPerson,
  KavitaPersonalTocItem,
  KavitaSeries,
  KavitaSeriesDetail,
  KavitaVolume,
} from './types';

type Row = Record<string, unknown>;
type CollectionPath =
  '$' | '$.chapters' | '$.specials' | '$.storylineChapters' | '$.volumes' | number;

const SERIES_ENDPOINT = '/api/Series/v2';
const DETAIL_ENDPOINT = '/api/Series/series-detail';
const EMPTY_DATE = '0001-01-01T00:00:00';
const EMPTY_DATE_UTC = '0001-01-01T00:00:00Z';
// Kavita MangaFormat: Image=0, Archive=1, Unknown=2, Epub=3, Pdf=4.
const NON_EPUB_FORMATS = new Set([0, 1, 4]);

function actualType(value: unknown): string {
  return value === undefined
    ? 'missing'
    : value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : typeof value;
}

export class KavitaPayloadError extends Error {
  readonly actualType: string;
  constructor(
    readonly path: string,
    readonly expected: string,
    value: unknown,
  ) {
    const type = actualType(value);
    super(`${path}: expected ${expected}, received ${type}.`);
    this.actualType = type;
  }
}

function formatPath(base: CollectionPath, index?: number, field?: string): string {
  const prefix = typeof base === 'number' ? `$.volumes[${base}].chapters` : base;
  if (index === undefined) return field ? `${prefix}.${field}` : prefix;
  return field ? `${prefix}[${index}].${field}` : `${prefix}[${index}]`;
}

function formatFilePath(
  base: CollectionPath,
  chapterIndex: number,
  fileIndex: number,
  field?: string,
): string {
  const prefix = `${formatPath(base, chapterIndex, 'files')}[${fileIndex}]`;
  return field ? `${prefix}.${field}` : prefix;
}

function object(value: unknown, base: CollectionPath, index?: number): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new KavitaPayloadError(formatPath(base, index), 'object', value);
  return value as Row;
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

function id(
  value: unknown,
  base: CollectionPath,
  index: number | undefined,
  field: string,
): number {
  const n = integer(value);
  if (n === undefined)
    throw new KavitaPayloadError(formatPath(base, index, field), 'integer', value);
  return n;
}

function fallback(endpoint: string, path: string, value: unknown, expected: string): void {
  recordDiagnostic({
    category: 'validation',
    endpoint,
    path,
    expected,
    actualType: actualType(value),
    detail: value === undefined ? 'missing-field' : 'invalid-field',
  });
}

function text(
  value: unknown,
  endpoint: string,
  base: CollectionPath,
  index: number,
  field: string,
  onFallback?: () => void,
): string {
  if (typeof value === 'string') return value;
  onFallback?.();
  fallback(endpoint, formatPath(base, index, field), value, 'string');
  return '';
}

function isValidDateString(value: string): boolean {
  return value === EMPTY_DATE || value === EMPTY_DATE_UTC || Number.isFinite(Date.parse(value));
}

function date(
  value: unknown,
  endpoint: string,
  base: CollectionPath,
  index: number | undefined,
  field: string,
  optional = false,
  onFallback?: () => void,
): string {
  if (optional && value == null) return '';
  if (typeof value === 'string' && isValidDateString(value)) return value;
  onFallback?.();
  fallback(endpoint, formatPath(base, index, field), value, 'string');
  return '';
}

function count(
  value: unknown,
  endpoint: string,
  base: CollectionPath,
  index: number | undefined,
  field: string,
  onFallback?: () => void,
): number {
  const n = integer(value);
  if (n !== undefined) return n;
  onFallback?.();
  fallback(endpoint, formatPath(base, index, field), value, 'integer');
  return 0;
}

function progress(
  value: unknown,
  endpoint: string,
  base: CollectionPath,
  index: number,
  field: string,
  onFallback?: () => void,
): number | undefined {
  const n = integer(value);
  if (n === undefined) {
    onFallback?.();
    fallback(endpoint, formatPath(base, index, field), value, 'integer');
  }
  return n;
}

export function normalizeLibraries(payload: unknown): KavitaLibrary[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.map((value, index) => {
    const row = object(value, '$', index);
    return {
      id: id(row.id, '$', index, 'id'),
      name: typeof row.name === 'string' ? row.name : null,
      type: id(row.type, '$', index, 'type'),
    };
  });
}

export function normalizeSeriesPage(payload: unknown): KavitaSeries[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  const result: KavitaSeries[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const row = object(payload[index], '$', index);
    const format = integer(row.format);
    // Other Kavita media are irrelevant to an EPUB reader; their metadata must not block it.
    if (format !== undefined && NON_EPUB_FORMATS.has(format)) continue;
    if (format !== 3) {
      fallback(SERIES_ENDPOINT, formatPath('$', index, 'format'), row.format, 'known format');
    }
    const idValue = id(row.id, '$', index, 'id');
    const libraryId = id(row.libraryId, '$', index, 'libraryId');
    const normalizedFormat = format === 3 ? 3 : -1;
    const name = typeof row.name === 'string' ? row.name : null;
    const coverImage = typeof row.coverImage === 'string' ? row.coverImage : null;
    const pages = count(row.pages, SERIES_ENDPOINT, '$', index, 'pages');
    const pagesRead = progress(row.pagesRead, SERIES_ENDPOINT, '$', index, 'pagesRead');
    const created = date(row.created, SERIES_ENDPOINT, '$', index, 'created');
    const latestReadDate = date(
      row.latestReadDate,
      SERIES_ENDPOINT,
      '$',
      index,
      'latestReadDate',
      true,
    );
    result.push(
      pagesRead === undefined
        ? {
            id: idValue,
            libraryId,
            format: normalizedFormat,
            name,
            coverImage,
            pages,
            created,
            latestReadDate,
          }
        : {
            id: idValue,
            libraryId,
            format: normalizedFormat,
            name,
            coverImage,
            pages,
            pagesRead,
            created,
            latestReadDate,
          },
    );
  }
  return result;
}

function collection(row: Row, name: string, path: string): unknown[] {
  const value = row[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new KavitaPayloadError(`${path}.${name}`, 'array', value);
  return value;
}

function isEpubFile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Row;
  return (
    integer(row.format) === 3 ||
    (typeof row.extension === 'string' && /^\.?epub$/i.test(row.extension))
  );
}

function matchesCachedChapter(row: Row, cached: KavitaChapter, parentVolumeId?: number): boolean {
  const volumeId = row.volumeId == null ? parentVolumeId : integer(row.volumeId);
  if (
    volumeId !== cached.volumeId ||
    row.title !== cached.title ||
    row.titleName !== cached.titleName ||
    row.summary !== cached.summary ||
    integer(row.pages) !== cached.pages ||
    integer(row.pagesRead) !== cached.pagesRead
  )
    return false;
  if (
    cached.lastReadingProgressUtc === null
      ? row.lastReadingProgressUtc != null
      : row.lastReadingProgressUtc !== cached.lastReadingProgressUtc
  )
    return false;

  const files = row.files;
  if (!Array.isArray(files) || files.length !== cached.files.length) return false;
  const format = integer(row.format);
  for (let i = 0; i < files.length; i += 1) {
    const rawFile = files[i];
    if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) return false;
    const file = rawFile as Row;
    const cachedFile = cached.files[i]!;
    const extension = typeof file.extension === 'string' ? file.extension : null;
    if (
      extension !== cachedFile.extension ||
      integer(file.id) !== cachedFile.id ||
      integer(file.bytes) !== cachedFile.bytes
    )
      return false;
    if (!isEpubFile(file) && !(integer(file.format) === undefined && format === 3 && !extension))
      return false;
  }

  const writers = row.writers;
  if (!Array.isArray(writers)) return cached.writers.length === 0;
  if (writers.length !== cached.writers.length) return false;
  for (let i = 0; i < writers.length; i += 1) {
    const writer = writers[i];
    if (
      !writer ||
      typeof writer !== 'object' ||
      Array.isArray(writer) ||
      (writer as Row).name !== cached.writers[i]!.name
    )
      return false;
  }
  return true;
}

function chapters(
  values: unknown[],
  base: CollectionPath,
  markIncomplete: (path: string, value: unknown) => void,
  cache: Map<number, KavitaChapter>,
  parentVolumeId?: number,
): KavitaChapter[] {
  const result: KavitaChapter[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const candidate = value as Row;
      const candidateId = integer(candidate.id);
      const cached = candidateId === undefined ? undefined : cache.get(candidateId);
      if (cached && matchesCachedChapter(candidate, cached, parentVolumeId)) {
        result.push(cached);
        continue;
      }
    }

    const row = object(value, base, index);
    const format = integer(row.format);
    const files = row.files;
    const epubSignal = Array.isArray(files) && files.some(isEpubFile);
    if (format !== undefined && NON_EPUB_FORMATS.has(format) && !epubSignal) {
      if (!Array.isArray(files)) markIncomplete(formatPath(base, index, 'files'), files);
      continue;
    }
    if (!Array.isArray(files))
      throw new KavitaPayloadError(formatPath(base, index, 'files'), 'array', files);
    if (!files.length)
      throw new KavitaPayloadError(formatPath(base, index, 'files'), 'nonempty array', files);

    let hadFallback = false;
    const onFallback = (): void => {
      hadFallback = true;
    };

    const epubFiles: KavitaFile[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const fileValue = files[fileIndex];
      if (!fileValue || typeof fileValue !== 'object' || Array.isArray(fileValue)) {
        throw new KavitaPayloadError(formatFilePath(base, index, fileIndex), 'object', fileValue);
      }
      const file = fileValue as Row;
      const fileFormat = integer(file.format);
      const extension = typeof file.extension === 'string' ? file.extension : null;
      if (!isEpubFile(file) && !(fileFormat === undefined && format === 3 && !extension)) {
        if (fileFormat !== undefined && NON_EPUB_FORMATS.has(fileFormat)) continue;
        if (extension && !/^\.?epub$/i.test(extension)) continue;
        throw new KavitaPayloadError(
          formatFilePath(base, index, fileIndex, 'format'),
          'known format',
          file.format,
        );
      }
      const fileId = integer(file.id);
      if (fileId === undefined) {
        throw new KavitaPayloadError(
          formatFilePath(base, index, fileIndex, 'id'),
          'integer',
          file.id,
        );
      }
      const bytes = integer(file.bytes);
      if (bytes === undefined) {
        hadFallback = true;
        fallback(
          DETAIL_ENDPOINT,
          formatFilePath(base, index, fileIndex, 'bytes'),
          file.bytes,
          'integer',
        );
      }
      epubFiles.push({
        id: fileId,
        format: 3,
        extension,
        bytes: bytes ?? 0,
      });
    }
    if (!epubFiles.length) continue;

    const volumeId =
      row.volumeId == null && parentVolumeId !== undefined
        ? parentVolumeId
        : id(row.volumeId, base, index, 'volumeId');
    const writers: KavitaPerson[] = [];
    if (Array.isArray(row.writers)) {
      for (let writerIndex = 0; writerIndex < row.writers.length; writerIndex += 1) {
        const writer = row.writers[writerIndex];
        if (
          writer &&
          typeof writer === 'object' &&
          !Array.isArray(writer) &&
          typeof (writer as Row).name === 'string'
        ) {
          writers.push({ name: (writer as Row).name as string });
        } else {
          hadFallback = true;
          fallback(DETAIL_ENDPOINT, formatPath(base, index, 'writers'), writer, 'object');
        }
      }
    }

    const chapterId = id(row.id, base, index, 'id');
    const title = text(row.title, DETAIL_ENDPOINT, base, index, 'title', onFallback);
    const titleName = text(row.titleName, DETAIL_ENDPOINT, base, index, 'titleName', onFallback);
    const summary = text(row.summary, DETAIL_ENDPOINT, base, index, 'summary', onFallback);
    const pages = count(row.pages, DETAIL_ENDPOINT, base, index, 'pages', onFallback);
    const pagesRead = progress(
      row.pagesRead,
      DETAIL_ENDPOINT,
      base,
      index,
      'pagesRead',
      onFallback,
    );
    const lastReadingProgressUtc =
      date(
        row.lastReadingProgressUtc,
        DETAIL_ENDPOINT,
        base,
        index,
        'lastReadingProgressUtc',
        true,
        onFallback,
      ) || null;

    const normalized: KavitaChapter =
      pagesRead === undefined
        ? {
            id: chapterId,
            volumeId,
            format: 3,
            files: epubFiles,
            writers,
            title,
            titleName,
            summary,
            pages,
            lastReadingProgressUtc,
          }
        : {
            id: chapterId,
            volumeId,
            format: 3,
            files: epubFiles,
            writers,
            title,
            titleName,
            summary,
            pages,
            pagesRead,
            lastReadingProgressUtc,
          };
    if (!hadFallback && !cache.has(chapterId)) {
      cache.set(chapterId, normalized);
    }
    result.push(normalized);
  }
  return result;
}

export function normalizeSeriesDetail(payload: unknown): KavitaSeriesDetail {
  const row = object(payload, '$');
  const rawChapters = collection(row, 'chapters', '$');
  const rawSpecials = collection(row, 'specials', '$');
  const rawStorylineChapters = collection(row, 'storylineChapters', '$');
  const rawVolumes = collection(row, 'volumes', '$');
  if (
    !Array.isArray(row.chapters) &&
    !Array.isArray(row.specials) &&
    !Array.isArray(row.storylineChapters) &&
    !Array.isArray(row.volumes)
  )
    throw new KavitaPayloadError('$', 'series detail', payload);
  let incomplete = false;
  const markIncomplete = (path: string, value: unknown): void => {
    incomplete = true;
    fallback(DETAIL_ENDPOINT, path, value, 'array');
  };
  if (row.chapters === null) markIncomplete('$.chapters', null);
  if (row.specials === null) markIncomplete('$.specials', null);
  if (row.storylineChapters === null) markIncomplete('$.storylineChapters', null);
  if (row.volumes === null) markIncomplete('$.volumes', null);

  const cache = new Map<number, KavitaChapter>();
  const normalizedChapters = chapters(rawChapters, '$.chapters', markIncomplete, cache);
  const normalizedSpecials = chapters(rawSpecials, '$.specials', markIncomplete, cache);
  const normalizedStorylineChapters = chapters(
    rawStorylineChapters,
    '$.storylineChapters',
    markIncomplete,
    cache,
  );
  const volumes: KavitaVolume[] = [];
  for (let index = 0; index < rawVolumes.length; index += 1) {
    const volume = object(rawVolumes[index], '$.volumes', index);
    const volumeId = integer(volume.id);
    const rawVolumeChapters = volume.chapters;
    let volumeChapters: unknown[];
    if (rawVolumeChapters == null) {
      markIncomplete(formatPath('$.volumes', index, 'chapters'), rawVolumeChapters);
      volumeChapters = [];
    } else if (Array.isArray(rawVolumeChapters)) {
      volumeChapters = rawVolumeChapters;
    } else {
      throw new KavitaPayloadError(
        formatPath('$.volumes', index, 'chapters'),
        'array',
        rawVolumeChapters,
      );
    }
    const items = chapters(volumeChapters, index, markIncomplete, cache, volumeId);
    if (!items.length) continue;
    volumes.push({ id: id(volume.id, '$.volumes', index, 'id'), chapters: items });
  }

  const detail: KavitaSeriesDetail = {
    chapters: normalizedChapters,
    specials: normalizedSpecials,
    storylineChapters: normalizedStorylineChapters,
    volumes,
  };
  if (incomplete) detail.incomplete = true;
  return detail;
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z0-9]+));/gi,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined) {
        const codePoint = Number.parseInt(dec, 10);
        return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (hex !== undefined) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)
          ? String.fromCodePoint(codePoint)
          : match;
      }
      switch (named?.toLowerCase()) {
        case 'nbsp':
          return ' ';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        default:
          return match;
      }
    },
  );
}

function isHtmlWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function findRawTextElementEnd(
  lowerHtml: string,
  tagName: 'script' | 'style',
  from: number,
): number {
  const closePrefix = `</${tagName}`;
  let searchFrom = from;
  while (searchFrom < lowerHtml.length) {
    const candidate = lowerHtml.indexOf(closePrefix, searchFrom);
    if (candidate === -1) return lowerHtml.length;
    const afterName = candidate + closePrefix.length;
    const boundary = lowerHtml[afterName];
    if (boundary === undefined) return lowerHtml.length;
    if (boundary === '>' || boundary === '/' || isHtmlWhitespace(boundary)) {
      const endBracket = lowerHtml.indexOf('>', afterName);
      return endBracket === -1 ? lowerHtml.length : endBracket + 1;
    }
    searchFrom = afterName;
  }
  return lowerHtml.length;
}

function stripSimpleHtml(html: string): string {
  const lowerHtml = html.toLowerCase();
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) {
      chunks.push(decodeHtmlEntities(html.slice(cursor)));
      break;
    }
    if (tagStart > cursor) {
      chunks.push(decodeHtmlEntities(html.slice(cursor, tagStart)));
    }

    if (lowerHtml.startsWith('<!--', tagStart)) {
      const commentEnd = lowerHtml.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) break;
      cursor = commentEnd + 3;
      continue;
    }

    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd === -1) break;

    const rawTag = lowerHtml.slice(tagStart + 1, tagEnd).trim();
    cursor = tagEnd + 1;

    let nameEnd = 0;
    while (nameEnd < rawTag.length) {
      const ch = rawTag[nameEnd]!;
      if (isHtmlWhitespace(ch) || (ch === '/' && nameEnd > 0)) break;
      nameEnd += 1;
    }
    const tagName = rawTag.slice(0, nameEnd);
    const selfClosing = rawTag.endsWith('/');

    if ((tagName === 'script' || tagName === 'style') && !selfClosing) {
      cursor = findRawTextElementEnd(lowerHtml, tagName, cursor);
      continue;
    }

    if (tagName === 'br') {
      chunks.push('\n');
      continue;
    }

    if (
      tagName === '/p' ||
      tagName === '/div' ||
      tagName === '/li' ||
      tagName === '/blockquote' ||
      (tagName.length === 3 && tagName.startsWith('/h') && tagName[2]! >= '1' && tagName[2]! <= '6')
    ) {
      chunks.push('\n');
      let next = cursor;
      while (next < html.length && isHtmlWhitespace(html[next]!)) {
        next += 1;
      }
      if (next < html.length && html[next] === '<') {
        cursor = next;
      }
    }
  }

  return chunks.join('').trim();
}

function extractProseMirrorText(node: unknown): string | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Row;
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((child) => extractProseMirrorText(child))
      .filter((item): item is string => item !== null);
    if (record.type === 'doc') return parts.join('\n').trim();
    return parts.join('');
  }
  if (Object.keys(record).length === 0) return '';
  return null;
}

export function extractAnnotationNote(
  commentPlainText: unknown,
  commentHtml: unknown,
  comment: unknown,
): string {
  if (typeof commentPlainText === 'string' && commentPlainText.trim()) {
    return commentPlainText.trim();
  }
  if (typeof commentHtml === 'string' && commentHtml.trim()) {
    const stripped = stripSimpleHtml(commentHtml);
    if (stripped) return stripped;
  }
  if (typeof comment === 'string' && comment.trim()) {
    const trimmed = comment.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = extractProseMirrorText(JSON.parse(trimmed));
        if (parsed !== null) return parsed;
      } catch {
        // Fall through to plain-text comment.
      }
    }
    return trimmed;
  }
  return '';
}

export function formatAnnotationCommentFields(note: string): {
  comment: string;
  commentHtml: string;
} {
  const trimmed = note.trim();
  if (!trimmed) return { comment: '', commentHtml: '' };
  const lines = trimmed.split(/\r?\n/);
  return {
    comment: JSON.stringify({
      type: 'doc',
      content: lines.map((line) =>
        line
          ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
          : { type: 'paragraph' },
      ),
    }),
    commentHtml: lines.map((line) => `<p>${escapeHtmlText(line)}</p>`).join(''),
  };
}

export function normalizeAnnotation(
  payload: unknown,
  endpoint = '/api/Annotation',
  index?: number,
): KavitaAnnotation {
  const row = object(payload, '$', index);
  const selectedText = typeof row.selectedText === 'string' ? row.selectedText : '';
  const xPath = typeof row.xPath === 'string' ? row.xPath : '';
  const comment = typeof row.comment === 'string' ? row.comment : '';
  const commentHtml = typeof row.commentHtml === 'string' ? row.commentHtml : '';
  const commentPlainText = extractAnnotationNote(row.commentPlainText, commentHtml, comment);
  return {
    id: id(row.id, '$', index, 'id'),
    chapterId: id(row.chapterId, '$', index, 'chapterId'),
    volumeId: count(row.volumeId, endpoint, '$', index, 'volumeId'),
    seriesId: count(row.seriesId, endpoint, '$', index, 'seriesId'),
    libraryId: count(row.libraryId, endpoint, '$', index, 'libraryId'),
    ownerUserId: count(row.ownerUserId, endpoint, '$', index, 'ownerUserId'),
    xPath,
    endingXPath: typeof row.endingXPath === 'string' && row.endingXPath ? row.endingXPath : null,
    selectedText,
    comment,
    commentHtml,
    commentPlainText,
    chapterTitle:
      typeof row.chapterTitle === 'string' && row.chapterTitle ? row.chapterTitle : null,
    context: typeof row.context === 'string' && row.context ? row.context : null,
    highlightCount: count(
      row.highlightCount ?? selectedText.length,
      endpoint,
      '$',
      index,
      'highlightCount',
    ),
    containsSpoiler: row.containsSpoiler === true,
    pageNumber: count(row.pageNumber, endpoint, '$', index, 'pageNumber'),
    selectedSlotIndex: count(row.selectedSlotIndex, endpoint, '$', index, 'selectedSlotIndex'),
    createdUtc: date(row.createdUtc, endpoint, '$', index, 'createdUtc', true),
    lastModifiedUtc: date(row.lastModifiedUtc, endpoint, '$', index, 'lastModifiedUtc', true),
  };
}

export function normalizeAnnotations(
  payload: unknown,
  endpoint = '/api/Annotation/all',
): KavitaAnnotation[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.map((value, index) => normalizeAnnotation(value, endpoint, index));
}

export function normalizePersonalToc(
  payload: unknown,
  endpoint = '/api/Reader/ptoc',
): KavitaPersonalTocItem[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.flatMap((value, index) => {
    const row = object(value, '$', index);
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) {
      fallback(endpoint, formatPath('$', index, 'title'), row.title, 'nonempty string');
      return [];
    }
    return [
      {
        id: id(row.id, '$', index, 'id'),
        chapterId: id(row.chapterId, '$', index, 'chapterId'),
        pageNumber: count(row.pageNumber, endpoint, '$', index, 'pageNumber'),
        title,
        bookScrollId:
          typeof row.bookScrollId === 'string' && row.bookScrollId ? row.bookScrollId : null,
        selectedText:
          typeof row.selectedText === 'string' && row.selectedText ? row.selectedText : null,
        chapterTitle:
          typeof row.chapterTitle === 'string' && row.chapterTitle ? row.chapterTitle : null,
      },
    ];
  });
}
