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

interface ActiveModalEntry {
  container: HTMLElement;
  syncAncestors: () => void;
}

const isolatedElements = new WeakMap<HTMLElement, SavedElementState>();
const isolatedIframes = new WeakMap<HTMLIFrameElement, SavedIframeState>();
const activeModalStacks = new WeakMap<Document, ActiveModalEntry[]>();

function setInertState(element: HTMLElement, value: boolean): void {
  element.inert = value;
  if (value) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

function restoreInertState(
  element: HTMLElement,
  previousInert: boolean,
  hadInertAttribute: boolean,
): void {
  element.inert = previousInert;
  if (hadInertAttribute) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

function restoreAttribute(element: HTMLElement, name: string, previous: string | null): void {
  if (previous === null) element.removeAttribute(name);
  else element.setAttribute(name, previous);
}

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

export function isolateModalBackground(
  container: HTMLElement | null,
  boundarySelector = '.app-stage',
): () => void {
  if (!container || !container.isConnected) return () => {};

  const modalContainer = container;
  const doc = modalContainer.ownerDocument;
  const boundary =
    (boundarySelector === '.app-stage'
      ? modalContainer.closest<HTMLElement>('.app-shell')
      : null) ??
    modalContainer.closest<HTMLElement>(boundarySelector) ??
    doc.body;
  if (!boundary) return () => {};

  const sessionElements = new Set<HTMLElement>();
  const sessionIframes = new Set<HTMLIFrameElement>();
  const observedAncestors = new Set<HTMLElement>();
  let released = false;

  const entry: ActiveModalEntry = {
    container: modalContainer,
    syncAncestors,
  };
  const initialStack = activeModalStacks.get(doc) ?? [];
  initialStack.push(entry);
  activeModalStacks.set(doc, initialStack);

  const isUpperModalBranch = (candidate: HTMLElement): boolean => {
    const stack = activeModalStacks.get(doc);
    if (!stack) return false;
    const entryIndex = stack.indexOf(entry);
    if (entryIndex < 0) return false;
    for (let index = entryIndex + 1; index < stack.length; index += 1) {
      const upper = stack[index];
      if (
        upper &&
        upper.container.isConnected &&
        (upper.container === candidate || candidate.contains(upper.container))
      ) {
        return true;
      }
    }
    return false;
  };

  const isolateIframe = (iframe: HTMLIFrameElement): void => {
    if (isUpperModalBranch(iframe)) return;
    if (!sessionIframes.has(iframe)) {
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
    }
    setInertState(iframe, true);
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
  };

  const isolateSibling = (sibling: HTMLElement): void => {
    if (IGNORED_TAGS.has(sibling.tagName) || isUpperModalBranch(sibling)) return;
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
      ? new MutationObserver((records) => {
          if (released || !modalContainer.isConnected) return;
          const hasOutsideMutation = records.some(
            (record) => !modalContainer.contains(record.target),
          );
          if (hasOutsideMutation) syncAncestors();
        })
      : null;

  if (observer) {
    observedAncestors.add(boundary);
    observer.observe(boundary, { childList: true, subtree: true });
  }

  const hasUpperModalOutside = (branchNode: HTMLElement): boolean => {
    const stack = activeModalStacks.get(doc);
    if (!stack) return false;
    const entryIndex = stack.indexOf(entry);
    if (entryIndex < 0) return false;
    for (let index = entryIndex + 1; index < stack.length; index += 1) {
      const upper = stack[index];
      if (upper && upper.container.isConnected && !branchNode.contains(upper.container)) {
        return true;
      }
    }
    return false;
  };

  function syncAncestors(): void {
    if (released || !modalContainer.isConnected) return;
    let branch: HTMLElement | null = modalContainer;
    while (branch && branch !== doc.documentElement) {
      const savedBranchState = isolatedElements.get(branch);
      if (savedBranchState && !hasUpperModalOutside(branch)) {
        restoreInertState(
          branch,
          savedBranchState.previousInert,
          savedBranchState.hadInertAttribute,
        );
        restoreAttribute(branch, 'aria-hidden', savedBranchState.previousAriaHidden);
      }
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
    if (released || !modalContainer.isConnected) return;
    const stack = activeModalStacks.get(doc);
    if (stack) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const candidate = stack[index];
        if (candidate?.container.isConnected) {
          if (candidate !== entry) return;
          break;
        }
      }
    }
    const target = event.target;
    if (target instanceof Node && !modalContainer.contains(target)) {
      focusFirstElement(modalContainer);
    }
  };
  doc.addEventListener('focusin', handleFocusIn, true);

  return () => {
    if (released) return;
    released = true;
    observer?.disconnect();
    observedAncestors.clear();
    doc.removeEventListener('focusin', handleFocusIn, true);

    const stack = activeModalStacks.get(doc);
    if (stack) {
      const entryIndex = stack.indexOf(entry);
      if (entryIndex >= 0) stack.splice(entryIndex, 1);
      if (stack.length === 0) {
        activeModalStacks.delete(doc);
      } else {
        for (const remaining of stack) {
          if (remaining.container.isConnected) {
            remaining.syncAncestors();
          }
        }
      }
    }

    for (const iframe of sessionIframes) {
      const state = isolatedIframes.get(iframe);
      if (!state) continue;
      state.count -= 1;
      if (state.count > 0) continue;
      isolatedIframes.delete(iframe);
      restoreInertState(iframe, state.previousInert, state.hadInertAttribute);
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
        restoreInertState(element, state.previousInert, state.hadInertAttribute);
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
  autoFocus = true,
): () => void {
  previousCleanup?.();
  if (!container || !container.isConnected) return () => {};
  setInertState(container, false);
  container.removeAttribute('aria-hidden');
  const cleanup = isolateModalBackground(container, boundarySelector);
  if (autoFocus) focusFirstElement(container);
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
  const active = container.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
