// @vitest-environment jsdom

import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeElement,
  focusAfterUnmount,
  focusFirstElement,
  focusModal,
  focusViewEntry,
  isFocusableElement,
  modalFocusTrap,
  restoreFocus,
  restoreModalFocus,
  trapModalKeydown,
} from './modal-focus';

let dialog: HTMLDivElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;

beforeEach(() => {
  document.body.replaceChildren();
  dialog = document.createElement('div');
  dialog.tabIndex = -1;
  first = document.createElement('button');
  last = document.createElement('button');
  dialog.append(first, last);
  document.body.append(dialog);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it('falls back when opener is disabled, disconnected, document.body, or inside an inert ancestor', () => {
  const fallback = document.createElement('button');
  document.body.append(fallback);

  const disabledOpener = document.createElement('button');
  disabledOpener.disabled = true;
  document.body.append(disabledOpener);
  first.focus();
  restoreFocus(disabledOpener, fallback);
  expect(document.activeElement).toBe(fallback);

  const disconnectedOpener = document.createElement('button');
  first.focus();
  restoreFocus(disconnectedOpener, fallback);
  expect(document.activeElement).toBe(fallback);

  first.focus();
  restoreFocus(document.body, fallback);
  expect(document.activeElement).toBe(fallback);

  const inertWrapper = document.createElement('div');
  inertWrapper.setAttribute('inert', '');
  const inertOpener = document.createElement('button');
  inertWrapper.append(inertOpener);
  document.body.append(inertWrapper);
  first.focus();
  restoreFocus(inertOpener, fallback);
  expect(document.activeElement).toBe(fallback);

  const propertyInertWrapper = document.createElement('div');
  propertyInertWrapper.inert = true;
  const propertyInertOpener = document.createElement('button');
  propertyInertWrapper.append(propertyInertOpener);
  document.body.append(propertyInertWrapper);
  first.focus();
  restoreFocus(propertyInertOpener, fallback);
  expect(document.activeElement).toBe(fallback);

  const toolbarFallback = document.createElement('header');
  const toolbarButton = document.createElement('button');
  toolbarFallback.append(toolbarButton);
  document.body.append(toolbarFallback);
  first.focus();
  restoreFocus(document.body, toolbarFallback);
  expect(document.activeElement).toBe(toolbarButton);
});

it('short-circuits focus checks across 1,500 controls without filtering middle rows', () => {
  const largeDialog = document.createElement('div');
  largeDialog.tabIndex = -1;
  const controls = Array.from({ length: 1_501 }, () => document.createElement('button'));
  largeDialog.append(...controls);
  document.body.append(largeDialog);

  const middleSpy = vi.spyOn(controls[750]!, 'matches');

  focusFirstElement(largeDialog);
  expect(document.activeElement).toBe(controls[0]);
  expect(middleSpy).not.toHaveBeenCalled();

  controls[0]!.focus();
  const backward = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  trapModalKeydown(backward, largeDialog, vi.fn());
  expect(document.activeElement).toBe(controls[1_500]);
  expect(middleSpy).not.toHaveBeenCalled();

  controls[1_500]!.focus();
  const forward = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  trapModalKeydown(forward, largeDialog, vi.fn());
  expect(document.activeElement).toBe(controls[0]);
  expect(middleSpy).not.toHaveBeenCalled();
});

it('respects disabled fieldset boundaries and falls back to the dialog container', () => {
  const modal = document.createElement('div');
  modal.tabIndex = -1;
  const leadingFieldset = document.createElement('fieldset');
  leadingFieldset.disabled = true;
  const disabledLeadingButton = document.createElement('button');
  leadingFieldset.append(disabledLeadingButton);

  const activeButton = document.createElement('button');

  const trailingFieldset = document.createElement('fieldset');
  trailingFieldset.disabled = true;
  const disabledTrailingButton = document.createElement('button');
  trailingFieldset.append(disabledTrailingButton);

  modal.append(leadingFieldset, activeButton, trailingFieldset);
  document.body.append(modal);

  expect(isFocusableElement(disabledLeadingButton)).toBe(false);
  expect(isFocusableElement(activeButton)).toBe(true);

  focusFirstElement(modal);
  expect(document.activeElement).toBe(activeButton);

  const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  trapModalKeydown(forward, modal, vi.fn());
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(activeButton);

  activeButton.disabled = true;
  const emptyTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  trapModalKeydown(emptyTab, modal, vi.fn());
  expect(emptyTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(modal);

  restoreFocus(disabledLeadingButton);
  expect(document.activeElement).toBe(modal);
});

it('returns the focused HTMLElement and null for non-HTML targets or missing document', () => {
  first.focus();
  expect(activeElement()).toBe(first);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  vi.spyOn(document, 'activeElement', 'get').mockReturnValue(svg);
  expect(activeElement()).toBeNull();

  vi.stubGlobal('document', undefined);
  expect(activeElement()).toBeNull();
});

it('defers modal focus placement until after tick and ignores unmounted containers', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();

  let mountedDialog: HTMLElement | null = null;
  focusModal(() => mountedDialog);
  expect(document.activeElement).toBe(opener);

  mountedDialog = dialog;
  await tick();
  expect(document.activeElement).toBe(first);

  focusModal(() => null);
  await tick();
  expect(document.activeElement).toBe(first);
});

it('defers focus restoration to connected enabled openers and skips disconnected or disabled ones', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  first.focus();

  restoreModalFocus(opener);
  expect(document.activeElement).toBe(first);
  await tick();
  expect(document.activeElement).toBe(opener);

  first.focus();
  opener.disabled = true;
  restoreModalFocus(opener);
  await tick();
  expect(document.activeElement).toBe(first);

  opener.disabled = false;
  opener.remove();
  restoreModalFocus(opener);
  await tick();
  expect(document.activeElement).toBe(first);

  const fallback = document.createElement('button');
  document.body.append(fallback);
  restoreModalFocus(opener, () => fallback);
  await tick();
  expect(document.activeElement).toBe(fallback);
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
