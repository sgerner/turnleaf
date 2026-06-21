export class ServerUrlError extends Error {}

export interface NormalizedServerUrl {
  baseUrl: string;
  insecure: boolean;
}

export function normalizeServerUrl(input: string): NormalizedServerUrl {
  const value = input.trim();
  if (!value) throw new ServerUrlError('Enter your Kavita server address.');

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new ServerUrlError('Enter a valid server address, such as https://books.example.com.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ServerUrlError('The server address must use HTTPS or HTTP.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServerUrlError(
      'Remove credentials, query parameters, and fragments from the address.',
    );
  }

  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
  url.pathname = path || '/';

  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    insecure: url.protocol === 'http:',
  };
}
