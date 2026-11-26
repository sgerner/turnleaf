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

export function isFocusableElement(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    !element.matches(':disabled') &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]')
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

export function restoreFocus(element: HTMLElement | null): void {
  if (!element?.isConnected || element.hasAttribute('disabled') || element.matches(':disabled')) {
    return;
  }
  const view = element.ownerDocument?.defaultView;
  if (view && view !== window) {
    const frame = view.frameElement;
    if (frame && 'focus' in frame && typeof frame.focus === 'function') frame.focus();
  }
  element.focus();
}

export function restoreModalFocus(element: HTMLElement | null): void {
  void tick().then(() => restoreFocus(element));
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
