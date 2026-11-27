// @vitest-environment jsdom

import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  activateModal,
  activeElement,
  deactivateModal,
  focusFirstElement,
  focusModal,
  isFocusableElement,
  isolateModalBackground,
  restoreFocus,
  restoreModalFocus,
  trapModalKeydown,
} from './modal-focus';

let stage: HTMLDivElement;
let dialog: HTMLDivElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;

beforeEach(() => {
  document.body.replaceChildren();
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

it('retains previous inert, aria-hidden, and iframe tabindex values across nested modals and restores dynamically added siblings when the final modal closes', async () => {
  document.body.innerHTML = '';
  const appShell = document.createElement('div');
  appShell.className = 'app-shell';

  const attrInertSibling = document.createElement('aside');
  attrInertSibling.setAttribute('inert', '');
  attrInertSibling.inert = true;
  attrInertSibling.setAttribute('aria-hidden', 'false');

  const propOnlyInertSibling = document.createElement('section');
  propOnlyInertSibling.inert = true;

  const ariaHiddenSibling = document.createElement('div');
  ariaHiddenSibling.setAttribute('aria-hidden', 'true');

  const activeStage = document.createElement('div');
  activeStage.className = 'app-stage';

  const readerShell = document.createElement('main');
  const viewport = document.createElement('div');
  const presetIframe = document.createElement('iframe');
  presetIframe.setAttribute('tabindex', '0');
  presetIframe.setAttribute('aria-hidden', 'false');
  const plainIframe = document.createElement('iframe');
  viewport.append(presetIframe, plainIframe);

  const overlay = document.createElement('div');
  const toolbar = document.createElement('header');
  const outerModal = document.createElement('div');
  outerModal.tabIndex = -1;
  const outerButton = document.createElement('button');
  outerModal.append(outerButton);
  overlay.append(toolbar, outerModal);

  readerShell.append(viewport, overlay);
  activeStage.append(readerShell);
  appShell.append(attrInertSibling, propOnlyInertSibling, ariaHiddenSibling, activeStage);
  document.body.append(appShell);

  // Activate outer modal (e.g. bookmarks subpanel inside .reader-overlay)
  const outerCleanup = activateModal(outerModal);
  expect(document.activeElement).toBe(outerButton);
  expect(viewport.hasAttribute('inert')).toBe(true);
  expect(presetIframe.getAttribute('tabindex')).toBe('-1');
  expect(presetIframe.getAttribute('aria-hidden')).toBe('true');
  expect(plainIframe.getAttribute('tabindex')).toBe('-1');
  expect(toolbar.hasAttribute('inert')).toBe(true);
  expect(overlay.hasAttribute('inert')).toBe(false);

  // Mount and activate nested inner modal (e.g. z-40 error alertdialog outside .reader-overlay)
  const alertBackdrop = document.createElement('div');
  const innerModal = document.createElement('div');
  innerModal.tabIndex = -1;
  const innerButton = document.createElement('button');
  innerModal.append(innerButton);
  alertBackdrop.append(innerModal);
  readerShell.append(alertBackdrop);
  await Promise.resolve();

  const innerCleanup = activateModal(innerModal);
  expect(document.activeElement).toBe(innerButton);
  expect(alertBackdrop.hasAttribute('inert')).toBe(false);
  expect(innerModal.hasAttribute('inert')).toBe(false);
  expect(overlay.hasAttribute('inert')).toBe(true);
  expect(overlay.getAttribute('aria-hidden')).toBe('true');

  // Stray focusin outside innerModal routes to innerButton without ping-ponging to outerButton
  toolbar.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect(document.activeElement).toBe(innerButton);

  // Dynamically add a sibling + dynamic iframe while nested inner modal is open
  const dynamicSibling = document.createElement('div');
  const dynamicIframe = document.createElement('iframe');
  dynamicIframe.setAttribute('tabindex', '2');
  dynamicSibling.append(dynamicIframe);
  readerShell.append(dynamicSibling);
  await Promise.resolve();

  expect(dynamicSibling.hasAttribute('inert')).toBe(true);
  expect(dynamicSibling.getAttribute('aria-hidden')).toBe('true');
  expect(dynamicIframe.hasAttribute('inert')).toBe(true);
  expect(dynamicIframe.getAttribute('aria-hidden')).toBe('true');
  expect(dynamicIframe.getAttribute('tabindex')).toBe('-1');

  // Deactivate inner modal first: overlay un-inerts, while outer modal keeps siblings + dynamicSibling isolated!
  deactivateModal(innerCleanup, innerModal);
  alertBackdrop.remove();

  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(overlay.hasAttribute('aria-hidden')).toBe(false);
  expect(viewport.hasAttribute('inert')).toBe(true);
  expect(presetIframe.getAttribute('tabindex')).toBe('-1');
  expect(dynamicSibling.hasAttribute('inert')).toBe(true);
  expect(dynamicIframe.getAttribute('tabindex')).toBe('-1');

  outerButton.focus();
  expect(document.activeElement).toBe(outerButton);

  // Deactivate final (outer) modal: all pre-modal inert, aria-hidden, and iframe tabindex states are restored!
  deactivateModal(outerCleanup, outerModal);

  expect(attrInertSibling.hasAttribute('inert')).toBe(true);
  expect(attrInertSibling.inert).toBe(true);
  expect(attrInertSibling.getAttribute('aria-hidden')).toBe('false');

  expect(propOnlyInertSibling.hasAttribute('inert')).toBe(false);
  expect(propOnlyInertSibling.inert).toBe(true);
  expect(propOnlyInertSibling.hasAttribute('aria-hidden')).toBe(false);

  expect(ariaHiddenSibling.hasAttribute('inert')).toBe(false);
  expect(ariaHiddenSibling.inert).toBe(false);
  expect(ariaHiddenSibling.getAttribute('aria-hidden')).toBe('true');

  expect(viewport.hasAttribute('inert')).toBe(false);
  expect(viewport.inert).toBe(false);
  expect(presetIframe.hasAttribute('inert')).toBe(false);
  expect(presetIframe.getAttribute('aria-hidden')).toBe('false');
  expect(presetIframe.getAttribute('tabindex')).toBe('0');

  expect(plainIframe.hasAttribute('inert')).toBe(false);
  expect(plainIframe.hasAttribute('aria-hidden')).toBe(false);
  expect(plainIframe.hasAttribute('tabindex')).toBe(false);

  expect(dynamicSibling.hasAttribute('inert')).toBe(false);
  expect(dynamicSibling.inert).toBe(false);
  expect(dynamicSibling.hasAttribute('aria-hidden')).toBe(false);
  expect(dynamicIframe.hasAttribute('inert')).toBe(false);
  expect(dynamicIframe.hasAttribute('aria-hidden')).toBe(false);
  expect(dynamicIframe.getAttribute('tabindex')).toBe('2');
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
