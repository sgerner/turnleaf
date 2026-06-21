import { describe, expect, it } from 'vitest';
import { chooseFurthestProgress, detectProgressConflict, type ProgressSnapshot } from './conflict';
import { coalesceSyncItem } from './queue';

const snapshot = (xpath: string, percentage: number): ProgressSnapshot => ({
  cfi: null,
  xpath,
  percentage,
  updatedAt: '2026-06-20T00:00:00Z',
});

describe('progress reconciliation', () => {
  it('detects changes on both sides without choosing the furthest point', () => {
    const shared = snapshot('/p[1]', 0.2);
    const decision = detectProgressConflict(
      snapshot('/p[2]', 0.25),
      snapshot('/p[8]', 0.8),
      shared,
    );
    expect(decision.kind).toBe('conflict');
  });

  it('accepts a server-only change', () => {
    const shared = snapshot('/p[1]', 0.2);
    expect(detectProgressConflict(shared, snapshot('/p[2]', 0.3), shared)).toEqual({
      kind: 'server',
    });
  });
});

describe('sync queue coalescing', () => {
  it('replaces payload while preserving creation and retry state', () => {
    const first = coalesceSyncItem(null, 'book-1', { page: 2 }, 'one');
    first.attemptCount = 3;
    expect(coalesceSyncItem(first, 'book-1', { page: 9 }, 'two')).toEqual({
      bookId: 'book-1',
      payload: { page: 9 },
      attemptCount: 3,
      createdAt: 'one',
      updatedAt: 'two',
    });
  });
});

describe('furthest progress selection', () => {
  it('prefers the greater percentage and keeps ties local', () => {
    expect(chooseFurthestProgress(0.2, 0.8)).toBe('remote');
    expect(chooseFurthestProgress(0.8, 0.2)).toBe('local');
    expect(chooseFurthestProgress(0.4, 0.4)).toBe('local');
  });
});
