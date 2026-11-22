// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance, type Appearance } from '../reader/appearance';

const mocks = vi.hoisted(() => {
  let openShouldFail = false;
  let capturedAppearance: Appearance | null = null;
  const preferences = new Map<string, string>();
  const writeFile = vi.fn(async () => ({ uri: 'file:///Documents/notes.md' }));

  return {
    getCapturedAppearance: () => capturedAppearance,
    preferences,
    reset() {
      openShouldFail = false;
      capturedAppearance = null;
      preferences.clear();
      writeFile.mockReset();
      writeFile.mockResolvedValue({ uri: 'file:///Documents/notes.md' });
    },
    setCapturedAppearance(next: Appearance) {
      capturedAppearance = next;
    },
    setOpenShouldFail(next: boolean) {
      openShouldFail = next;
    },
    shouldFailOpen: () => openShouldFail,
    writeFile,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Documents: 'DOCUMENTS',
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    writeFile: mocks.writeFile,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
}));

vi.mock('@capacitor/status-bar', () => ({
  Animation: { None: 'NONE' },
  StatusBar: {
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../native/keep-awake', () => ({
  KeepAwake: { setEnabled: vi.fn(async () => undefined) },
}));

vi.mock('../native/reader-chrome', () => ({
  ReaderChrome: { setEnabled: vi.fn(async () => undefined) },
}));

vi.mock('../native/volume-buttons', () => ({
  VolumeButtons: { setEnabled: vi.fn(async () => undefined) },
}));

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async (keys: readonly string[]) => {
    const out = new Map<string, string>();
    for (const key of keys) {
      const val = mocks.preferences.get(key);
      if (val !== undefined) out.set(key, val);
    }
    return out;
  }),
  setPreferences: vi.fn(async (entries: ReadonlyMap<string, string>) => {
    for (const [k, v] of entries) mocks.preferences.set(k, v);
  }),
}));

vi.mock('../reader/session', () => ({
  ReaderSession: class {
    async open(
      _viewport: HTMLElement,
      _cfi: string | null,
      _xpath: string | null,
      _pct: number | null,
      appearance: Appearance,
    ): Promise<void> {
      mocks.setCapturedAppearance(appearance);
      if (mocks.shouldFailOpen()) {
        throw new Error('Corrupt EPUB zip');
      }
    }
    tableOfContents() {
      return [];
    }
    updateHighlights() {}
    applyAppearance(next: Appearance) {
      mocks.setCapturedAppearance(next);
    }
    destroy() {}
  },
}));

import Reader from './Reader.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('Reader.svelte resilience and bookmark/note exports', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.reset();
    document.body.innerHTML = '';
    Element.prototype.animate ??= (() => {
      const anim = {
        cancel() {},
        finish() {},
        onfinish: null as (() => void) | null,
      };
      queueMicrotask(() => anim.onfinish?.());
      return anim as unknown as Animation;
    }) as typeof Element.prototype.animate;
  });

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it('falls back to defaultAppearance without throwing SyntaxError when saved appearance JSON is truncated', async () => {
    mocks.preferences.set('appearance', '{"fontSize":26,"mode":"da');

    mounted = mount(Reader, {
      target: document.body,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'primary:1:10',
        title: 'Dune',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await settle();

    expect(mocks.getCapturedAppearance()).toEqual(defaultAppearance);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('exports bookmarks from the Bookmarks panel with readonly fallback when Documents fails', async () => {
    mocks.preferences.set(
      'readerBookmarks:primary:1:10',
      JSON.stringify([
        {
          id: 'epubcfi(/6/2!/4/2)|ch1.xhtml',
          cfi: 'epubcfi(/6/2!/4/2)',
          href: 'ch1.xhtml',
          percentage: 0.4,
          label: 'Arrakis arrival',
          savedAt: '2026-03-01T00:00:00.000Z',
        },
      ]),
    );
    mocks.writeFile.mockRejectedValueOnce(new Error('Documents restricted'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    mounted = mount(Reader, {
      target: document.body,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'primary:1:10',
        title: 'Dune',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await settle();

    const revealBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Show reading controls"]',
    );
    revealBtn?.click();
    await settle();

    const bookmarksBtn = document.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-bookmarks"]',
    );
    bookmarksBtn?.click();
    await settle();

    const exportBtn = [...document.querySelectorAll('#reader-bookmarks button')].find((btn) =>
      btn.textContent?.includes('Export Markdown'),
    ) as HTMLButtonElement | undefined;
    expect(exportBtn).toBeTruthy();
    exportBtn!.click();
    await settle();

    const fallbackField = document.querySelector<HTMLTextAreaElement>(
      '#reader-bookmarks textarea[readonly]',
    );
    expect(fallbackField).toBeTruthy();
    expect(fallbackField?.value).toContain('Arrakis arrival');
  });

  it('offers bookmark and note export on the error overlay when an EPUB fails to open', async () => {
    mocks.setOpenShouldFail(true);
    mocks.preferences.set(
      'readerBookmarks:primary:1:10',
      JSON.stringify([
        {
          id: 'epubcfi(/6/2!/4/2)|ch1.xhtml',
          cfi: 'epubcfi(/6/2!/4/2)',
          href: 'ch1.xhtml',
          percentage: 0.25,
          label: 'Chapter 1',
          savedAt: '2026-03-01T00:00:00.000Z',
        },
      ]),
    );
    mocks.preferences.set(
      'readerAnnotations:primary:1:10',
      JSON.stringify([
        {
          id: 'ann-1',
          cfi: 'epubcfi(/6/4!/4/8)',
          excerpt: 'The spice must flow.',
          note: 'Key quote',
          createdAt: '2026-03-02T00:00:00.000Z',
        },
      ]),
    );
    mocks.writeFile.mockRejectedValueOnce(new Error('Documents denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    mounted = mount(Reader, {
      target: document.body,
      props: {
        bookUrl: 'blob:corrupt-book',
        bookId: 'primary:1:10',
        title: 'Dune',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This EPUB could not be opened');
    expect(alert?.textContent).toContain('Saved bookmarks or notes for this book');

    const exportMarkdownBtn = [...(alert?.querySelectorAll('button') ?? [])].find((btn) =>
      btn.textContent?.includes('Export Markdown'),
    ) as HTMLButtonElement | undefined;
    expect(exportMarkdownBtn).toBeTruthy();
    exportMarkdownBtn!.click();
    await settle();

    const fallbackField = alert?.querySelector<HTMLTextAreaElement>('textarea[readonly]');
    expect(fallbackField).toBeTruthy();
    expect(fallbackField?.value).toContain('Chapter 1');
    expect(fallbackField?.value).toContain('The spice must flow.');
  });
});
