// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';
import { focusFirstElement, restoreFocus, trapModalKeydown } from './modal-focus';

let dialog: HTMLDivElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
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
