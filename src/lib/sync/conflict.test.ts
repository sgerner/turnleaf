import { describe, expect, it } from 'vitest';
import {
  chooseOpenProgress,
  chooseFurthestProgress,
  detectProgressConflict,
  shouldPreferFurthest,
  toKavitaPageNumber,
  type ProgressSnapshot,
} from './conflict';
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

  it('keeps automatic furthest selection authoritative for every open', () => {
    expect(shouldPreferFurthest(true, false)).toBe(true);
    expect(shouldPreferFurthest(true)).toBe(true);
  });

  it('supports a one-time manual request when automatic selection is disabled', () => {
    expect(shouldPreferFurthest(false, true)).toBe(true);
    expect(shouldPreferFurthest(false)).toBe(false);
  });
});

describe('reader open progress selection', () => {
  const local = {
    percentage: 0.25,
    pendingSync: false,
    xpath: '//body/DocFragment[1]/body/p[1]',
  };
  const remote = {
    pageNum: 80,
    bookScrollId: '//body/DocFragment[2]/body/p[4]',
  };

  it('uses Kavita progress when local state has already synced', () => {
    expect(chooseOpenProgress(local, remote, 100, false)).toBe('remote');
  });

  it('uses Kavita page progress when no XPath was saved', () => {
    expect(chooseOpenProgress(null, { pageNum: 40 }, 100, false)).toBe('remote');
    expect(chooseOpenProgress(local, { pageNum: 40 }, 100, false)).toBe('remote');
  });

  it('uses furthest progress when requested', () => {
    expect(chooseOpenProgress({ ...local, percentage: 0.9 }, remote, 100, true)).toBe('local');
    expect(chooseOpenProgress(local, remote, 100, true)).toBe('remote');
  });

  it('does not silently discard pending local progress', () => {
    expect(chooseOpenProgress({ ...local, pendingSync: true }, remote, 100, false)).toBe(
      'conflict',
    );
  });
});

describe('Kavita page updates', () => {
  it('does not mark ordinary reader navigation as completed', () => {
    expect(toKavitaPageNumber(0.999, 16)).toBe(15);
    expect(toKavitaPageNumber(1, 16)).toBe(15);
  });

  it('keeps normal reading progress near the reported page', () => {
    expect(toKavitaPageNumber(0, 16)).toBe(0);
    expect(toKavitaPageNumber(0.56, 16)).toBe(9);
  });

  it('uses the EPUB spine for Kavita page progress when available', () => {
    expect(toKavitaPageNumber(0.94, 16, 8)).toBe(9);
    expect(toKavitaPageNumber(0.1, 16, 15)).toBe(15);
  });
});
