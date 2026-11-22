// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  activateModal,
  deactivateModal,
  focusFirstElement,
  isolateModalBackground,
  restoreFocus,
  trapModalKeydown,
} from './modal-focus';

let stage: HTMLDivElement;
let dialog: HTMLDivElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
  stage = document.createElement('div');
  stage.className = 'app-stage';
  dialog = document.createElement('div');
  dialog.tabIndex = -1;
  first = document.createElement('button');
  last = document.createElement('button');
  dialog.append(first, last);
  stage.append(dialog);
  document.body.append(stage);
});

afterEach(() => {
  document.body.innerHTML = '';
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
  stage.append(opener);
  const close = vi.fn();
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

  trapModalKeydown(event, dialog, close);
  restoreFocus(opener);

  expect(close).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(opener);
});

it('isolates siblings across ancestor levels up to .app-stage while keeping backdrop clickable', async () => {
  document.body.innerHTML = '';
  const ambient = document.createElement('div');
  ambient.setAttribute('aria-hidden', 'true');
  stage = document.createElement('div');
  stage.className = 'app-stage';

  const banner = document.createElement('div');
  const shell = document.createElement('main');
  const viewport = document.createElement('div');
  const epubFrame = document.createElement('iframe');
  viewport.append(epubFrame);
  const footer = document.createElement('footer');
  const overlay = document.createElement('div');
  const toolbar = document.createElement('header');
  const backdrop = document.createElement('div');
  backdrop.setAttribute('data-modal-backdrop', '');
  const panel = document.createElement('div');
  const panelClose = document.createElement('button');
  panel.append(panelClose);

  overlay.append(toolbar, backdrop, panel);
  shell.append(viewport, overlay, footer);
  stage.append(banner, shell);
  document.body.append(ambient, stage);

  const release = isolateModalBackground(panel);

  expect(banner.hasAttribute('inert')).toBe(true);
  expect(banner.getAttribute('aria-hidden')).toBe('true');
  expect(viewport.hasAttribute('inert')).toBe(true);
  expect(viewport.getAttribute('aria-hidden')).toBe('true');
  expect(epubFrame.hasAttribute('inert')).toBe(true);
  expect(epubFrame.getAttribute('aria-hidden')).toBe('true');
  expect(epubFrame.getAttribute('tabindex')).toBe('-1');
  expect(toolbar.hasAttribute('inert')).toBe(true);
  expect(footer.hasAttribute('inert')).toBe(true);

  expect(backdrop.getAttribute('aria-hidden')).toBe('true');
  expect(backdrop.hasAttribute('inert')).toBe(false);
  expect(shell.hasAttribute('inert')).toBe(false);
  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(panel.hasAttribute('inert')).toBe(false);
  expect(ambient.hasAttribute('inert')).toBe(false);

  const dynamicProgress = document.createElement('div');
  shell.append(dynamicProgress);
  await Promise.resolve();
  expect(dynamicProgress.hasAttribute('inert')).toBe(true);
  expect(dynamicProgress.getAttribute('aria-hidden')).toBe('true');

  release();

  expect(banner.hasAttribute('inert')).toBe(false);
  expect(banner.hasAttribute('aria-hidden')).toBe(false);
  expect(viewport.hasAttribute('inert')).toBe(false);
  expect(epubFrame.hasAttribute('inert')).toBe(false);
  expect(epubFrame.hasAttribute('aria-hidden')).toBe(false);
  expect(epubFrame.hasAttribute('tabindex')).toBe(false);
  expect(toolbar.hasAttribute('inert')).toBe(false);
  expect(footer.hasAttribute('inert')).toBe(false);
  expect(dynamicProgress.hasAttribute('inert')).toBe(false);
  expect(ambient.getAttribute('aria-hidden')).toBe('true');
});

it('redirects stray focusin outside an active modal and releases inert before restoring focus', () => {
  const main = document.createElement('main');
  const opener = document.createElement('button');
  main.append(opener);
  stage.prepend(main);

  const cleanup = activateModal(dialog);
  expect(document.activeElement).toBe(first);
  expect(main.hasAttribute('inert')).toBe(true);

  restoreFocus(opener);
  expect(document.activeElement).toBe(first);

  opener.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect(document.activeElement).toBe(first);

  deactivateModal(cleanup, dialog);
  expect(main.hasAttribute('inert')).toBe(false);
  expect(dialog.hasAttribute('inert')).toBe(true);
  expect(dialog.getAttribute('aria-hidden')).toBe('true');

  restoreFocus(opener);
  expect(document.activeElement).toBe(opener);
});
