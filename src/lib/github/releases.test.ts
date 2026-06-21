import { describe, expect, it } from 'vitest';
import { compareVersions } from './releases';

describe('compareVersions', () => {
  it('orders patch and minor versions', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
  });

  it('treats stable releases as newer than prereleases', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });

  it('treats build metadata as increasing release builds for Turnleaf', () => {
    expect(compareVersions('0.1.3+124', '0.1.3+123')).toBeGreaterThan(0);
    expect(compareVersions('0.1.3+1', '0.1.3')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});
