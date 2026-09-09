import { describe, expect, it } from 'vitest';
import { auditArguments, npmExecutable } from './security-audit.mjs';

describe('security audit command', () => {
  it('uses the platform npm executable', () => {
    expect(npmExecutable('linux')).toBe('npm');
    expect(npmExecutable('win32')).toBe('npm.cmd');
  });

  it('isolates npm configuration and skips lifecycle scripts', () => {
    expect(auditArguments('/tmp/turnleaf-audit.npmrc')).toEqual([
      'audit',
      '--omit=dev',
      '--ignore-scripts',
      '--userconfig',
      '/tmp/turnleaf-audit.npmrc',
    ]);
  });
});
