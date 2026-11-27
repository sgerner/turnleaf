export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_AUTH_QUERY =
  /^(?:api[_-]?key|x-api-key|authorization|auth|(?:access|refresh)[_-]?token|token|password|secret)$/i;

export class KavitaError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'authentication' | 'server' | 'invalid-response',
    readonly status?: number | undefined,
  ) {
    super(message);
  }
}

export class KavitaOfflineError extends KavitaError {
  constructor(message = 'No network connection.') {
    super(message, 'network');
  }
}

export function hasSensitiveAuthQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => SENSITIVE_AUTH_QUERY.test(key));
}

export function nativeHeader(
  headers: Record<string, unknown> | null | undefined,
  name: string,
): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  if (typeof value === 'string') return value || null;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0] || null;
  return null;
}

export function assertSafeTransferTarget(
  rawUrl: string,
  serverOrigin?: string,
  invalidAddressMessage = 'Invalid Kavita download address.',
): { url: string; normalizedUrl: string; serverOrigin: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(invalidAddressMessage);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(invalidAddressMessage);
  }

  let expected: URL | null = null;
  if (serverOrigin !== undefined) {
    try {
      expected = new URL(serverOrigin);
    } catch {
      throw new Error('Invalid Kavita server origin.');
    }
    if (expected.protocol !== 'http:' && expected.protocol !== 'https:') {
      throw new Error('Invalid Kavita server origin.');
    }
  }

  const resolvedOrigin = expected ? expected.origin : parsed.origin;
  if (
    parsed.origin !== resolvedOrigin ||
    parsed.username ||
    parsed.password ||
    hasSensitiveAuthQuery(parsed)
  ) {
    const message =
      expected?.protocol === 'https:' && parsed.protocol === 'http:'
        ? 'Kavita redirected from HTTPS to insecure HTTP. Check the server’s proxy configuration.'
        : expected?.protocol === 'http:' && parsed.protocol === 'https:'
          ? 'Kavita redirected from HTTP to HTTPS. Update the saved address to its final HTTPS address.'
          : 'Kavita redirected to a different server. Update the saved address to its final address.';
    throw new KavitaError(message, 'server');
  }

  return {
    url: rawUrl,
    normalizedUrl: parsed.toString(),
    serverOrigin: resolvedOrigin,
  };
}

export function redirectTarget(
  status: number,
  location: string | null,
  currentUrl: string,
  serverOrigin: string,
  method: string,
  opaqueRedirect = false,
): string | null {
  if (opaqueRedirect) {
    throw new KavitaError(
      'Kavita redirected, but the browser could not safely verify the destination. Update the saved address to Kavita’s final address.',
      'server',
    );
  }
  if (status >= 300 && status < 400 && !REDIRECT_STATUSES.has(status)) {
    throw new KavitaError(
      'Kavita returned a redirect type Turnleaf cannot follow. Update the saved address to the final API address.',
      'server',
      status,
    );
  }
  if (!REDIRECT_STATUSES.has(status)) return null;
  if (!location) {
    throw new KavitaError('Kavita redirected without a destination address.', 'server', status);
  }

  let destination: URL;
  try {
    destination = new URL(location, currentUrl);
  } catch {
    throw new KavitaError('Kavita returned an invalid redirect address.', 'server', status);
  }

  let current: URL | null;
  try {
    current = new URL(currentUrl);
  } catch {
    current = null;
  }

  if (
    (destination.protocol !== 'http:' && destination.protocol !== 'https:') ||
    (current?.protocol === 'https:' && destination.protocol === 'http:') ||
    destination.origin !== serverOrigin ||
    destination.username ||
    destination.password ||
    hasSensitiveAuthQuery(destination)
  ) {
    const message =
      current?.protocol === 'http:' && destination.protocol === 'https:'
        ? 'Kavita redirected from HTTP to HTTPS. Update the saved address to its final HTTPS address.'
        : current?.protocol === 'https:' && destination.protocol === 'http:'
          ? 'Kavita redirected from HTTPS to insecure HTTP. Check the server’s proxy configuration.'
          : 'Kavita redirected to a different server. Update the saved address to its final address.';
    throw new KavitaError(message, 'server', status);
  }

  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && [301, 302, 303].includes(status)) {
    throw new KavitaError(
      'Kavita redirected a POST request with a status that changes its method. Update the saved address to the final API address.',
      'server',
      status,
    );
  }

  return destination.toString();
}

export function assertRedirectLimit(count: number, status: number): void {
  if (count > MAX_REDIRECTS) {
    throw new KavitaError(
      'Kavita redirected too many times. Check the saved server address.',
      'server',
      status,
    );
  }
}

export interface RedirectState {
  currentUrl: string;
  readonly serverOrigin: string;
  readonly method: string;
  readonly visited: Set<string>;
  redirectCount: number;
}

export function createRedirectState(
  initialUrl: string,
  serverOrigin: string,
  method = 'GET',
  normalizedInitialUrl = initialUrl,
): RedirectState {
  return {
    currentUrl: initialUrl,
    serverOrigin,
    method,
    visited: new Set([normalizedInitialUrl]),
    redirectCount: 0,
  };
}

export function advanceRedirect(
  state: RedirectState,
  status: number,
  location: string | null,
  opaqueRedirect = false,
): string | null {
  const nextUrl = redirectTarget(
    status,
    location,
    state.currentUrl,
    state.serverOrigin,
    state.method,
    opaqueRedirect,
  );
  if (!nextUrl) return null;
  assertRedirectLimit(++state.redirectCount, status);
  if (state.visited.has(nextUrl)) {
    throw new KavitaError(
      'Kavita redirected in a loop. Check the saved server address.',
      'server',
      status,
    );
  }
  state.visited.add(nextUrl);
  state.currentUrl = nextUrl;
  return nextUrl;
}
