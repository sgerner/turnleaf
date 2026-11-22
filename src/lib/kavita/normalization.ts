import { recordDiagnostic } from '../diagnostics/log';
import type {
  KavitaAnnotation,
  KavitaChapter,
  KavitaFile,
  KavitaLibrary,
  KavitaPersonalTocItem,
  KavitaSeries,
  KavitaSeriesDetail,
} from './types';

type Row = Record<string, unknown>;
const SERIES_ENDPOINT = '/api/Series/v2';
const DETAIL_ENDPOINT = '/api/Series/series-detail';
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

function object(value: unknown, path: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new KavitaPayloadError(path, 'object', value);
  return value as Row;
}

function integer(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function id(value: unknown, path: string): number {
  const n = integer(value);
  if (n === undefined) throw new KavitaPayloadError(path, 'integer', value);
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

function text(value: unknown, endpoint: string, path: string): string {
  if (typeof value === 'string') return value;
  fallback(endpoint, path, value, 'string');
  return '';
}

function date(value: unknown, endpoint: string, path: string, optional = false): string {
  if (optional && value == null) return '';
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  fallback(endpoint, path, value, 'string');
  return '';
}

function count(value: unknown, endpoint: string, path: string): number {
  const n = integer(value);
  if (n !== undefined) return n;
  fallback(endpoint, path, value, 'integer');
  return 0;
}

function progress(value: unknown, endpoint: string, path: string): number | undefined {
  const n = integer(value);
  if (n === undefined) fallback(endpoint, path, value, 'integer');
  return n;
}

function progressFields(value: unknown, endpoint: string, path: string): { pagesRead?: number } {
  const pagesRead = progress(value, endpoint, path);
  return pagesRead === undefined ? {} : { pagesRead };
}

export function normalizeLibraries(payload: unknown): KavitaLibrary[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.map((value, index) => {
    const p = `$[${index}]`,
      row = object(value, p);
    return {
      id: id(row.id, `${p}.id`),
      name: typeof row.name === 'string' ? row.name : null,
      type: id(row.type, `${p}.type`),
    };
  });
}

export function normalizeSeriesPage(payload: unknown): KavitaSeries[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.flatMap((value, index) => {
    const p = `$[${index}]`,
      row = object(value, p);
    const format = integer(row.format);
    // Other Kavita media are irrelevant to an EPUB reader; their metadata must not block it.
    if (format !== undefined && NON_EPUB_FORMATS.has(format)) return [];
    if (format !== 3) fallback(SERIES_ENDPOINT, `${p}.format`, row.format, 'known format');
    return [
      {
        id: id(row.id, `${p}.id`),
        libraryId: id(row.libraryId, `${p}.libraryId`),
        format: format === 3 ? 3 : -1,
        name: typeof row.name === 'string' ? row.name : null,
        coverImage: typeof row.coverImage === 'string' ? row.coverImage : null,
        pages: count(row.pages, SERIES_ENDPOINT, `${p}.pages`),
        ...progressFields(row.pagesRead, SERIES_ENDPOINT, `${p}.pagesRead`),
        created: date(row.created, SERIES_ENDPOINT, `${p}.created`),
        latestReadDate: date(row.latestReadDate, SERIES_ENDPOINT, `${p}.latestReadDate`, true),
      },
    ];
  });
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

function chapters(
  values: unknown[],
  path: string,
  markIncomplete: (path: string, value: unknown) => void,
  parentVolumeId?: number,
): KavitaChapter[] {
  return values.flatMap((value, index) => {
    const p = `${path}[${index}]`,
      row = object(value, p),
      format = integer(row.format);
    const files = row.files;
    const epubSignal = Array.isArray(files) && files.some(isEpubFile);
    if (format !== undefined && NON_EPUB_FORMATS.has(format) && !epubSignal) {
      if (!Array.isArray(files)) markIncomplete(`${p}.files`, files);
      return [];
    }
    if (!Array.isArray(files)) throw new KavitaPayloadError(`${p}.files`, 'array', files);
    if (!files.length) throw new KavitaPayloadError(`${p}.files`, 'nonempty array', files);
    const epubFiles: KavitaFile[] = files.flatMap((fileValue, fileIndex) => {
      const fp = `${p}.files[${fileIndex}]`,
        file = object(fileValue, fp);
      const fileFormat = integer(file.format);
      const extension = typeof file.extension === 'string' ? file.extension : null;
      if (!isEpubFile(file) && !(fileFormat === undefined && format === 3 && !extension)) {
        if (fileFormat !== undefined && NON_EPUB_FORMATS.has(fileFormat)) return [];
        if (extension && !/^\.?epub$/i.test(extension)) return [];
        throw new KavitaPayloadError(`${fp}.format`, 'known format', file.format);
      }
      return [
        {
          id: id(file.id, `${fp}.id`),
          format: 3,
          extension,
          bytes: count(file.bytes, DETAIL_ENDPOINT, `${fp}.bytes`),
        },
      ];
    });
    if (!epubFiles.length) return [];
    const volumeId =
      row.volumeId == null && parentVolumeId !== undefined
        ? parentVolumeId
        : id(row.volumeId, `${p}.volumeId`);
    const writers = Array.isArray(row.writers)
      ? row.writers.flatMap((writer) => {
          if (
            writer &&
            typeof writer === 'object' &&
            !Array.isArray(writer) &&
            typeof (writer as Row).name === 'string'
          )
            return [{ name: (writer as Row).name as string }];
          fallback(DETAIL_ENDPOINT, `${p}.writers`, writer, 'object');
          return [];
        })
      : [];
    return [
      {
        id: id(row.id, `${p}.id`),
        volumeId,
        format: 3,
        files: epubFiles,
        writers,
        title: text(row.title, DETAIL_ENDPOINT, `${p}.title`),
        titleName: text(row.titleName, DETAIL_ENDPOINT, `${p}.titleName`),
        summary: text(row.summary, DETAIL_ENDPOINT, `${p}.summary`),
        pages: count(row.pages, DETAIL_ENDPOINT, `${p}.pages`),
        ...progressFields(row.pagesRead, DETAIL_ENDPOINT, `${p}.pagesRead`),
        lastReadingProgressUtc:
          date(row.lastReadingProgressUtc, DETAIL_ENDPOINT, `${p}.lastReadingProgressUtc`, true) ||
          null,
      },
    ];
  });
}

export function normalizeSeriesDetail(payload: unknown): KavitaSeriesDetail {
  const row = object(payload, '$');
  const names = ['chapters', 'specials', 'storylineChapters', 'volumes'];
  names.forEach((name) => collection(row, name, '$'));
  if (!names.some((name) => Array.isArray(row[name])))
    throw new KavitaPayloadError('$', 'series detail', payload);
  let incomplete = false;
  const markIncomplete = (path: string, value: unknown): void => {
    incomplete = true;
    fallback(DETAIL_ENDPOINT, path, value, 'array');
  };
  names.forEach((name) => {
    if (row[name] === null) markIncomplete(`$.${name}`, row[name]);
  });
  const detail: KavitaSeriesDetail = {
    chapters: chapters(collection(row, 'chapters', '$'), '$.chapters', markIncomplete),
    specials: chapters(collection(row, 'specials', '$'), '$.specials', markIncomplete),
    storylineChapters: chapters(
      collection(row, 'storylineChapters', '$'),
      '$.storylineChapters',
      markIncomplete,
    ),
    volumes: collection(row, 'volumes', '$').flatMap((value, index) => {
      const p = `$.volumes[${index}]`,
        volume = object(value, p);
      const volumeId = integer(volume.id);
      if (volume.chapters == null) markIncomplete(`${p}.chapters`, volume.chapters);
      const items = chapters(
        collection(volume, 'chapters', p),
        `${p}.chapters`,
        markIncomplete,
        volumeId,
      );
      if (!items.length) return [];
      return [{ id: id(volume.id, `${p}.id`), chapters: items }];
    }),
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
  path = '$',
): KavitaAnnotation {
  const row = object(payload, path);
  const selectedText = typeof row.selectedText === 'string' ? row.selectedText : '';
  const xPath = typeof row.xPath === 'string' ? row.xPath : '';
  const comment = typeof row.comment === 'string' ? row.comment : '';
  const commentHtml = typeof row.commentHtml === 'string' ? row.commentHtml : '';
  const commentPlainText = extractAnnotationNote(row.commentPlainText, commentHtml, comment);
  return {
    id: id(row.id, `${path}.id`),
    chapterId: id(row.chapterId, `${path}.chapterId`),
    volumeId: count(row.volumeId, endpoint, `${path}.volumeId`),
    seriesId: count(row.seriesId, endpoint, `${path}.seriesId`),
    libraryId: count(row.libraryId, endpoint, `${path}.libraryId`),
    ownerUserId: count(row.ownerUserId, endpoint, `${path}.ownerUserId`),
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
      `${path}.highlightCount`,
    ),
    containsSpoiler: row.containsSpoiler === true,
    pageNumber: count(row.pageNumber, endpoint, `${path}.pageNumber`),
    selectedSlotIndex: count(row.selectedSlotIndex, endpoint, `${path}.selectedSlotIndex`),
    createdUtc: date(row.createdUtc, endpoint, `${path}.createdUtc`, true),
    lastModifiedUtc: date(row.lastModifiedUtc, endpoint, `${path}.lastModifiedUtc`, true),
  };
}

export function normalizeAnnotations(
  payload: unknown,
  endpoint = '/api/Annotation/all',
): KavitaAnnotation[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.map((value, index) => normalizeAnnotation(value, endpoint, `$[${index}]`));
}

export function normalizePersonalToc(
  payload: unknown,
  endpoint = '/api/Reader/ptoc',
): KavitaPersonalTocItem[] {
  if (!Array.isArray(payload)) throw new KavitaPayloadError('$', 'array', payload);
  return payload.flatMap((value, index) => {
    const p = `$[${index}]`;
    const row = object(value, p);
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) {
      fallback(endpoint, `${p}.title`, row.title, 'nonempty string');
      return [];
    }
    return [
      {
        id: id(row.id, `${p}.id`),
        chapterId: id(row.chapterId, `${p}.chapterId`),
        pageNumber: count(row.pageNumber, endpoint, `${p}.pageNumber`),
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
