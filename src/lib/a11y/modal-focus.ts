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

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);

interface SavedElementState {
  count: number;
  hadInertAttribute: boolean;
  previousInert: boolean;
  previousAriaHidden: string | null;
}

interface SavedIframeState extends SavedElementState {
  previousTabIndex: string | null;
}

const isolatedElements = new WeakMap<HTMLElement, SavedElementState>();
const isolatedIframes = new WeakMap<HTMLIFrameElement, SavedIframeState>();

function setInertState(element: HTMLElement, value: boolean): void {
  element.inert = value;
  if (value) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

function restoreAttribute(element: HTMLElement, name: string, previous: string | null): void {
  if (previous === null) element.removeAttribute(name);
  else element.setAttribute(name, previous);
}

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
  if (
    element?.isConnected &&
    !element.hasAttribute('disabled') &&
    !element.matches(':disabled') &&
    !element.closest('[inert], [hidden]')
  ) {
    element.focus();
  }
}

export function isolateModalBackground(
  container: HTMLElement | null,
  boundarySelector = '.app-stage',
): () => void {
  if (!container || !container.isConnected) return () => {};

  const doc = container.ownerDocument;
  const boundary =
    (boundarySelector === '.app-stage' ? container.closest<HTMLElement>('.app-shell') : null) ??
    container.closest<HTMLElement>(boundarySelector) ??
    doc.body;
  if (!boundary) return () => {};

  const sessionElements = new Set<HTMLElement>();
  const sessionIframes = new Set<HTMLIFrameElement>();
  const observedAncestors = new Set<HTMLElement>();
  let released = false;

  const isolateIframe = (iframe: HTMLIFrameElement): void => {
    if (sessionIframes.has(iframe)) return;
    sessionIframes.add(iframe);
    const existing = isolatedIframes.get(iframe);
    if (existing) {
      existing.count += 1;
    } else {
      isolatedIframes.set(iframe, {
        count: 1,
        hadInertAttribute: iframe.hasAttribute('inert'),
        previousInert: Boolean(iframe.inert),
        previousAriaHidden: iframe.getAttribute('aria-hidden'),
        previousTabIndex: iframe.getAttribute('tabindex'),
      });
    }
    setInertState(iframe, true);
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
  };

  const isolateSibling = (sibling: HTMLElement): void => {
    if (IGNORED_TAGS.has(sibling.tagName)) return;
    if (!sessionElements.has(sibling)) {
      sessionElements.add(sibling);
      const existing = isolatedElements.get(sibling);
      if (existing) {
        existing.count += 1;
      } else {
        isolatedElements.set(sibling, {
          count: 1,
          hadInertAttribute: sibling.hasAttribute('inert'),
          previousInert: Boolean(sibling.inert),
          previousAriaHidden: sibling.getAttribute('aria-hidden'),
        });
      }
    }

    sibling.setAttribute('aria-hidden', 'true');
    if (sibling.hasAttribute('data-modal-backdrop')) return;

    setInertState(sibling, true);
    if (sibling instanceof HTMLIFrameElement) {
      isolateIframe(sibling);
      return;
    }
    for (const iframe of sibling.querySelectorAll<HTMLIFrameElement>('iframe')) {
      isolateIframe(iframe);
    }
  };

  const observer =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          if (!released && container.isConnected) syncAncestors();
        })
      : null;

  function syncAncestors(): void {
    let branch: HTMLElement | null = container;
    while (branch && branch !== doc.documentElement) {
      const parent: HTMLElement | null = branch.parentElement;
      if (!parent) break;
      if (observer && !observedAncestors.has(parent)) {
        observedAncestors.add(parent);
        observer.observe(parent, { childList: true });
      }
      for (const child of Array.from(parent.children)) {
        if (child !== branch && child instanceof HTMLElement) {
          isolateSibling(child);
        }
      }
      if (parent === boundary) break;
      branch = parent;
    }
  }

  syncAncestors();

  const handleFocusIn = (event: FocusEvent): void => {
    if (released || !container.isConnected) return;
    const target = event.target;
    if (target instanceof Node && !container.contains(target)) {
      focusFirstElement(container);
    }
  };
  doc.addEventListener('focusin', handleFocusIn, true);

  return () => {
    if (released) return;
    released = true;
    observer?.disconnect();
    observedAncestors.clear();
    doc.removeEventListener('focusin', handleFocusIn, true);

    for (const iframe of sessionIframes) {
      const state = isolatedIframes.get(iframe);
      if (!state) continue;
      state.count -= 1;
      if (state.count > 0) continue;
      isolatedIframes.delete(iframe);
      iframe.inert = state.previousInert;
      if (state.hadInertAttribute || state.previousInert) iframe.setAttribute('inert', '');
      else iframe.removeAttribute('inert');
      restoreAttribute(iframe, 'aria-hidden', state.previousAriaHidden);
      restoreAttribute(iframe, 'tabindex', state.previousTabIndex);
    }
    sessionIframes.clear();

    for (const element of sessionElements) {
      const state = isolatedElements.get(element);
      if (!state) continue;
      state.count -= 1;
      if (state.count > 0) continue;
      isolatedElements.delete(element);
      if (!element.hasAttribute('data-modal-backdrop')) {
        element.inert = state.previousInert;
        if (state.hadInertAttribute || state.previousInert) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
      }
      restoreAttribute(element, 'aria-hidden', state.previousAriaHidden);
    }
    sessionElements.clear();
  };
}

export function activateModal(
  container: HTMLElement | null,
  previousCleanup?: (() => void) | null,
  boundarySelector = '.app-stage',
): () => void {
  previousCleanup?.();
  if (!container || !container.isConnected) return () => {};
  setInertState(container, false);
  container.removeAttribute('aria-hidden');
  const cleanup = isolateModalBackground(container, boundarySelector);
  focusFirstElement(container);
  return cleanup;
}

export function deactivateModal(
  cleanup: (() => void) | null | undefined,
  closingContainer?: HTMLElement | null,
): void {
  cleanup?.();
  if (closingContainer?.isConnected) {
    setInertState(closingContainer, true);
    closingContainer.setAttribute('aria-hidden', 'true');
  }
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
  const active = container.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
