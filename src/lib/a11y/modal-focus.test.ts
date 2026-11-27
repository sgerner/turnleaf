// @vitest-environment jsdom

import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  activeElement,
  focusFirstElement,
  focusModal,
  isFocusableElement,
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

it('restores focus to an opener inside a child iframe', () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const childDoc = iframe.contentDocument!;
  const childLink = childDoc.createElement('a');
  childLink.setAttribute('role', 'link');
  childLink.tabIndex = 0;
  childDoc.body.append(childLink);

  restoreFocus(childLink);

  expect(childDoc.activeElement).toBe(childLink);
  iframe.remove();
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
