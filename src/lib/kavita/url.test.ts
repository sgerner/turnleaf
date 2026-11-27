import { describe, expect, it } from 'vitest';
import { extractPastedOpdsUrl, normalizeServerUrl, ServerUrlError } from './url';

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
    expect(() => normalizeServerUrl('https://books.example.com/api/opds/key?token=1')).toThrow(
      ServerUrlError,
    );
  });

  it('accepts bare hosts with or without explicit ports', () => {
    expect(normalizeServerUrl('books.example.com')).toEqual({
      baseUrl: 'https://books.example.com',
      insecure: false,
    });
    expect(normalizeServerUrl('192.168.1.8:5000')).toEqual({
      baseUrl: 'https://192.168.1.8:5000',
      insecure: false,
    });
  });

  it('strips URL fragments and known Kavita web route suffixes while preserving subpaths', () => {
    expect(normalizeServerUrl('https://books.example.com/preferences#clients')).toEqual({
      baseUrl: 'https://books.example.com',
      insecure: false,
    });
    expect(normalizeServerUrl('https://books.example.com/kavita/preferences#clients')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
    });
    expect(normalizeServerUrl('https://books.example.com/kavita/home')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
    });
    expect(normalizeServerUrl('https://books.example.com/kavita/login')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
    });
    expect(normalizeServerUrl('https://books.example.com/kavita/library/2/series/9')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
    });
    expect(normalizeServerUrl('https://books.example.com/library')).toEqual({
      baseUrl: 'https://books.example.com/library',
      insecure: false,
    });
  });

  it('extracts embedded OPDS keys and strips OPDS paths from baseUrl', () => {
    expect(normalizeServerUrl('https://books.example.com/kavita/api/opds/opds-key-123')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      insecure: false,
      apiKey: 'opds-key-123',
    });
    expect(normalizeServerUrl('books.example.com/api/opds/opds-key-123/libraries#top')).toEqual({
      baseUrl: 'https://books.example.com',
      insecure: false,
      apiKey: 'opds-key-123',
    });
    expect(extractPastedOpdsUrl('https://books.example.com/kavita/api/opds/opds-key-123')).toEqual({
      baseUrl: 'https://books.example.com/kavita',
      apiKey: 'opds-key-123',
    });
    expect(extractPastedOpdsUrl('https://books.example.com/kavita')).toBeNull();
  });
});
