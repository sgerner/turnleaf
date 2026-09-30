export type DiagnosticCategory = 'request' | 'response' | 'validation' | 'mapping';

export type DiagnosticEvent = {
  category: DiagnosticCategory;
  endpoint: string;
  status?: number;
  path?: string;
  expected?: string;
  actualType?: string;
  detail?: string;
};

export type DiagnosticContext = {
  appVersion: string;
  platform: string;
  kavitaVersion?: string | null;
};

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
const diagnostics: StoredDiagnostic[] = [];
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

function sanitizeEndpoint(value: string): string {
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

function sanitizeExpected(value: string | undefined): string | undefined {
  if (!value || value.length > 60 || !/^[a-zA-Z][a-zA-Z0-9_ <>|?,.[\]-]*$/.test(value)) return;
  const knownTypeWords = new Set([
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
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length || words.some((word) => !knownTypeWords.has(word))) return;
  return value;
}

function sanitizeActualType(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase();
  return normalized && ACTUAL_TYPES.has(normalized) ? normalized : undefined;
}

function sanitizeDetail(value: string | undefined): string | undefined {
  const allowed = new Set([
    'authentication',
    'invalid-field',
    'invalid-json',
    'invalid-response',
    'library-refresh-failed',
    'missing-field',
    'network',
    'network-error',
    'server',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function isCategory(value: string): value is DiagnosticCategory {
  return (
    value === 'request' || value === 'response' || value === 'validation' || value === 'mapping'
  );
}

export function recordDiagnostic(event: DiagnosticEvent): void {
  if (!event || !isCategory(event.category) || typeof event.endpoint !== 'string') return;

  // Pick fields explicitly: even untyped callers cannot smuggle payloads or URLs
  // into the retained record through extra object properties.
  const entry: StoredDiagnostic = {
    at: new Date().toISOString(),
    category: event.category,
    endpoint: sanitizeEndpoint(event.endpoint),
  };
  const status = event.status;
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
    entry.status = status;
  }
  const path = sanitizePath(event.path);
  const expected = sanitizeExpected(event.expected);
  const actualType = sanitizeActualType(event.actualType);
  const detail = sanitizeDetail(event.detail);
  if (path) entry.path = path;
  if (expected) entry.expected = expected;
  if (actualType) entry.actualType = actualType;
  if (detail) entry.detail = detail;

  diagnostics.push(entry);
  while (diagnostics.length > MAX_ENTRIES || JSON.stringify(diagnostics).length > MAX_LOG_CHARS) {
    diagnostics.shift();
  }
}

export function clearDiagnostics(): void {
  diagnostics.length = 0;
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
