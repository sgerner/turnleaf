import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, ServerUrlError } from './url';

describe('normalizeServerUrl', () => {
  it('defaults to HTTPS and removes a trailing API path', () => {
    expect(normalizeServerUrl(' books.example.com/kavita/api/ ')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
    });
  });

  it('preserves an explicit port and reports plain HTTP', () => {
    expect(normalizeServerUrl('http://192.168.1.8:5000/')).toEqual({
      baseUrl: 'http://192.168.1.8:5000',
      insecure: true,
    });
  });

  it('rejects embedded credentials and query strings', () => {
    expect(() => normalizeServerUrl('https://user:pass@example.com?q=secret')).toThrow(
      ServerUrlError,
    );
  });
});
