// @vitest-environment jsdom

import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  activeElement,
  focusFirstElement,
  focusModal,
  restoreFocus,
  restoreModalFocus,
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
});
