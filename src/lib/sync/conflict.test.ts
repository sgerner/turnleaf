import { describe, expect, it } from 'vitest';
import {
  chooseOpenProgress,
  chooseFurthestProgress,
  compareKavitaLocations,
  shouldPreferFurthest,
  toKavitaPageNumber,
} from './conflict';

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

  it('orders precise Kavita EPUB paths within the same fragment', () => {
    expect(
      compareKavitaLocations(
        '//body/DocFragment[9]/body/section[1]/p[165]/span[1]',
        '//body/DocFragment[9]/body/section[1]/p[165]/span[14]',
      ),
    ).toBe('remote');
  });

  it('orders Kavita EPUB paths by fragment before content position', () => {
    expect(
      compareKavitaLocations(
        '//body/DocFragment[10]/body/section[1]/p[1]',
        '//body/DocFragment[9]/body/section[1]/p[999]',
      ),
    ).toBe('local');
  });

  it('orders canonical chapter-scoped Kavita paths by zero-based chapter first and element steps second', () => {
    expect(compareKavitaLocations('//body/section[1]/p[99]', '//body/section[1]/p[1]', 0, 1)).toBe(
      'remote',
    );
    expect(compareKavitaLocations('//body/section[1]/p[1]', '//body/section[1]/p[99]', 2, 1)).toBe(
      'local',
    );
    expect(
      compareKavitaLocations(
        '//body/section[1]/p[12]/span[1]',
        '//body/section[1]/p[12]/span[9]',
        0,
        0,
      ),
    ).toBe('remote');
  });

  it('orders ID-anchored locators across different chapters but returns unknown within the same chapter', () => {
    expect(compareKavitaLocations('//body/p[10]', 'id("chapter-two-note")/p[1]', 0, 1)).toBe(
      'remote',
    );
    expect(compareKavitaLocations('id("chapter-three")', '//body/p[99]', 2, 1)).toBe('local');
    expect(compareKavitaLocations('//body/p[2]', 'id("chapter-one-note")/p[9]', 0, 0)).toBe(
      'unknown',
    );
  });
});

describe('reader open progress selection', () => {
  const local = {
    pageNum: 0,
    percentage: 0.25,
    pendingSync: false,
    xpath: '//body/p[1]',
  };
  const remote = {
    pageNum: 1,
    bookScrollId: '//body/p[4]',
  };

  it('preserves the synced local passage when automatic selection is off', () => {
    expect(chooseOpenProgress(local, remote, 100, false)).toBe('local');
  });

  it('keeps the exact local CFI when Kavita points to the same saved chapter and XPath', () => {
    expect(
      chooseOpenProgress(
        {
          ...local,
          cfi: 'epubcfi(/6/4!/4/2/1:12)',
          pageNum: 1,
          xpath: remote.bookScrollId,
        },
        remote,
        100,
        true,
      ),
    ).toBe('local');
  });

  it('distinguishes identical chapter-scoped XPaths across different zero-based chapters', () => {
    expect(
      chooseOpenProgress(
        {
          ...local,
          cfi: 'epubcfi(/6/2!/4/8)',
          pageNum: 0,
          xpath: '//body/p[4]',
        },
        {
          pageNum: 2,
          bookScrollId: '//body/p[4]',
        },
        100,
        true,
      ),
    ).toBe('remote');
    expect(
      chooseOpenProgress(
        {
          ...local,
          pageNum: 0,
          pendingSync: true,
          xpath: '//body/p[4]',
        },
        {
          pageNum: 2,
          bookScrollId: '//body/p[4]',
        },
        100,
        false,
      ),
    ).toBe('conflict');
  });

  it('treats remote chapter-zero scroll locators as active progress when local state is empty', () => {
    expect(chooseOpenProgress(null, { pageNum: 0, bookScrollId: '//body/p[3]' }, 10, false)).toBe(
      'remote',
    );
    expect(chooseOpenProgress(null, { pageNum: 0, bookScrollId: null }, 10, false)).toBe('none');
  });

  it('uses zero-based Kavita page progress when no XPath was saved', () => {
    expect(chooseOpenProgress(null, { pageNum: 1 }, 2, false)).toBe('remote');
    expect(chooseOpenProgress(local, { pageNum: 40 }, 100, false)).toBe('local');
    expect(
      chooseOpenProgress({ ...local, percentage: 0.6, xpath: null }, { pageNum: 1 }, 2, true),
    ).toBe('local');
    expect(
      chooseOpenProgress({ ...local, percentage: 0.4, xpath: null }, { pageNum: 1 }, 2, true),
    ).toBe('remote');
  });

  it('uses furthest progress when requested', () => {
    expect(chooseOpenProgress({ ...local, percentage: 0.9, xpath: null }, remote, 100, true)).toBe(
      'local',
    );
    expect(chooseOpenProgress(local, remote, 100, true)).toBe('remote');
  });

  it('uses precise Kavita paths instead of incomparable percentages', () => {
    expect(
      chooseOpenProgress(
        {
          ...local,
          pageNum: 1,
          percentage: 0.95,
          xpath: '//body/section[1]/p[1]',
        },
        {
          pageNum: 1,
          bookScrollId: '//body/section[1]/p[20]',
        },
        100,
        true,
      ),
    ).toBe('remote');
  });

  it('keeps the local position when mixed tags or ID anchors prevent ordering same-chapter elements', () => {
    expect(
      chooseOpenProgress({ ...local, pageNum: 1, xpath: '//body/h2[1]' }, remote, 100, true),
    ).toBe('local');
    expect(
      chooseOpenProgress(
        { ...local, pageNum: 1, xpath: '//body/p[2]' },
        { pageNum: 1, bookScrollId: 'id("section-anchor")/p[9]' },
        100,
        true,
      ),
    ).toBe('local');
  });

  it('reconciles legacy DocFragment locators cleanly with canonical zero-based remote locators', () => {
    expect(
      chooseOpenProgress(
        {
          ...local,
          pageNum: null,
          xpath: '//body/DocFragment[2]/body/p[4]',
        },
        {
          pageNum: 1,
          bookScrollId: '//body/p[4]',
        },
        100,
        true,
      ),
    ).toBe('local');
    expect(
      chooseOpenProgress(
        {
          ...local,
          pageNum: null,
          xpath: '//body/DocFragment[2]/body/p[4]',
        },
        {
          pageNum: 1,
          bookScrollId: '//body/p[9]',
        },
        100,
        true,
      ),
    ).toBe('remote');
  });

  it('prefers remote completion even when it has an older locator', () => {
    expect(chooseOpenProgress(local, { ...remote, pageNum: 100 }, 100, true)).toBe('remote');
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

  it('maps percentage progress to zero-based Kavita chapter indices', () => {
    expect(toKavitaPageNumber(0, 16)).toBe(0);
    expect(toKavitaPageNumber(0.56, 16)).toBe(8);
    expect(toKavitaPageNumber(1 / 49, 49)).toBe(1);
  });

  it('encodes the active EPUB spine chapter directly as zero-based pageNum', () => {
    expect(toKavitaPageNumber(0.25, 16, 0)).toBe(0);
    expect(toKavitaPageNumber(0.94, 16, 8)).toBe(8);
    expect(toKavitaPageNumber(0.1, 16, 15)).toBe(15);
  });
});
