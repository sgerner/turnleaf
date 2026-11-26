import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem, type Encoding } from '@capacitor/filesystem';

export type DiagnosticCategory =
  'request' | 'response' | 'validation' | 'mapping' | 'download' | 'startup';

export type DiagnosticEvent = {
  category: DiagnosticCategory;
  endpoint: string;
  status?: number | undefined;
  path?: string | undefined;
  expected?: string | undefined;
  actualType?: string | undefined;
  detail?: string | undefined;
};

export type DiagnosticContext = {
  appVersion: string;
  platform: string;
  kavitaVersion?: string | null | undefined;
};

export type DiagnosticsListener = (count: number) => void;

type StoredDiagnostic = Required<Pick<DiagnosticEvent, 'category' | 'endpoint'>> & {
  at: string;
  status?: number;
  path?: string;
  expected?: string;
  actualType?: string;
  detail?: string;
};

const MAX_ENTRIES = 100;
const MAX_LOG_CHARS = 48_000;
const MAX_PERSISTED_CHARS = 128_000;
const DIAGNOSTICS_FILE_PATH = 'diagnostics.json';
const BROWSER_DIAGNOSTICS_KEY = 'turnleaf_diagnostics_v1';
const UTF8 = 'utf8' as Encoding;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const diagnostics: StoredDiagnostic[] = [];
const listeners = new Set<DiagnosticsListener>();

let hydrated = false;
let hydrating: Promise<void> | null = null;
let persistRevision = 0;
let nativeWritePromise: Promise<void> | null = null;
let nativeWriteDirty = false;

const ACTUAL_TYPES = new Set([
  'array',
  'boolean',
  'missing',
  'null',
  'number',
  'object',
  'string',
  'undefined',
]);

const LOCAL_ENDPOINTS = new Set(['local/credentials', 'local/database', 'local/setup']);

function sanitizeEndpoint(value: string): string {
  if (LOCAL_ENDPOINTS.has(value)) return value;

  // Endpoints may be passed as request URLs. Keep only the Kavita route, never the
  // origin, reverse proxy prefix, query string, or fragment.
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? '';
  const apiIndex = withoutQuery.toLowerCase().lastIndexOf('/api/');
  if (apiIndex < 0) return '[unknown endpoint]';

  const route = withoutQuery.slice(apiIndex).replace(/\/(\d+)(?=\/|$)/g, '/:id');
  if (!/^\/api(?:\/[a-zA-Z0-9._:-]+)+$/.test(route) || route.includes('..')) {
    return '[unknown endpoint]';
  }
  return route.slice(0, 120);
}

function sanitizePath(value: string | undefined): string | undefined {
  if (!value || value.length > 180 || !/^[a-zA-Z0-9_$.[\]-]+$/.test(value)) return undefined;
  return value;
}

const KNOWNTYPEWORDS = new Set([
  'any',
  'array',
  'boolean',
  'id',
  'integer',
  'known',
  'format',
  'null',
  'number',
  'object',
  'of',
  'optional',
  'or',
  'record',
  'detail',
  'nonempty',
  'series',
  'string',
  'undefined',
  'unknown',
]);

function sanitizeExpected(value: string | undefined): string | undefined {
  if (!value || value.length > 60 || !/^[a-zA-Z][a-zA-Z0-9_ <>|?,.[\]-]*$/.test(value)) return;
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length || words.some((word) => !KNOWNTYPEWORDS.has(word))) return;
  return value;
}

function sanitizeActualType(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase();
  return normalized && ACTUAL_TYPES.has(normalized) ? normalized : undefined;
}

const ALLOWED = new Set([
  'authentication',
  'credential-cleanup-failed',
  'credential-read-failed',
  'credential-save-failed',
  'database-open-failed',
  'database-reset-failed',
  'download-connection',
  'download-retry',
  'download-status-unconfirmed',
  'download-storage',
  'download-storage-cleanup',
  'download-transfer',
  'download-validation',
  'insecure-http-blocked',
  'invalid-field',
  'invalid-json',
  'invalid-response',
  'invalid-server-url',
  'library-refresh-failed',
  'missing-auth-key',
  'missing-field',
  'network',
  'network-error',
  'no-book-libraries',
  'notes-restore-failed',
  'server',
  'server-save-failed',
  'setup-failed',
]);

function sanitizeDetail(value: string | undefined): string | undefined {
  return value && ALLOWED.has(value) ? value : undefined;
}

function isCategory(value: string): value is DiagnosticCategory {
  return (
    value === 'request' ||
    value === 'response' ||
    value === 'validation' ||
    value === 'mapping' ||
    value === 'download' ||
    value === 'startup'
  );
}

function sanitizeTimestamp(value: unknown, fallback: string): string {
  if (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return value;
  }
  return fallback;
}

function toStoredDiagnostic(raw: unknown, fallbackTimestamp: string): StoredDiagnostic | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.category !== 'string' ||
    !isCategory(candidate.category) ||
    typeof candidate.endpoint !== 'string'
  ) {
    return null;
  }

  // Pick fields explicitly: even untyped callers or tampered persisted records cannot
  // smuggle payloads, titles, credentials, or URLs through extra object properties.
  const entry: StoredDiagnostic = {
    at: sanitizeTimestamp(candidate.at, fallbackTimestamp),
    category: candidate.category,
    endpoint: sanitizeEndpoint(candidate.endpoint),
  };
  const status = candidate.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    entry.status = status;
  }
  const path = typeof candidate.path === 'string' ? sanitizePath(candidate.path) : undefined;
  const expected =
    typeof candidate.expected === 'string' ? sanitizeExpected(candidate.expected) : undefined;
  const actualType =
    typeof candidate.actualType === 'string' ? sanitizeActualType(candidate.actualType) : undefined;
  const detail =
    typeof candidate.detail === 'string' ? sanitizeDetail(candidate.detail) : undefined;
  if (path) entry.path = path;
  if (expected) entry.expected = expected;
  if (actualType) entry.actualType = actualType;
  if (detail) entry.detail = detail;

  return entry;
}

function notifySubscribers(): void {
  const count = diagnostics.length;
  for (const listener of listeners) {
    listener(count);
  }
}

function writeBrowserDiagnostics(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(BROWSER_DIAGNOSTICS_KEY, JSON.stringify(diagnostics));
  } catch {
    // Diagnostics persistence is best-effort and must never break caller error handling.
  }
}

function clearBrowserDiagnostics(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.removeItem(BROWSER_DIAGNOSTICS_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

async function flushNativeWrites(revision: number): Promise<void> {
  while (revision === persistRevision) {
    nativeWriteDirty = false;
    const serialized = JSON.stringify(diagnostics);
    try {
      await Filesystem.writeFile?.({
        path: DIAGNOSTICS_FILE_PATH,
        data: serialized,
        directory: Directory.Data,
        encoding: UTF8,
      });
    } catch {
      // Swallow native filesystem errors so startup and onboarding screens never crash.
    }
    if (!nativeWriteDirty || revision !== persistRevision) break;
  }
}

function persistDiagnostics(): void {
  if (hydrating) return;

  if (!Capacitor.isNativePlatform()) {
    writeBrowserDiagnostics();
    return;
  }

  if (nativeWritePromise) {
    nativeWriteDirty = true;
    return;
  }

  const revision = persistRevision;
  const current = flushNativeWrites(revision).finally(() => {
    if (nativeWritePromise === current) {
      nativeWritePromise = null;
    }
  });
  nativeWritePromise = current;
}

async function readRawPersistedDiagnostics(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await Filesystem.readFile?.({
        path: DIAGNOSTICS_FILE_PATH,
        directory: Directory.Data,
        encoding: UTF8,
      });
      return typeof result?.data === 'string' ? result.data : null;
    } catch {
      return null;
    }
  }

  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(BROWSER_DIAGNOSTICS_KEY) ?? null;
  } catch {
    return null;
  }
}

function parsePersistedEntries(raw: string): StoredDiagnostic[] {
  if (!raw || raw.length > MAX_PERSISTED_CHARS) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    const fallbackTimestamp = new Date(0).toISOString();
    const sanitized: StoredDiagnostic[] = [];
    for (const item of items) {
      const entry = toStoredDiagnostic(item, fallbackTimestamp);
      if (entry) sanitized.push(entry);
    }
    return sanitized.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function subscribeDiagnostics(listener: DiagnosticsListener): () => void {
  listeners.add(listener);
  listener(diagnostics.length);
  return () => {
    listeners.delete(listener);
  };
}

export async function hydrateDiagnostics(): Promise<void> {
  if (hydrated) return;
  if (hydrating) return hydrating;

  const revision = persistRevision;
  const current = (async () => {
    const raw = await readRawPersistedDiagnostics();
    if (revision !== persistRevision) return;

    const olderEntries = raw ? parsePersistedEntries(raw) : [];
    const hadRecentEvents = diagnostics.length > 0;
    if (olderEntries.length > 0) {
      const merged = [...olderEntries, ...diagnostics].slice(-MAX_ENTRIES);
      diagnostics.length = 0;
      diagnostics.push(...merged);
    }

    hydrated = true;
    hydrating = null;

    if (olderEntries.length > 0 || hadRecentEvents) {
      persistDiagnostics();
    }
    if (olderEntries.length > 0) {
      notifySubscribers();
    }
  })();

  hydrating = current;
  try {
    await current;
  } finally {
    if (hydrating === current) {
      hydrating = null;
    }
  }
}

export function recordDiagnostic(event: DiagnosticEvent): void {
  const entry = toStoredDiagnostic(
    event ? { ...event, at: new Date().toISOString() } : null,
    new Date().toISOString(),
  );
  if (!entry) return;

  diagnostics.push(entry);
  if (diagnostics.length > MAX_ENTRIES) {
    diagnostics.shift();
  }
  persistDiagnostics();
  notifySubscribers();
}

export function clearDiagnostics(): Promise<void> {
  diagnostics.length = 0;
  hydrated = false;
  hydrating = null;
  nativeWriteDirty = false;
  persistRevision += 1;
  const revision = persistRevision;
  const inFlightWrite = nativeWritePromise;

  clearBrowserDiagnostics();
  notifySubscribers();

  if (!Capacitor.isNativePlatform()) {
    return Promise.resolve();
  }

  const deleteNativeFile = async (): Promise<void> => {
    if (inFlightWrite) {
      await inFlightWrite.catch(() => {});
      if (revision !== persistRevision) return;
    }
    try {
      await Filesystem.deleteFile?.({
        path: DIAGNOSTICS_FILE_PATH,
        directory: Directory.Data,
      });
    } catch {
      // Ignore missing file or unavailable native storage.
    }
  };

  return deleteNativeFile();
}

export function getDiagnosticCount(): number {
  return diagnostics.length;
}

function sanitizeContextValue(value: string | null | undefined, maxLength: number): string {
  if (!value) return 'unknown';
  const safe = value.replace(/[^a-zA-Z0-9.+_-]/g, '').slice(0, maxLength);
  return safe || 'unknown';
}

export function exportDiagnostics(context: DiagnosticContext): string {
  const lines = [
    'Turnleaf diagnostics',
    `App version: ${sanitizeContextValue(context.appVersion, 32)}`,
    `Platform: ${sanitizeContextValue(context.platform, 24)}`,
    `Kavita version: ${sanitizeContextValue(context.kavitaVersion, 32)}`,
    'Server address, API key, book titles, and response bodies are not included.',
    `Events: ${diagnostics.length}`,
    '',
  ];
  for (const entry of diagnostics) {
    const fields = [
      `${entry.at} ${entry.category}`,
      `endpoint=${entry.endpoint}`,
      entry.status === undefined ? undefined : `status=${entry.status}`,
      entry.path ? `path=${entry.path}` : undefined,
      entry.expected ? `expected=${entry.expected}` : undefined,
      entry.actualType ? `actual=${entry.actualType}` : undefined,
      entry.detail ? `detail=${entry.detail}` : undefined,
    ].filter(Boolean);
    lines.push(fields.join(' '));
  }
  return lines.join('\n').slice(0, MAX_LOG_CHARS);
}
