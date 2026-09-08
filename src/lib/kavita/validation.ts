import type {
  KavitaChapter,
  KavitaLibrary,
  KavitaProgress,
  KavitaSeries,
  KavitaSeriesDetail,
  KavitaVolume,
  KavitaFile,
  KavitaPerson,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isKavitaLibrary(value: unknown): value is KavitaLibrary {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    (value.name === null || isString(value.name)) &&
    isInteger(value.type)
  );
}

export function isKavitaSeries(value: unknown): value is KavitaSeries {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isString(value.name) &&
    isInteger(value.libraryId) &&
    isInteger(value.format) &&
    isInteger(value.pages) &&
    isInteger(value.pagesRead) &&
    isString(value.created) &&
    isString(value.latestReadDate) &&
    isString(value.coverImage)
  );
}

export function isKavitaFile(value: unknown): value is KavitaFile {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isInteger(value.bytes) &&
    isString(value.extension) &&
    isInteger(value.format)
  );
}

export function isKavitaPerson(value: unknown): value is KavitaPerson {
  return isRecord(value) && isString(value.name);
}

export function isKavitaChapter(value: unknown): value is KavitaChapter {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isString(value.title) &&
    isString(value.titleName) &&
    isInteger(value.volumeId) &&
    isInteger(value.pages) &&
    (value.pagesRead === undefined || isInteger(value.pagesRead)) &&
    isString(value.summary) &&
    isInteger(value.format) &&
    Array.isArray(value.files) &&
    value.files.every(isKavitaFile) &&
    Array.isArray(value.writers) &&
    value.writers.every(isKavitaPerson) &&
    (value.lastReadingProgressUtc === undefined ||
      value.lastReadingProgressUtc === null ||
      isString(value.lastReadingProgressUtc))
  );
}

export function isKavitaVolume(value: unknown): value is KavitaVolume {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    Array.isArray(value.chapters) &&
    value.chapters.every(isKavitaChapter)
  );
}

export function isKavitaSeriesDetail(value: unknown): value is KavitaSeriesDetail {
  return (
    isRecord(value) &&
    Array.isArray(value.chapters) &&
    value.chapters.every(isKavitaChapter) &&
    Array.isArray(value.specials) &&
    value.specials.every(isKavitaChapter) &&
    Array.isArray(value.storylineChapters) &&
    value.storylineChapters.every(isKavitaChapter) &&
    (value.volumes === undefined ||
      (Array.isArray(value.volumes) && value.volumes.every(isKavitaVolume)))
  );
}

export function isKavitaProgress(value: unknown): value is KavitaProgress {
  return (
    isRecord(value) &&
    isInteger(value.libraryId) &&
    isInteger(value.seriesId) &&
    isInteger(value.volumeId) &&
    isInteger(value.chapterId) &&
    isInteger(value.pageNum) &&
    (value.bookScrollId === undefined ||
      value.bookScrollId === null ||
      isString(value.bookScrollId)) &&
    (value.lastModifiedUtc === undefined || isString(value.lastModifiedUtc))
  );
}

export function readHealthVersion(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  if (value.version === undefined || value.version === null) return null;
  return isString(value.version) ? value.version : null;
}
