import { tick } from 'svelte';
import type { ActionReturn } from 'svelte/action';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const HIDDEN_OR_INERT_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

const DEFAULT_FALLBACK_SELECTORS = [
  '#library-search',
  '#library-results',
  '.reader-shell',
  'h1',
  '[role="alert"]',
  'main',
] as const;

export type FocusViewEntryOptions = {
  force?: boolean;
  target?: string;
};

export type FocusFallbackTarget =
  string | readonly string[] | HTMLElement | (() => HTMLElement | string | null | undefined) | null;

export type ModalFocusTrapOptions = (() => void) | { onClose: () => void };

function isHiddenOrInert(element: Element): boolean {
  if (element.closest(HIDDEN_OR_INERT_SELECTOR)) return true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current instanceof HTMLElement && current.inert) return true;
  }
  return false;
}

function isAvailableElement(element: Element | null | undefined): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !element.hasAttribute('disabled') &&
    !element.matches(':disabled') &&
    !isHiddenOrInert(element)
  );
}

function ensureProgrammaticFocus(element: HTMLElement): void {
  if (!element.hasAttribute('tabindex') && element.tabIndex < 0) {
    element.setAttribute('tabindex', '-1');
  }
}

function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!isAvailableElement(element)) return false;
  ensureProgrammaticFocus(element);
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function hasLostFocus(): boolean {
  const active = document.activeElement;
  return (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    !active.isConnected ||
    isHiddenOrInert(active)
  );
}

function queryAvailableElement(selector: string, root: ParentNode = document): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(selector)) {
    if (isAvailableElement(candidate)) return candidate;
  }
  return null;
}

function resolveFallbackElement(target: FocusFallbackTarget | undefined): HTMLElement | null {
  if (typeof target === 'function') {
    const resolved = target();
    if (typeof resolved === 'string') {
      return queryAvailableElement(resolved) ?? resolveDefaultFallback();
    }
    if (isAvailableElement(resolved)) return resolved;
    return resolveDefaultFallback();
  }
  if (typeof target === 'string') {
    return queryAvailableElement(target) ?? resolveDefaultFallback();
  }
  if (!target) {
    return resolveDefaultFallback();
  }
  if (target instanceof HTMLElement) {
    return isAvailableElement(target) ? target : resolveDefaultFallback();
  }
  for (const selector of target) {
    const match = queryAvailableElement(selector);
    if (match) return match;
  }
  return resolveDefaultFallback();
}

function resolveDefaultFallback(): HTMLElement | null {
  for (const selector of DEFAULT_FALLBACK_SELECTORS) {
    const match = queryAvailableElement(selector);
    if (match) return match;
  }
  return null;
}

export function isFocusableElement(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && !element.matches(':disabled') && !isHiddenOrInert(element);
}

function canRestoreFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(
    element &&
    element.isConnected &&
    element !== document.body &&
    element !== document.documentElement &&
    !element.hasAttribute('disabled') &&
    !element.matches(':disabled') &&
    !isHiddenOrInert(element),
  );
}

function findFirstFocusableElement(
  candidates: ArrayLike<HTMLElement>,
): { element: HTMLElement; index: number } | null {
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index];
    if (element && isFocusableElement(element)) {
      return { element, index };
    }
  }
  return null;
}

function findLastFocusableElement(
  candidates: ArrayLike<HTMLElement>,
  minIndex = 0,
): HTMLElement | null {
  for (let index = candidates.length - 1; index >= minIndex; index -= 1) {
    const element = candidates[index];
    if (element && isFocusableElement(element)) {
      return element;
    }
  }
  return null;
}

export function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

export function focusFirstElement(container: HTMLElement | null): void {
  if (!container) return;
  const candidates = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const first = findFirstFocusableElement(candidates)?.element;
  focusElement(first ?? container);
}

export function focusModal(getContainer: () => HTMLElement | null): void {
  void tick().then(() => focusFirstElement(getContainer()));
}

export function restoreFocus(element: HTMLElement | null, fallback?: HTMLElement | null): void {
  if (canRestoreFocusTarget(element) && focusElement(element)) {
    return;
  }
  if (!canRestoreFocusTarget(fallback)) return;
  if (fallback.matches(FOCUSABLE_SELECTOR) && fallback.tabIndex >= 0) {
    focusElement(fallback);
    return;
  }
  focusFirstElement(fallback);
}

export function restoreModalFocus(
  element: HTMLElement | null,
  fallback?: HTMLElement | null | (() => HTMLElement | null),
): void {
  void tick().then(() =>
    restoreFocus(element, typeof fallback === 'function' ? fallback() : fallback),
  );
}

export function trapModalKeydown(
  event: KeyboardEvent,
  container: HTMLElement,
  close: () => void,
): void {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;

  const candidates = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const firstMatch = findFirstFocusableElement(candidates);
  if (!firstMatch) {
    event.preventDefault();
    focusElement(container);
    return;
  }

  const first = firstMatch.element;
  const last = findLastFocusableElement(candidates, firstMatch.index + 1) ?? first;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    focusElement(last);
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    focusElement(first);
  }
}

export function focusViewEntry(
  node: HTMLElement,
  options?: FocusViewEntryOptions,
): ActionReturn<FocusViewEntryOptions | undefined> {
  let currentOptions = options;
  let destroyed = false;

  const applyFocus = (force: boolean): void => {
    if (destroyed || !isAvailableElement(node)) return;
    if (!force && !hasLostFocus()) return;
    const target = currentOptions?.target
      ? (queryAvailableElement(currentOptions.target, node) ?? node)
      : node;
    focusElement(target);
  };

  applyFocus(Boolean(currentOptions?.force));
  queueMicrotask(() => applyFocus(false));

  return {
    update(next) {
      currentOptions = next;
    },
    destroy() {
      destroyed = true;
    },
  };
}

export function focusAfterUnmount(
  node: HTMLElement,
  target?: FocusFallbackTarget,
): ActionReturn<FocusFallbackTarget | undefined> {
  let currentTarget = target;
  let hadFocus = node.contains(document.activeElement);
  let restoredOnInert = false;

  const restoreToFallback = (): boolean => {
    if (!hasLostFocus() && !node.contains(document.activeElement)) return false;
    return focusElement(resolveFallbackElement(currentTarget));
  };

  const onFocusIn = (): void => {
    hadFocus = true;
    restoredOnInert = false;
  };

  const onFocusOut = (): void => {
    queueMicrotask(() => {
      if (!node.isConnected || node.matches(':disabled') || node.hasAttribute('disabled')) {
        return;
      }
      if (isHiddenOrInert(node)) {
        if (hadFocus && !restoredOnInert && restoreToFallback()) {
          restoredOnInert = true;
          hadFocus = false;
        }
        return;
      }
      if (!node.contains(document.activeElement)) {
        hadFocus = false;
      }
    });
  };

  node.addEventListener('focusin', onFocusIn);
  node.addEventListener('focusout', onFocusOut);

  return {
    update(next) {
      currentTarget = next;
    },
    destroy() {
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', onFocusOut);
      if (restoredOnInert || (!hadFocus && !node.contains(document.activeElement))) return;
      hadFocus = false;
      if (!restoreToFallback()) {
        queueMicrotask(() => {
          restoreToFallback();
        });
      }
    },
  };
}

export function modalFocusTrap(
  node: HTMLElement,
  options: ModalFocusTrapOptions,
): ActionReturn<ModalFocusTrapOptions> {
  let getClose = (): (() => void) => (typeof options === 'function' ? options : options.onClose);
  let destroyed = false;

  const focusInitial = (): void => {
    if (destroyed || !isAvailableElement(node) || node.contains(document.activeElement)) return;
    focusFirstElement(node);
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (destroyed || event.defaultPrevented || !node.isConnected || isHiddenOrInert(node)) {
      return;
    }
    trapModalKeydown(event, node, getClose());
  };

  focusInitial();
  queueMicrotask(focusInitial);
  document.addEventListener('keydown', onKeydown);

  return {
    update(next) {
      getClose = () => (typeof next === 'function' ? next : next.onClose);
    },
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKeydown);
    },
  };
}
