// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusAfterUnmount,
  focusFirstElement,
  focusViewEntry,
  modalFocusTrap,
  restoreFocus,
  trapModalKeydown,
} from './modal-focus';

let dialog: HTMLDivElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;

beforeEach(() => {
  dialog = document.createElement('div');
  dialog.tabIndex = -1;
  first = document.createElement('button');
  last = document.createElement('button');
  dialog.append(first, last);
  document.body.append(dialog);
});

it('focuses the first available control when a modal opens', () => {
  focusFirstElement(dialog);
  expect(document.activeElement).toBe(first);
});

it('skips controls removed from sequential navigation', () => {
  first.tabIndex = -1;
  focusFirstElement(dialog);
  expect(document.activeElement).toBe(last);
});

it('wraps forward and backward tab navigation inside the modal', () => {
  last.focus();
  const forward = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  trapModalKeydown(forward, dialog, vi.fn());
  expect(document.activeElement).toBe(first);
  expect(forward.defaultPrevented).toBe(true);

  first.focus();
  const backward = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  trapModalKeydown(backward, dialog, vi.fn());
  expect(document.activeElement).toBe(last);
  expect(backward.defaultPrevented).toBe(true);
});

it('closes on Escape and restores focus to a connected opener', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  const close = vi.fn();
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

  trapModalKeydown(event, dialog, close);
  restoreFocus(opener);

  expect(close).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(opener);
});

describe('declarative focus actions', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses incoming view headings or landmarks when activeElement is document.body', () => {
    document.body.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = 'Turnleaf';
    document.body.append(heading);

    expect(document.activeElement).toBe(document.body);
    const action = focusViewEntry(heading);

    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
    action?.destroy?.();
  });

  it('preserves existing connected focus on Library remounts such as closeReader', async () => {
    document.body.replaceChildren();
    const bookCardButton = document.createElement('button');
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.append(heading, bookCardButton);

    bookCardButton.focus();
    const action = focusViewEntry(heading);
    await Promise.resolve();

    expect(document.activeElement).toBe(bookCardButton);
    action?.destroy?.();
  });

  it('supports forced focus entry for inline confirmation prompts', () => {
    document.body.replaceChildren();
    const opener = document.createElement('button');
    const prompt = document.createElement('div');
    prompt.tabIndex = -1;
    document.body.append(opener, prompt);

    opener.focus();
    const action = focusViewEntry(prompt, { force: true });

    expect(document.activeElement).toBe(prompt);
    action?.destroy?.();
  });

  it('moves focus to declared and default fallbacks when conditional buttons unmount', () => {
    document.body.replaceChildren();
    const searchInput = document.createElement('input');
    searchInput.id = 'library-search';
    const clearSearch = document.createElement('button');
    const results = document.createElement('section');
    results.id = 'library-results';
    results.tabIndex = -1;
    const clearFilters = document.createElement('button');
    document.body.append(searchInput, clearSearch, results, clearFilters);

    const searchAction = focusAfterUnmount(clearSearch, '#library-search');
    clearSearch.focus();
    clearSearch.remove();
    searchAction?.destroy?.();
    expect(document.activeElement).toBe(searchInput);

    const filtersAction = focusAfterUnmount(clearFilters);
    clearFilters.focus();
    searchInput.remove();
    clearFilters.remove();
    filtersAction?.destroy?.();
    expect(document.activeElement).toBe(results);
  });

  it('moves focus immediately when an outro transition marks the unmounting ancestor inert', async () => {
    document.body.replaceChildren();
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    const banner = document.createElement('div');
    const dismiss = document.createElement('button');
    banner.append(dismiss);
    document.body.append(banner, heading);

    const action = focusAfterUnmount(dismiss, ['h1', '[role="alert"]', 'main']);
    dismiss.focus();

    banner.setAttribute('inert', '');
    dismiss.blur();
    await Promise.resolve();

    expect(document.activeElement).toBe(heading);
    banner.remove();
    action?.destroy?.();
  });

  it('does not steal focus when the user moved focus to another control before unmount', async () => {
    document.body.replaceChildren();
    const searchInput = document.createElement('input');
    searchInput.id = 'library-search';
    const otherButton = document.createElement('button');
    const clearSearch = document.createElement('button');
    document.body.append(searchInput, otherButton, clearSearch);

    const action = focusAfterUnmount(clearSearch, '#library-search');
    clearSearch.focus();
    otherButton.focus();
    await Promise.resolve();

    clearSearch.remove();
    action?.destroy?.();
    expect(document.activeElement).toBe(otherButton);
  });

  it('traps Tab and handles Escape at document level even after focus leaves the dialog', () => {
    document.body.replaceChildren();
    const modal = document.createElement('div');
    modal.tabIndex = -1;
    const closeButton = document.createElement('button');
    const childButton = document.createElement('button');
    modal.append(closeButton, childButton);
    document.body.append(modal);

    const onClose = vi.fn();
    const trap = modalFocusTrap(modal, onClose);
    expect(document.activeElement).toBe(closeButton);

    childButton.focus();
    childButton.remove();
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
    expect(document.activeElement).toBe(document.body);

    const escapeFromBody = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(escapeFromBody);
    expect(escapeFromBody.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    trap?.destroy?.();
    const escapeAfterDestroy = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(escapeAfterDestroy);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
