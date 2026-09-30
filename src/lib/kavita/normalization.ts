import { recordDiagnostic } from '../diagnostics/log';
import type {
  KavitaChapter,
  KavitaFile,
  KavitaLibrary,
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

function date(value: unknown, endpoint: string, path: string): string {
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
        latestReadDate: date(row.latestReadDate, SERIES_ENDPOINT, `${p}.latestReadDate`),
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
          date(row.lastReadingProgressUtc, DETAIL_ENDPOINT, `${p}.lastReadingProgressUtc`) || null,
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
