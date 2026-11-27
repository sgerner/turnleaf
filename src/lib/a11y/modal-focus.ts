import { tick } from 'svelte';

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

function isHiddenOrInert(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.inert) return true;
  }
  return false;
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
  (first ?? container).focus();
}

export function focusModal(getContainer: () => HTMLElement | null): void {
  void tick().then(() => focusFirstElement(getContainer()));
}

export function restoreFocus(element: HTMLElement | null, fallback?: HTMLElement | null): void {
  if (canRestoreFocusTarget(element)) {
    element.focus();
    return;
  }
  if (!canRestoreFocusTarget(fallback)) return;
  if (fallback.matches(FOCUSABLE_SELECTOR) && fallback.tabIndex >= 0) {
    fallback.focus();
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
    container.focus();
    return;
  }

  const first = firstMatch.element;
  const last = findLastFocusableElement(candidates, firstMatch.index + 1) ?? first;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
