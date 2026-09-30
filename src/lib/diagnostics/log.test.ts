import { beforeEach, describe, expect, it } from 'vitest';
import { clearDiagnostics, exportDiagnostics, getDiagnosticCount, recordDiagnostic } from './log';

describe('diagnostic log', () => {
  beforeEach(clearDiagnostics);

  it('exports useful response field details without a server URL or request data', () => {
    recordDiagnostic({
      category: 'validation',
      endpoint: 'http://private.example/library/api/Series/v2?apiKey=secret',
      status: 200,
      path: 'items[4].Name',
      expected: 'string or null',
      actualType: 'null',
      detail: 'invalid-field',
      // Extra fields from an untyped caller are deliberately ignored.
      body: { title: 'Private book title', apiKey: 'secret' },
    } as never);

    const text = exportDiagnostics({
      appVersion: '0.3.4+23',
      platform: 'android',
      kavitaVersion: '1.3.10',
    });
    expect(text).toContain('endpoint=/api/Series/v2');
    expect(text).toContain('status=200');
    expect(text).toContain('path=items[4].Name');
    expect(text).toContain('expected=string or null actual=null');
    expect(text).toContain('Platform: android');
    expect(text).toContain('Kavita version: 1.3.10');
    expect(text).not.toContain('private.example');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Private book title');
  });

  it('drops unsafe field paths and unrecognized types and details', () => {
    recordDiagnostic({
      category: 'response',
      endpoint: '/api/Series/v2',
      path: 'books[0].Secret Title',
      expected: 'Very private title',
      actualType: 'Private book title',
      detail: 'Private book title',
    });
    const text = exportDiagnostics({ appVersion: 'test', platform: 'web' });
    expect(text).not.toContain('Secret Title');
    expect(text).not.toContain('Private book title');
  });

  it('retains schema phrases and dollar-prefixed field paths', () => {
    recordDiagnostic({
      category: 'validation',
      endpoint: '/api/Series/series-detail',
      path: '$.series[2].detail',
      expected: 'series detail',
      actualType: 'object',
    });
    recordDiagnostic({
      category: 'validation',
      endpoint: '/api/Series/v2',
      path: '$[0].series',
      expected: 'known format',
      actualType: 'missing',
    });
    const text = exportDiagnostics({ appVersion: 'test', platform: 'android' });
    expect(text).toContain('path=$.series[2].detail expected=series detail actual=object');
    expect(text).toContain('path=$[0].series expected=known format actual=missing');
  });

  it('removes query strings, proxy prefixes, and numeric IDs from endpoints', () => {
    recordDiagnostic({
      category: 'request',
      endpoint: 'https://host.invalid/user-prefix/api/Series/123/cover?token=secret',
    });
    expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain(
      'endpoint=/api/Series/:id/cover',
    );
  });

  it('keeps a bounded in-memory ring and can clear it', () => {
    for (let index = 0; index < 120; index += 1) {
      recordDiagnostic({
        category: 'response',
        endpoint: '/api/Series/v2',
        detail: 'invalid-response',
      });
    }
    expect(getDiagnosticCount()).toBe(100);
    expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).toContain('Events: 100');
    clearDiagnostics();
    expect(getDiagnosticCount()).toBe(0);
  });

  it('caps exported text even if unusually long routes and field paths are supplied', () => {
    for (let index = 0; index < 100; index += 1) {
      recordDiagnostic({
        category: 'validation',
        endpoint: `/api/${'A'.repeat(200)}`,
        path: `field${'A'.repeat(150)}`,
        expected: 'object',
        actualType: 'object',
      });
    }
    expect(
      exportDiagnostics({ appVersion: 'test', platform: 'android' }).length,
    ).toBeLessThanOrEqual(48_000);
  });
});
