import { describe, expect, it } from 'vitest';
import { redactDiagnosticText, redactDiagnosticValue } from './redaction';

describe('diagnostic redaction', () => {
  it('redacts known secret fields from structured diagnostics', () => {
    expect(
      redactDiagnosticValue({
        server: 'https://read.example.com',
        apiKey: 'secret-key',
        headers: {
          'x-api-key': 'header-secret',
          Authorization: 'Bearer token-secret',
        },
        nested: [{ token: 'nested-token' }],
      }),
    ).toEqual({
      server: 'https://read.example.com',
      apiKey: '[redacted]',
      headers: {
        'x-api-key': '[redacted]',
        Authorization: '[redacted]',
      },
      nested: [{ token: '[redacted]' }],
    });
  });

  it('redacts auth query parameters from diagnostic strings', () => {
    expect(
      redactDiagnosticValue(
        'https://read.example.com/api/Download/chapter?chapterId=7&apiKey=secret-key',
      ),
    ).toBe('https://read.example.com/api/Download/chapter?chapterId=7&apiKey=%5Bredacted%5D');
  });

  it('redacts common secret patterns from diagnostic text', () => {
    expect(
      redactDiagnosticText(
        'x-api-key: secret Authorization=BearerToken https://x.test/path?token=abc123',
      ),
    ).toBe('x-api-key: [redacted] Authorization: [redacted] https://x.test/path?token=[redacted]');
  });
});
