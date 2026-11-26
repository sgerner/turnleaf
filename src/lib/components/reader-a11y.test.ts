// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}));

vi.mock('@capacitor/status-bar', () => ({
  Animation: { None: 'NONE' },
  StatusBar: {
    hide: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
  },
}));

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async () => new Map()),
  setPreferences: vi.fn(async () => {}),
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      async open(
        viewport: HTMLElement,
        _initialCfi: string | null,
        _initialXPath: string | null,
        _initialPercentage: number | null,
        _appearance: unknown,
        onLocation: (
          loc: {
            cfi: string;
            href: string;
            xpath: string | null;
            percentage: number;
            spineIndex: number;
            pageIndex: number;
            pageCount: number;
          },
          origin: 'restore' | 'navigation' | 'link',
        ) => void,
      ): Promise<void> {
        const container = document.createElement('div');
        container.className = 'epub-container';
        const iframe = document.createElement('iframe');
        container.append(iframe);
        viewport.append(container);
        onLocation(
          {
            cfi: 'epubcfi(/6/2!/4/2:0)',
            href: 'chapter-1.xhtml',
            xpath: '/body/p[1]',
            percentage: 0.25,
            spineIndex: 0,
            pageIndex: 0,
            pageCount: 4,
          },
          'restore',
        );
      }

      tableOfContents() {
        return [{ label: 'Chapter 1', href: 'chapter-1.xhtml', children: [] }];
      }

      getVisiblePassages() {
        return [];
      }

      clearTextSelection(): void {}
      updateHighlights(): void {}
      applyAppearance(): void {}
      async display(): Promise<boolean> {
        return true;
      }
      async displayCfi(): Promise<boolean> {
        return true;
      }
      async displayServerLocation(): Promise<boolean> {
        return true;
      }
      async displayServerPercentage(): Promise<void> {}
      async next(): Promise<void> {}
      async previous(): Promise<void> {}
      async search() {
        return [];
      }
      destroy(): void {}
    },
  };
});

import Reader from './Reader.svelte';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: () => {},
      finish: () => animation.onfinish?.(),
      play: () => {},
      pause: () => {},
      reverse: () => {},
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

describe('Reader modal isolation and focus restoration across all six panels', () => {
  let mountedComponent: Record<string, unknown> | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    if (mountedComponent) {
      await unmount(mountedComponent);
      mountedComponent = null;
    }
    document.body.innerHTML = '';
  });

  it('isolates releaseBanner, viewport, iframe, progress bar, backdrop, footer, and progress-reveal for all six reader modals and restores opener focus on every close path', async () => {
    const stage = document.createElement('div');
    stage.className = 'app-stage';
    const releaseBanner = document.createElement('div');
    releaseBanner.setAttribute('data-release-banner', '');
    const bannerButton = document.createElement('button');
    bannerButton.textContent = 'Dismiss';
    releaseBanner.append(bannerButton);
    stage.append(releaseBanner);
    document.body.append(stage);

    const backState: { handler: (() => boolean) | null } = { handler: null };

    mountedComponent = mount(Reader, {
      target: stage,
      props: {
        bookUrl: 'blob:test-epub',
        bookId: 'book-1',
        title: 'Test EPUB',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest: vi.fn(async () => ({
          xpath: '/body/p[12]',
          percentage: 0.75,
          accept: async () => {},
        })),
        registerBackHandler: (handler) => {
          backState.handler = handler;
          return () => {
            if (backState.handler === handler) backState.handler = null;
          };
        },
      },
    });
    await settle();

    // Reveal controls and footer so every reader chrome element is mounted simultaneously.
    stage.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await settle();
    stage.querySelector<HTMLButtonElement>('.reader-progress-reveal')!.click();
    await settle();

    const viewport = stage.querySelector<HTMLElement>('.reader-viewport')!;
    const epubFrame = viewport.querySelector<HTMLIFrameElement>('iframe')!;
    const progress = stage.querySelector<HTMLElement>('.reader-progress')!;
    const footer = stage.querySelector<HTMLElement>('footer')!;
    const progressReveal = stage.querySelector<HTMLElement>('.reader-progress-reveal')!;
    const tapZones = stage.querySelector<HTMLElement>('.tap-zones')!;
    const toolbar = stage.querySelector<HTMLElement>('.reader-bar.reader-top')!;

    expect(viewport).not.toBeNull();
    expect(epubFrame).not.toBeNull();
    expect(progress).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(progressReveal).not.toBeNull();

    const assertBackgroundIsolated = () => {
      expect(releaseBanner.hasAttribute('inert')).toBe(true);
      expect(releaseBanner.getAttribute('aria-hidden')).toBe('true');
      expect(viewport.hasAttribute('inert')).toBe(true);
      expect(viewport.getAttribute('aria-hidden')).toBe('true');
      expect(epubFrame.hasAttribute('inert')).toBe(true);
      expect(epubFrame.getAttribute('aria-hidden')).toBe('true');
      expect(epubFrame.getAttribute('tabindex')).toBe('-1');
      expect(progress.hasAttribute('inert')).toBe(true);
      expect(progress.getAttribute('aria-hidden')).toBe('true');
      expect(footer.hasAttribute('inert')).toBe(true);
      expect(footer.getAttribute('aria-hidden')).toBe('true');
      expect(progressReveal.hasAttribute('inert')).toBe(true);
      expect(progressReveal.getAttribute('aria-hidden')).toBe('true');
      expect(tapZones.hasAttribute('inert')).toBe(true);
      expect(toolbar.hasAttribute('inert')).toBe(true);

      const backdrop = stage.querySelector<HTMLElement>('.reader-panel-backdrop');
      expect(backdrop).not.toBeNull();
      expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
      expect(backdrop?.tagName).toBe('DIV');
    };

    const assertBackgroundReleased = () => {
      expect(releaseBanner.hasAttribute('inert')).toBe(false);
      expect(viewport.hasAttribute('inert')).toBe(false);
      expect(epubFrame.hasAttribute('inert')).toBe(false);
      expect(epubFrame.hasAttribute('tabindex')).toBe(false);
      expect(progress.hasAttribute('inert')).toBe(false);
      expect(footer.hasAttribute('inert')).toBe(false);
      expect(progressReveal.hasAttribute('inert')).toBe(false);
      expect(tapZones.hasAttribute('inert')).toBe(false);
      expect(toolbar.hasAttribute('inert')).toBe(false);
    };

    const panelSpecs = [
      {
        openerSelector: '[aria-controls="reader-contents"]',
        panelSelector: '#reader-contents',
        closeSelector: '[aria-label="Close table of contents"]',
      },
      {
        openerSelector: '[aria-controls="reader-appearance"]',
        panelSelector: '#reader-appearance',
        closeSelector: '[aria-label="Close reading appearance"]',
      },
      {
        openerSelector: '[aria-controls="reader-bookmarks"]',
        panelSelector: '#reader-bookmarks',
        closeSelector: '[aria-label="Close bookmarks and history"]',
      },
      {
        openerSelector: '[aria-controls="reader-annotations"]',
        panelSelector: '#reader-annotations',
        closeSelector: '[aria-label="Close highlights and notes"]',
      },
      {
        openerSelector: '[aria-controls="reader-search"]',
        panelSelector: '#reader-search',
        closeSelector: '[aria-label="Close book search"]',
      },
    ];

    for (const spec of panelSpecs) {
      const opener = stage.querySelector<HTMLButtonElement>(spec.openerSelector)!;

      // Close button path
      opener.focus();
      opener.click();
      await settle();
      expect(stage.querySelector(spec.panelSelector)).not.toBeNull();
      assertBackgroundIsolated();
      stage.querySelector<HTMLButtonElement>(spec.closeSelector)!.click();
      await settle();
      assertBackgroundReleased();
      expect(document.activeElement).toBe(opener);

      // Backdrop click path
      opener.click();
      await settle();
      assertBackgroundIsolated();
      stage.querySelector<HTMLElement>('.reader-panel-backdrop')!.click();
      await settle();
      assertBackgroundReleased();
      expect(document.activeElement).toBe(opener);

      // Escape key path
      opener.click();
      await settle();
      assertBackgroundIsolated();
      stage
        .querySelector<HTMLElement>(spec.panelSelector)!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      await settle();
      assertBackgroundReleased();
      expect(document.activeElement).toBe(opener);

      // Android Back path
      opener.click();
      await settle();
      assertBackgroundIsolated();
      expect(backState.handler?.()).toBe(true);
      await settle();
      assertBackgroundReleased();
      expect(document.activeElement).toBe(opener);
    }

    // 6th modal: Sync confirmation alertdialog
    const syncOpener = stage.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncOpener.focus();
    syncOpener.click();
    await settle();

    const syncDialog = stage.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(syncDialog).not.toBeNull();
    assertBackgroundIsolated();

    // Close sync confirmation via Stay here button
    Array.from(syncDialog!.querySelectorAll('button'))
      .find((btn) => btn.textContent?.trim() === 'Stay here')!
      .click();
    await settle();
    assertBackgroundReleased();
    expect(document.activeElement).toBe(syncOpener);

    // Reopen sync confirmation and close via Android Back
    syncOpener.click();
    await settle();
    assertBackgroundIsolated();
    expect(backState.handler?.()).toBe(true);
    await settle();
    assertBackgroundReleased();
    expect(document.activeElement).toBe(syncOpener);
  });
});
