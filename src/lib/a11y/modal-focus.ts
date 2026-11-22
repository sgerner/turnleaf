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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 && !element.matches(':disabled') && !isHiddenOrInert(element),
  );
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

export function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

export function focusFirstElement(container: HTMLElement | null): void {
  if (!container) return;
  const first = getFocusableElements(container)[0];
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
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
