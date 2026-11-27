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

  it('preserves the synced local passage when automatic selection is off', () => {
    expect(chooseOpenProgress(local, remote, 100, false)).toBe('local');
  });

  it('keeps the exact local CFI when Kavita points to the same saved XPath', () => {
    expect(
      chooseOpenProgress(
        { ...local, cfi: 'epubcfi(/6/4!/4/2/1:12)', xpath: remote.bookScrollId },
        remote,
        100,
        false,
      ),
    ).toBe('local');
  });

  it('uses Kavita page progress when no XPath was saved', () => {
    expect(chooseOpenProgress(null, { pageNum: 40 }, 100, false)).toBe('remote');
    expect(chooseOpenProgress(local, { pageNum: 40 }, 100, false)).toBe('local');
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
          percentage: 0.95,
          xpath: '//body/DocFragment[2]/body/section[1]/p[1]',
        },
        {
          pageNum: 2,
          bookScrollId: '//body/DocFragment[2]/body/section[1]/p[20]',
        },
        100,
        true,
      ),
    ).toBe('remote');
  });

  it('keeps the local position when mixed tags prevent ordering sibling elements', () => {
    expect(
      chooseOpenProgress(
        { ...local, xpath: '//body/DocFragment[2]/body/h2[1]' },
        remote,
        100,
        true,
      ),
    ).toBe('local');
  });

  it('prefers remote completion even when it has an older locator', () => {
    expect(chooseOpenProgress(local, { ...remote, pageNum: 100 }, 100, true)).toBe('remote');
  });

  it('does not silently discard pending local progress', () => {
    expect(chooseOpenProgress({ ...local, pendingSync: true }, remote, 100, false)).toBe(
      'conflict',
    );
  });

  it('keeps pending local progress when Kavita still holds the synced baseline', () => {
    const advancedLocal = {
      cfi: 'epubcfi(/6/6!/4/2/1:8)',
      percentage: 0.45,
      pendingSync: true,
      xpath: '//body/DocFragment[3]/body/p[2]',
      serverPageNum: 25,
      serverXPath: '//body/DocFragment[1]/body/p[1]',
    };
    expect(
      chooseOpenProgress(
        advancedLocal,
        { pageNum: 25, bookScrollId: '//body/DocFragment[1]/body/p[1]' },
        100,
        false,
      ),
    ).toBe('local');
    expect(
      chooseOpenProgress(
        advancedLocal,
        { pageNum: 25, bookScrollId: '//body/DocFragment[1]/body/p[1]' },
        100,
        true,
      ),
    ).toBe('local');
  });

  it('keeps never-synced local progress when Kavita is still unread', () => {
    expect(
      chooseOpenProgress(
        {
          cfi: 'epubcfi(/6/4!/4/2/1:4)',
          percentage: 0.15,
          pendingSync: true,
          xpath: '//body/DocFragment[1]/body/p[6]',
          serverPageNum: null,
          serverXPath: null,
        },
        { pageNum: 0, bookScrollId: null },
        100,
        false,
      ),
    ).toBe('local');
  });

  it('flags a conflict when both local and Kavita moved from the shared baseline', () => {
    const advancedLocal = {
      cfi: 'epubcfi(/6/6!/4/2/1:8)',
      percentage: 0.45,
      pendingSync: true,
      xpath: '//body/DocFragment[3]/body/p[2]',
      serverPageNum: 25,
      serverXPath: '//body/DocFragment[1]/body/p[1]',
    };
    expect(
      chooseOpenProgress(
        advancedLocal,
        { pageNum: 80, bookScrollId: '//body/DocFragment[5]/body/p[9]' },
        100,
        true,
      ),
    ).toBe('conflict');
  });

  it('adopts an earlier chapter re-read or unread reset on Kavita when local state has no pending sync', () => {
    const syncedLocal = {
      cfi: 'epubcfi(/6/10!/4/2/1:0)',
      percentage: 0.8,
      pendingSync: false,
      xpath: '//body/DocFragment[5]/body/p[4]',
      serverPageNum: 80,
      serverXPath: '//body/DocFragment[5]/body/p[4]',
    };
    const earlierChapter = {
      pageNum: 12,
      bookScrollId: '//body/DocFragment[1]/body/p[3]',
    };
    expect(chooseOpenProgress(syncedLocal, earlierChapter, 100, true)).toBe('remote');
    expect(chooseOpenProgress(syncedLocal, earlierChapter, 100, false)).toBe('remote');
    expect(chooseOpenProgress(syncedLocal, { pageNum: 0, bookScrollId: null }, 100, true)).toBe(
      'remote',
    );
  });

  it('flags a conflict when pending local progress shares the chapter XPath but Kavita pageNum moved forward or backward from baseline', () => {
    const chapterXPath = '//body/DocFragment[2]/body/section[1]';
    const pendingSameChapter = {
      cfi: 'epubcfi(/6/6!/4/2/8:0)',
      percentage: 0.35,
      pendingSync: true,
      xpath: chapterXPath,
      serverPageNum: 25,
      serverXPath: chapterXPath,
    };
    expect(
      chooseOpenProgress(
        pendingSameChapter,
        { pageNum: 42, bookScrollId: chapterXPath },
        100,
        false,
      ),
    ).toBe('conflict');
    expect(
      chooseOpenProgress(
        pendingSameChapter,
        { pageNum: 12, bookScrollId: chapterXPath },
        100,
        true,
      ),
    ).toBe('conflict');
  });

  it('adopts same-chapter Kavita pageNum changes including backward moves when local state is not pending', () => {
    const chapterXPath = '//body/DocFragment[2]/body/section[1]';
    const syncedSameChapter = {
      cfi: 'epubcfi(/6/6!/4/2/12:0)',
      percentage: 0.4,
      pendingSync: false,
      xpath: chapterXPath,
      serverPageNum: 40,
      serverXPath: chapterXPath,
    };
    expect(
      chooseOpenProgress(
        syncedSameChapter,
        { pageNum: 55, bookScrollId: chapterXPath },
        100,
        false,
      ),
    ).toBe('remote');
    expect(
      chooseOpenProgress(syncedSameChapter, { pageNum: 55, bookScrollId: chapterXPath }, 100, true),
    ).toBe('remote');
    expect(
      chooseOpenProgress(
        syncedSameChapter,
        { pageNum: 15, bookScrollId: chapterXPath },
        100,
        false,
      ),
    ).toBe('remote');
    expect(
      chooseOpenProgress(syncedSameChapter, { pageNum: 15, bookScrollId: chapterXPath }, 100, true),
    ).toBe('remote');
  });

  it('returns local when reopening a completed remote book that matches the stored baseline', () => {
    const completedLocal = {
      cfi: '',
      percentage: 1,
      pendingSync: false,
      xpath: '//body/DocFragment[2]/body/p[4]',
      serverPageNum: 100,
      serverXPath: '//body/DocFragment[2]/body/p[4]',
    };
    expect(
      chooseOpenProgress(
        completedLocal,
        { pageNum: 100, bookScrollId: '//body/DocFragment[2]/body/p[4]' },
        100,
        true,
      ),
    ).toBe('local');
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
