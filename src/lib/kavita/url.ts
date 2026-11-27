export class ServerUrlError extends Error {}

export interface NormalizedServerUrl {
  baseUrl: string;
  insecure: boolean;
  apiKey?: string;
}

const KAVITA_OPDS_PATH = /^(.*?)\/api\/opds(?:\/([^/]+)(?:\/.*)?)?$/i;
const KAVITA_API_SUFFIX = /\/api(?:\/.*)?$/i;
const KAVITA_UI_SUFFIX =
  /\/(?:preferences|settings|home|login|registration|admin|collections|reading-lists|bookmarks|want-to-read|all-series|announcements)(?:\/.*)?$|\/library\/\d+(?:\/.*)?$/i;

export function normalizeServerUrl(input: string): NormalizedServerUrl {
  const value = input.trim();
  if (!value) throw new ServerUrlError('Enter your Kavita server address.');

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new ServerUrlError('Enter a valid server address, such as https://books.example.com.');
  }

  if (!url.hostname) {
    throw new ServerUrlError('Enter a valid server address, such as https://books.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ServerUrlError('The server address must use HTTPS or HTTP.');
  }
  if (url.username || url.password || url.search) {
    throw new ServerUrlError('Remove credentials and query parameters from the address.');
  }

  url.hash = '';

  let path = url.pathname.replace(/\/+$/, '');
  let extractedApiKey: string | undefined;
  const opdsMatch = KAVITA_OPDS_PATH.exec(path);
  if (opdsMatch) {
    path = opdsMatch[1] ?? '';
    if (opdsMatch[2]) {
      try {
        const decoded = decodeURIComponent(opdsMatch[2]).trim();
        if (decoded) extractedApiKey = decoded;
      } catch {
        throw new ServerUrlError(
          'Enter a valid server address, such as https://books.example.com.',
        );
      }
    }
  } else {
    path = path.replace(KAVITA_API_SUFFIX, '').replace(KAVITA_UI_SUFFIX, '');
  }

  url.pathname = path || '/';

  const normalized: NormalizedServerUrl = {
    baseUrl: url.toString().replace(/\/$/, ''),
    insecure: url.protocol === 'http:',
  };
  if (extractedApiKey) normalized.apiKey = extractedApiKey;
  return normalized;
}

export function extractPastedOpdsUrl(input: string): { baseUrl: string; apiKey: string } | null {
  const value = input.trim();
  if (!value || !/\/api\/opds\/[^/?#\s]+/i.test(value)) return null;
  try {
    const normalized = normalizeServerUrl(value);
    if (!normalized.apiKey) return null;
    return { baseUrl: normalized.baseUrl, apiKey: normalized.apiKey };
  } catch {
    return null;
  }
}
