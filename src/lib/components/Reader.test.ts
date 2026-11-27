// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderSelection,
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
    onSelection: ((selection: ReaderSelection | null) => void) | null;
    onKeyboardNavigation: ((event: KeyboardEvent) => void) | null;
    displayCfi: ReturnType<typeof vi.fn>;
    display: ReturnType<typeof vi.fn>;
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
    onSelection: ((selection: ReaderSelection | null) => void) | null = null;
    onKeyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
    next = vi.fn(async () => {});
    previous = vi.fn(async () => {});
    displayCfi = vi.fn(async () => true);
    display = vi.fn(async () => {});
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
      onSelection?: (selection: ReaderSelection | null) => void,
      onKeyboardNavigation?: (event: KeyboardEvent) => void,
    ): Promise<void> {
      this.onLocation = onLocation;
      this.onTap = onTap;
      this.onSelection = onSelection ?? null;
      this.onKeyboardNavigation = onKeyboardNavigation ?? null;
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
    if (typeof Element.prototype.animate !== 'function') {
      Element.prototype.animate = (() => {
        const anim = {
          currentTime: 0,
          playState: 'running',
          effect: null,
          onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
          cancel() {
            anim.playState = 'idle';
          },
          finish() {
            anim.playState = 'finished';
          },
        };
        queueMicrotask(() => {
          if (anim.playState !== 'idle') {
            anim.playState = 'finished';
            anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
          }
        });
        return anim as unknown as Animation;
      }) as typeof Element.prototype.animate;
    }
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
      expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain(
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

    const shell = host.querySelector<HTMLElement>('.reader-shell')!;
    expect(shell.getAttribute('aria-describedby')).toBeNull();

    const inertTargets = [
      host.querySelector('h1.sr-only'),
      host.querySelector('.reader-viewport'),
      host.querySelector('p[role="status"]'),
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

    expect(shell.getAttribute('aria-describedby')).toBe('reader-keyboard-help');
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

  it('does not let panel close focus restoration steal focus and keeps sync alert inert behind runtime error', async () => {
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
    expect(annotationsDialog.contains(document.activeElement)).toBe(true);
    expect((host.querySelector('.reader-top') as HTMLElement).inert).toBe(true);

    annotationsDialog
      .querySelector<HTMLButtonElement>('[aria-label="Close highlights and notes"]')!
      .click();
    flushSync();
    await tick();

    // Start Sync, trigger a page-turn runtime error while Sync is in flight, then resolve divergent Sync.
    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')!.click();
    flushSync();

    const session = sessionInstances[0]! as unknown as {
      next: ReturnType<typeof vi.fn>;
    };
    session.next.mockRejectedValueOnce(new Error('Chapter unavailable.'));
    host.querySelector<HTMLButtonElement>('.tap-zones [aria-label="Next page"]')!.click();
    await settle();
    flushSync();
    await tick();

    resolveSync({ xpath: '//body/DocFragment[2]/body/p[2]', percentage: 0.6 });
    await settle();
    flushSync();
    await tick();

    const dialogs = host.querySelectorAll<HTMLElement>('[role="alertdialog"]');
    expect(dialogs).toHaveLength(2);
    expect((dialogs[0]!.parentElement as HTMLElement).inert).toBe(true);
    expect(dialogs[1]!.contains(document.activeElement)).toBe(true);

    // Dismissing the runtime error un-inerts and focuses the pending sync confirmation dialog.
    Array.from(dialogs[1]!.querySelectorAll('button'))
      .find((btn) => btn.textContent?.trim() === 'Dismiss')!
      .click();
    flushSync();
    await tick();

    const remainingDialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect((remainingDialog.parentElement as HTMLElement).inert).toBe(false);
    expect(remainingDialog.contains(document.activeElement)).toBe(true);
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

  it('keeps one ordered Back handler chain so panels, link returns, footer, and controls close before exiting', async () => {
    const onBack = vi.fn();
    let backHandler: (() => boolean) | null = null;
    const unregisterBack = vi.fn(() => {
      backHandler = null;
    });
    const registerBackHandler = vi.fn((handler: () => boolean) => {
      backHandler = handler;
      return unregisterBack;
    });

    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-back',
        title: 'Imago',
        onBack,
        onRelocated: vi.fn(),
        onSyncLatest: vi.fn(async () => ({
          xpath: '//body/DocFragment[2]/body/p[3]',
          percentage: 0.8,
        })),
        registerBackHandler,
      },
    });
    await settle();

    expect(registerBackHandler).toHaveBeenCalledOnce();
    expect(backHandler).toBeTypeOf('function');

    host
      .querySelector<HTMLButtonElement>('.tap-zones [aria-label="Show reading controls"]')!
      .click();
    flushSync();

    // 1. Sync confirmation dialog closes on Back without exiting reader.
    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')!.click();
    await settle();
    flushSync();
    await tick();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();

    expect(backHandler!()).toBe(true);
    flushSync();
    await tick();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(false);
    expect(onBack).not.toHaveBeenCalled();

    // 2. Reader modal panel closes on Back before controls or reader exit.
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-appearance"]')!.click();
    flushSync();
    await tick();
    expect(host.querySelector('#reader-appearance')).not.toBeNull();

    expect(backHandler!()).toBe(true);
    flushSync();
    await tick();
    expect(host.querySelector('#reader-appearance')).toBeNull();
    expect((host.querySelector('.reader-viewport') as HTMLElement).inert).toBe(false);
    expect(host.querySelector('[data-controls]')).not.toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    // 3. Link return target returns to origin location before hiding controls or exiting.
    const session = sessionInstances[0]!;
    session.onLocation?.(
      {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        xpath: '//body/DocFragment[2]/body/p[1]',
        href: 'chapter-2.xhtml',
        percentage: 0.75,
        spineIndex: 1,
        pageIndex: 0,
        pageCount: 2,
      },
      'link',
      { cfi: 'epubcfi(/6/2!/4/2/1:0)', href: 'chapter-1.xhtml' },
    );
    flushSync();

    expect(backHandler!()).toBe(true);
    await settle();
    flushSync();
    expect(session.displayCfi).toHaveBeenCalledWith('epubcfi(/6/2!/4/2/1:0)');
    expect(onBack).not.toHaveBeenCalled();

    // 4. Visible controls hide on Back before reader exits; footer-only also hides before reader exits.
    expect(host.querySelector('[data-controls]')).not.toBeNull();
    expect(backHandler!()).toBe(true);
    flushSync();
    expect(host.querySelector('[data-controls]')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>('.reader-progress-reveal')!.click();
    flushSync();
    expect(host.querySelector('.reader-bottom')).not.toBeNull();
    expect(backHandler!()).toBe(true);
    flushSync();
    expect(host.querySelector('.reader-bottom')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    // 5. With panels closed, no link return target, and controls/footer hidden, Back exits reader.
    expect(backHandler!()).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();

    await unmount(component);
    component = null;
    expect(unregisterBack).toHaveBeenCalledOnce();
  });
});
