// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';
import {
  focusFirstElement,
  isFocusableElement,
  restoreFocus,
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
