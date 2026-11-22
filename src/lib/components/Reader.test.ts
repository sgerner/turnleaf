// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance, type Appearance } from '../reader/appearance';

const mocks = vi.hoisted(() => {
  let openShouldFail = false;
  let capturedAppearance: Appearance | null = null;
  let isNative = false;
  const preferences = new Map<string, string>();
  const writeFile = vi.fn(async () => ({ uri: 'file:///Documents/notes.md' }));
  const getPreferencesMock = vi.fn(async (keys: readonly string[]) => {
    const out = new Map<string, string>();
    for (const key of keys) {
      const val = preferences.get(key);
      if (val !== undefined) out.set(key, val);
    }
    return out;
  });
  const setPreferencesMock = vi.fn(async (entries: ReadonlyMap<string, string>) => {
    for (const [k, v] of entries) preferences.set(k, v);
  });
  const openSessionMock = vi.fn(
    async (
      _viewport: HTMLElement,
      _cfi: string | null,
      _xpath: string | null,
      _pct: number | null,
      appearance: Appearance,
    ) => {
      capturedAppearance = appearance;
      if (openShouldFail) {
        throw new Error('Corrupt EPUB zip');
      }
    },
  );
  const destroySessionMock = vi.fn();

  return {
    destroySessionMock,
    getCapturedAppearance: () => capturedAppearance,
    getPreferencesMock,
    isNative: () => isNative,
    openSessionMock,
    preferences,
    reset(nativePlatform: boolean) {
      isNative = nativePlatform;
      openShouldFail = false;
      capturedAppearance = null;
      preferences.clear();
      writeFile.mockReset();
      writeFile.mockResolvedValue({ uri: 'file:///Documents/notes.md' });
      getPreferencesMock.mockClear();
      setPreferencesMock.mockClear();
      openSessionMock.mockReset();
      openSessionMock.mockImplementation(
        async (
          _viewport: HTMLElement,
          _cfi: string | null,
          _xpath: string | null,
          _pct: number | null,
          appearance: Appearance,
        ) => {
          capturedAppearance = appearance;
          if (openShouldFail) {
            throw new Error('Corrupt EPUB zip');
          }
        },
      );
      destroySessionMock.mockClear();
    },
    setCapturedAppearance(next: Appearance) {
      capturedAppearance = next;
    },
    setOpenShouldFail(next: boolean) {
      openShouldFail = next;
    },
    setPreferencesMock,
    writeFile,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => (mocks.isNative() ? 'android' : 'web'),
    isNativePlatform: () => mocks.isNative(),
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
  getPreferences: mocks.getPreferencesMock,
  setPreferences: mocks.setPreferencesMock,
}));

vi.mock('../reader/session', () => ({
  ReaderSession: class MockReaderSession {
    open = mocks.openSessionMock;
    tableOfContents = () => [];
    updateHighlights = vi.fn();
    applyAppearance(next: Appearance) {
      mocks.setCapturedAppearance(next);
    }
    destroy = mocks.destroySessionMock;
  },
}));

import Reader from './Reader.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    mocks.reset(false);
    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
  });

  it('reports true on mount and false on destroy through onMountChange', async () => {
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(target.querySelector('.reader-shell')).not.toBeNull();
    expect(onMountChange).toHaveBeenCalledTimes(1);
    expect(onMountChange).toHaveBeenNthCalledWith(1, true);

    await vi.waitFor(() => {
      expect(mocks.openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenNthCalledWith(2, false);
  });

  it('still reports mount and destroy transitions when opening the EPUB fails', async () => {
    mocks.openSessionMock.mockRejectedValueOnce(new Error('corrupt epub'));
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:broken-book',
        bookId: 'book-2',
        title: 'Broken Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(onMountChange).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'This EPUB could not be opened.',
      );
    });
    expect(onMountChange).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenLastCalledWith(false);
  });

  it('mounts and unmounts cleanly when onMountChange is omitted', async () => {
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:optional-book',
        bookId: 'book-3',
        title: 'Optional Callback Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(mocks.openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;
    expect(mocks.destroySessionMock).toHaveBeenCalledOnce();
  });
});

describe('Reader.svelte resilience and bookmark/note exports', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.reset(true);
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
