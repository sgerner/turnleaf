// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel() {},
      finish() {
        animation.onfinish?.();
      },
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async () => new Map()),
  setPreferences: vi.fn(async () => undefined),
}));

vi.mock('../reader/session', () => ({
  ReaderSession: class {
    async open() {}
    tableOfContents() {
      return [];
    }
    updateHighlights() {}
    applyAppearance() {}
    destroy() {}
  },
}));

import Reader from '../components/Reader.svelte';
import { createBackButtonStack } from './back-button';
import { handleReaderBack, type ReaderBackActions, type ReaderBackState } from './reader-back';

function createState(overrides: Partial<ReaderBackState> = {}): ReaderBackState {
  return {
    pendingSyncLocation: false,
    settingsVisible: false,
    tocVisible: false,
    bookmarksVisible: false,
    annotationsVisible: false,
    searchVisible: false,
    hasLinkReturnTarget: false,
    controlsVisible: false,
    footerVisible: false,
    ...overrides,
  };
}

function createActions(overrides: Partial<ReaderBackActions> = {}): ReaderBackActions {
  return {
    closeSyncConfirmation: vi.fn(),
    closeSettings: vi.fn(),
    closeToc: vi.fn(),
    closeBookmarks: vi.fn(),
    closeAnnotations: vi.fn(),
    closeSearch: vi.fn(),
    returnToLink: vi.fn(),
    hideChrome: vi.fn(),
    pauseChromeHide: vi.fn(),
    focusTopReveal: vi.fn(),
    showControls: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe('reader back controller', () => {
  it('hides visible controls, pauses the hide timer, focuses topRevealButton, and skips showControls', () => {
    let controlsVisible = true;
    let footerVisible = true;
    const actions = createActions({
      hideChrome: vi.fn(() => {
        controlsVisible = false;
        footerVisible = false;
      }),
      showControls: vi.fn(() => {
        controlsVisible = true;
      }),
    });

    const consumed = handleReaderBack(createState({ controlsVisible, footerVisible }), actions);

    expect(consumed).toBe(true);
    expect(controlsVisible).toBe(false);
    expect(footerVisible).toBe(false);
    expect(actions.hideChrome).toHaveBeenCalledOnce();
    expect(actions.pauseChromeHide).toHaveBeenCalledOnce();
    expect(actions.focusTopReveal).toHaveBeenCalledOnce();
    expect(actions.showControls).not.toHaveBeenCalled();
    expect(actions.onBack).not.toHaveBeenCalled();
  });

  it('hides a standalone footer without re-showing controls', () => {
    const actions = createActions();

    const consumed = handleReaderBack(
      createState({ controlsVisible: false, footerVisible: true }),
      actions,
    );

    expect(consumed).toBe(true);
    expect(actions.hideChrome).toHaveBeenCalledOnce();
    expect(actions.pauseChromeHide).toHaveBeenCalledOnce();
    expect(actions.focusTopReveal).toHaveBeenCalledOnce();
    expect(actions.showControls).not.toHaveBeenCalled();
    expect(actions.onBack).not.toHaveBeenCalled();
  });

  it('exits the reader on the second Back press after controls are hidden', () => {
    let controlsVisible = true;
    let footerVisible = false;
    const actions = createActions({
      hideChrome: vi.fn(() => {
        controlsVisible = false;
        footerVisible = false;
      }),
      showControls: vi.fn(() => {
        controlsVisible = true;
      }),
    });

    expect(handleReaderBack(createState({ controlsVisible, footerVisible }), actions)).toBe(true);
    expect(controlsVisible).toBe(false);
    expect(actions.onBack).not.toHaveBeenCalled();

    expect(handleReaderBack(createState({ controlsVisible, footerVisible }), actions)).toBe(true);
    expect(actions.onBack).toHaveBeenCalledOnce();
    expect(actions.showControls).not.toHaveBeenCalled();
  });

  it('exits immediately on one Back press when controls and panels start hidden', () => {
    const actions = createActions();

    expect(handleReaderBack(createState(), actions)).toBe(true);
    expect(actions.onBack).toHaveBeenCalledOnce();
    expect(actions.showControls).not.toHaveBeenCalled();
  });

  it('dismisses open panels and link jumps in priority order while keeping controls visible', () => {
    const layers: Array<[keyof ReaderBackState, keyof ReaderBackActions]> = [
      ['pendingSyncLocation', 'closeSyncConfirmation'],
      ['settingsVisible', 'closeSettings'],
      ['tocVisible', 'closeToc'],
      ['bookmarksVisible', 'closeBookmarks'],
      ['annotationsVisible', 'closeAnnotations'],
      ['searchVisible', 'closeSearch'],
      ['hasLinkReturnTarget', 'returnToLink'],
    ];

    for (const [stateKey, actionKey] of layers) {
      const actions = createActions();
      const consumed = handleReaderBack(
        createState({ [stateKey]: true, controlsVisible: true }),
        actions,
      );

      expect(consumed).toBe(true);
      expect(actions[actionKey]).toHaveBeenCalledOnce();
      expect(actions.showControls).toHaveBeenCalledOnce();
      expect(actions.hideChrome).not.toHaveBeenCalled();
      expect(actions.onBack).not.toHaveBeenCalled();
    }
  });

  it('mounts Reader.svelte, focuses topRevealButton on first Back with visible controls, and exits on second Back', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onBack = vi.fn();
    const stack = createBackButtonStack();
    const mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-epub',
        bookId: 'book-1',
        title: 'Test Book',
        onBack,
        onRelocated: vi.fn(),
        registerBackHandler: stack.register,
      },
    });

    try {
      await tick();

      // Controls start hidden: one Back press exits immediately.
      expect(stack.dispatch()).toBe(true);
      expect(onBack).toHaveBeenCalledTimes(1);

      // Reveal controls, then press Back once to hide chrome and focus topRevealButton.
      const revealButton = host.querySelector<HTMLButtonElement>('.reader-top-reveal');
      expect(revealButton).not.toBeNull();
      revealButton!.click();
      await tick();
      expect(host.querySelector('[data-controls]')).not.toBeNull();

      expect(stack.dispatch()).toBe(true);
      await tick();
      await Promise.resolve();

      const restoredReveal = host.querySelector<HTMLButtonElement>('.reader-top-reveal');
      expect(restoredReveal).not.toBeNull();
      expect(document.activeElement).toBe(restoredReveal);
      expect(onBack).toHaveBeenCalledTimes(1);

      // Second Back press exits the reader.
      expect(stack.dispatch()).toBe(true);
      expect(onBack).toHaveBeenCalledTimes(2);
    } finally {
      await unmount(mounted);
      host.remove();
    }
  });
});
