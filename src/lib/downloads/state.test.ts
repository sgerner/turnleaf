import { describe, expect, it } from 'vitest';
import { nextDownloadStatus } from './state';

describe('download state', () => {
  it('only marks an active download available after completion', () => {
    expect(nextDownloadStatus('none', 'start')).toBe('downloading');
    expect(nextDownloadStatus('downloading', 'complete')).toBe('available');
    expect(() => nextDownloadStatus('none', 'complete')).toThrow();
  });

  it('treats a missing native file as unavailable', () => {
    expect(nextDownloadStatus('available', 'missing')).toBe('none');
  });
});
