// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, mount, unmount } from 'svelte';
import DialogShell from './DialogShell.svelte';
import { focusFirstElement } from '../a11y/modal-focus';

describe('DialogShell', () => {
  let host: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(() => {
    Element.prototype.animate ??= () => {
      let canceled = false;
      const animation = {
        currentTime: 0,
        playState: 'finished',
        effect: null,
        onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
        cancel: () => {
          canceled = true;
        },
      };
      queueMicrotask(() => {
        if (!canceled) animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
      });
      return animation as unknown as Animation;
    };
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    if (instance) {
      void unmount(instance);
      instance = null;
    }
    host.remove();
  });

  function mountShell(onClose = vi.fn()) {
    const header = createRawSnippet(() => ({
      render: () => `
        <div class="header-row">
          <h2 id="test-dialog-title">Settings</h2>
          <button type="button" data-testid="close-button">Close</button>
        </div>
      `,
    }));

    const children = createRawSnippet(() => ({
      render: () => `
        <div class="body-controls">
          <button type="button" data-testid="first-body-control">Light</button>
          <input type="text" data-testid="middle-body-input" />
          <button type="button" data-testid="last-body-control">Clear diagnostics</button>
        </div>
      `,
    }));

    instance = mount(DialogShell, {
      target: host,
      props: {
        labelledBy: 'test-dialog-title',
        onClose,
        header,
        children,
      },
    });

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const closeButton = host.querySelector<HTMLButtonElement>('[data-testid="close-button"]')!;
    const firstBody = host.querySelector<HTMLButtonElement>('[data-testid="first-body-control"]')!;
    const lastBody = host.querySelector<HTMLButtonElement>('[data-testid="last-body-control"]')!;

    return { onClose, dialog, closeButton, firstBody, lastBody };
  }

  it('separates a non-sticky header from a scrollable body while preserving ARIA attributes and DOM order', () => {
    const { dialog, closeButton, firstBody, lastBody } = mountShell();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('test-dialog-title');
    expect(dialog.tabIndex).toBe(-1);

    const headerContainer = dialog.children[0] as HTMLElement;
    const bodyContainer = dialog.children[1] as HTMLElement;
    expect(headerContainer.classList.contains('shrink-0')).toBe(true);
    expect(headerContainer.classList.contains('sticky')).toBe(false);
    expect(bodyContainer.classList.contains('flex-1')).toBe(true);
    expect(bodyContainer.classList.contains('min-h-0')).toBe(true);
    expect(bodyContainer.classList.contains('overflow-y-auto')).toBe(true);

    expect(headerContainer.contains(closeButton)).toBe(true);
    expect(bodyContainer.contains(firstBody)).toBe(true);
    expect(bodyContainer.contains(lastBody)).toBe(true);
    expect(
      Boolean(closeButton.compareDocumentPosition(firstBody) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    focusFirstElement(dialog);
    expect(document.activeElement).toBe(closeButton);
  });

  it('wraps forward Tab and backward Shift+Tab between header and scrollable body controls', () => {
    const { closeButton, lastBody } = mountShell();

    lastBody.focus();
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    lastBody.dispatchEvent(forward);
    expect(document.activeElement).toBe(closeButton);
    expect(forward.defaultPrevented).toBe(true);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    closeButton.dispatchEvent(backward);
    expect(document.activeElement).toBe(lastBody);
    expect(backward.defaultPrevented).toBe(true);
  });

  it('dismisses on Escape and backdrop click without closing on dialog body clicks', () => {
    const { onClose, dialog, firstBody } = mountShell();
    const backdrop = host.querySelector<HTMLElement>('[role="presentation"]')!;

    firstBody.click();
    dialog.click();
    expect(onClose).not.toHaveBeenCalled();

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    firstBody.dispatchEvent(escape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);

    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('focuses the header close button on mount and recovers Tab/Escape from document.body after a body control unmounts', () => {
    const { onClose, closeButton, lastBody } = mountShell();
    expect(document.activeElement).toBe(closeButton);

    lastBody.focus();
    lastBody.remove();
    expect(document.activeElement).toBe(document.body);

    const tabFromBody = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(tabFromBody);
    expect(tabFromBody.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton);

    closeButton.blur();
    const escapeFromBody = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(escapeFromBody);
    expect(escapeFromBody.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
