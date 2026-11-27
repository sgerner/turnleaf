// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  TocItem,
} from '../reader/session';

vi.mock('svelte/transition', () => ({
  fade: () => ({ duration: 0 }),
  fly: () => ({ duration: 0 }),
}));

const {
  sessionInstances,
  preferencesStore,
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  destroySessionMock,
} = vi.hoisted(() => {
  type CapturedSession = {
    bookUrl: string;
    title?: string | undefined;
    onLocation:
      | ((
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget,
        ) => void)
      | null;
    onTap: ((zone: 'previous' | 'center' | 'next') => void) | null;
    displayServerLocation: ReturnType<typeof vi.fn>;
    displayServerPercentage: ReturnType<typeof vi.fn>;
    applyAppearance: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  return {
    sessionInstances: [] as CapturedSession[],
    preferencesStore: new Map<string, string>(),
    getPreferencesMock: vi.fn(),
    setPreferencesMock: vi.fn(),
    openSessionMock: vi.fn(),
    destroySessionMock: vi.fn(),
  };
});

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();

  class MockReaderSession {
    onLocation:
      | ((
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget,
        ) => void)
      | null = null;
    onTap: ((zone: 'previous' | 'center' | 'next') => void) | null = null;
    displayServerLocation = vi.fn(async () => true);
    displayServerPercentage = vi.fn(async () => true);
    applyAppearance = vi.fn();
    updateHighlights = vi.fn();
    getVisiblePassages = vi.fn(() => []);
    clearTextSelection = vi.fn();
    destroy = destroySessionMock;

    constructor(
      public readonly bookUrl: string,
      public readonly title?: string,
    ) {
      sessionInstances.push(this);
    }

    async open(
      target: HTMLElement,
      cfi: string | null,
      serverXPath: string | null,
      serverPercentage: number | null,
      appearance: unknown,
      onLocation: (
        location: ReaderLocation,
        origin: ReaderLocationOrigin,
        returnTarget?: ReaderLinkReturnTarget,
      ) => void,
      onTap: (zone: 'previous' | 'center' | 'next') => void,
    ): Promise<void> {
      this.onLocation = onLocation;
      this.onTap = onTap;
      await openSessionMock(
        target,
        cfi,
        serverXPath,
        serverPercentage,
        appearance,
        onLocation,
        onTap,
      );
    }

    tableOfContents(): TocItem[] {
      return [{ label: 'Chapter 1', href: 'chapter-1.xhtml', children: [] }];
    }
  }

  return { ...actual, ReaderSession: MockReaderSession };
});

import Reader from './Reader.svelte';
import readerSource from './Reader.svelte?raw';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionInstances.length = 0;
    getPreferencesMock.mockResolvedValue(new Map());
    setPreferencesMock.mockResolvedValue(undefined);
    openSessionMock.mockResolvedValue(undefined);
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
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenNthCalledWith(2, false);
  });

  it('still reports mount and destroy transitions when opening the EPUB fails', async () => {
    openSessionMock.mockRejectedValueOnce(new Error('corrupt epub'));
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
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;
    expect(destroySessionMock).toHaveBeenCalledOnce();
  });
});

describe('Reader accessibility, sync confirmation, and edge insets', () => {
  let host: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    sessionInstances.length = 0;
    preferencesStore.clear();
    getPreferencesMock.mockImplementation(async (keys: string[]) => {
      const result = new Map<string, string>();
      for (const key of keys) {
        const value = preferencesStore.get(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    });
    setPreferencesMock.mockImplementation(async (entries: Map<string, string>) => {
      for (const [key, value] of entries) preferencesStore.set(key, value);
    });
    openSessionMock.mockImplementation(
      async (
        _target: HTMLElement,
        _cfi: string | null,
        _serverXPath: string | null,
        _serverPercentage: number | null,
        _appearance: unknown,
        onLocation: (
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget,
        ) => void,
      ) => {
        onLocation(
          {
            cfi: 'epubcfi(/6/2!/4/2/1:0)',
            xpath: '//body/DocFragment[1]/body/p[1]',
            href: 'chapter-1.xhtml',
            percentage: 0.25,
            spineIndex: 0,
            pageIndex: 0,
            pageCount: 4,
          },
          'restore',
        );
      },
    );
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    if (component) {
      await unmount(component);
      component = null;
    }
    host.remove();
    vi.useRealTimers();
  });

  it('passes book title to ReaderSession and persists navigation relocations while skipping restore', async () => {
    const onRelocated = vi.fn();
    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Parable of the Sower',
        onBack: vi.fn(),
        onRelocated,
      },
    });
    await settle();

    const session = sessionInstances[0];
    expect(session?.title).toBe('Parable of the Sower');
    expect(onRelocated).not.toHaveBeenCalled();

    const nextLocation: ReaderLocation = {
      cfi: 'epubcfi(/6/2!/4/4/1:0)',
      xpath: '//body/DocFragment[1]/body/p[2]',
      href: 'chapter-1.xhtml',
      percentage: 0.5,
      spineIndex: 0,
      pageIndex: 1,
      pageCount: 4,
    };
    session?.onLocation?.(nextLocation, 'navigation');
    flushSync();

    expect(onRelocated).toHaveBeenCalledExactlyOnceWith(nextLocation);
  });

  it('marks background siblings inert while a modal dialog is open and clears inert before restoring focus', async () => {
    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-2',
        title: 'Kindred',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await settle();

    // Show footer details and top reading controls.
    const progressReveal = host.querySelector<HTMLButtonElement>('.reader-progress-reveal')!;
    progressReveal.click();
    flushSync();

    const showControlsBtn = host.querySelector<HTMLButtonElement>(
      '.tap-zones [aria-label="Show reading controls"]',
    )!;
    showControlsBtn.click();
    flushSync();

    const appearanceButton = host.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-appearance"]',
    )!;
    appearanceButton.focus();
    appearanceButton.click();
    flushSync();
    await tick();

    const dialog = host.querySelector<HTMLElement>('#reader-appearance')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const inertTargets = [
      host.querySelector('h1.sr-only'),
      host.querySelector('.reader-viewport'),
      host.querySelector('[aria-live="polite"]'),
      host.querySelector('#reader-keyboard-help'),
      host.querySelector('.tap-zones'),
      host.querySelector('.reader-progress'),
      host.querySelector('.reader-top'),
      host.querySelector('.reader-bottom'),
      host.querySelector('.reader-progress-reveal'),
      host.querySelector('.reader-bottom-reveal'),
    ];

    for (const element of inertTargets) {
      expect(element).not.toBeNull();
      expect((element as HTMLElement).inert).toBe(true);
    }
    expect(host.querySelector('.reader-panel-backdrop')?.getAttribute('aria-hidden')).toBe('true');

    const closeAppearance = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Close reading appearance"]',
    )!;
    closeAppearance.click();
    flushSync();
    await tick();

    for (const element of inertTargets) {
      expect((element as HTMLElement).inert).toBe(false);
    }
    expect(document.activeElement).toBe(appearanceButton);

    // Pressing Escape from another modal clears inert and restores focus to its own opener.
    const contentsButton = host.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-contents"]',
    )!;
    contentsButton.focus();
    contentsButton.click();
    flushSync();
    await tick();
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    await tick();
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(false);
    expect(document.activeElement).toBe(contentsButton);
  });

  it('mounts sync confirmation dialog even if controls auto-hid while awaiting Kavita sync', async () => {
    let resolveSync!: (value: { xpath: string | null; percentage: number | null }) => void;
    const onSyncLatest = vi.fn(
      () =>
        new Promise<{ xpath: string | null; percentage: number | null }>((resolve) => {
          resolveSync = resolve;
        }),
    );

    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-3',
        title: 'Left Hand',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await settle();

    // Reveal controls and trigger manual Sync.
    host
      .querySelector<HTMLButtonElement>('.tap-zones [aria-label="Show reading controls"]')!
      .click();
    flushSync();

    const syncButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncButton.focus();
    syncButton.click();
    flushSync();

    // Advance past the 5-second auto-hide timer before the network request finishes.
    vi.advanceTimersByTime(5_100);
    flushSync();
    expect(host.querySelector('[data-controls]')).toBeNull();

    // Resolve with a divergent Kavita position.
    resolveSync({ xpath: '//body/DocFragment[2]/body/p[4]', percentage: 0.75 });
    await settle();
    flushSync();
    await tick();

    const alertDialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(alertDialog).not.toBeNull();
    expect(alertDialog?.textContent).toContain('Move to Kavita’s latest position?');
    expect(alertDialog?.contains(document.activeElement)).toBe(true);
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(true);

    // Dismissing the dialog clears inert and restores focus to the mounted Sync button.
    const stayHere = Array.from(alertDialog!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Stay here'),
    )!;
    stayHere.click();
    flushSync();
    await tick();

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Sync latest reading position');
  });

  it('does not let panel close focus restoration steal focus from a newly opened panel', async () => {
    let resolveSync!: (value: { xpath: string | null; percentage: number | null }) => void;
    const onSyncLatest = vi.fn(
      () =>
        new Promise<{ xpath: string | null; percentage: number | null }>((resolve) => {
          resolveSync = resolve;
        }),
    );

    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-4',
        title: 'Wild Seed',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await settle();

    host
      .querySelector<HTMLButtonElement>('.tap-zones [aria-label="Show reading controls"]')!
      .click();
    flushSync();

    // Open Appearance from a synthetic click (opener === document.body so fallback selector is used).
    (document.activeElement as HTMLElement | null)?.blur();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-appearance"]')!.click();
    flushSync();
    await tick();

    const appearanceDialog = host.querySelector<HTMLElement>('#reader-appearance')!;
    expect(appearanceDialog.contains(document.activeElement)).toBe(true);

    // Close Appearance and immediately open Notes in the same turn before tick() resolves.
    appearanceDialog
      .querySelector<HTMLButtonElement>('[aria-label="Close reading appearance"]')!
      .click();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')!.click();
    flushSync();
    await tick();

    const annotationsDialog = host.querySelector<HTMLElement>('#reader-annotations')!;
    expect(annotationsDialog).not.toBeNull();
    expect(annotationsDialog.contains(document.activeElement)).toBe(true);
    expect((host.querySelector('.reader-top') as HTMLElement).inert).toBe(true);

    // Close Notes, start Sync, open Contents while Sync is in flight, then resolve divergent Sync.
    annotationsDialog
      .querySelector<HTMLButtonElement>('[aria-label="Close highlights and notes"]')!
      .click();
    flushSync();
    await tick();

    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')!.click();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-contents"]')!.click();
    flushSync();
    await tick();
    expect(host.querySelector('#reader-contents')).not.toBeNull();

    resolveSync({ xpath: '//body/DocFragment[2]/body/p[2]', percentage: 0.6 });
    await settle();
    flushSync();
    await tick();

    expect(host.querySelector('#reader-contents')).toBeNull();
    const alertDialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(alertDialog).not.toBeNull();
    expect(alertDialog.contains(document.activeElement)).toBe(true);
  });

  it('defines non-blocking edge strips and reserves 3rem plus safe-area inset at the bottom', () => {
    expect(readerSource).toMatch(
      /--reader-safe-bottom:\s*calc\(\s*3rem\s*\+\s*max\(env\(safe-area-inset-bottom,\s*0px\),\s*var\(--safe-area-inset-bottom,\s*0px\)\)\s*\)/,
    );
    expect(readerSource).toMatch(
      /\.reader-top-reveal\s*\{[^}]*height:\s*var\(--reader-safe-top\);[^}]*pointer-events:\s*none;/s,
    );
    expect(readerSource).toMatch(
      /\.reader-bottom-reveal\s*\{[^}]*height:\s*var\(--reader-safe-bottom\);/s,
    );
  });
});
