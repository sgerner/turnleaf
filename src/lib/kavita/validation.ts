import type { KavitaProgress } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
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
