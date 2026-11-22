const INTERACTIVE_STAGE_TARGET_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
].join(',');

const LINE_SCROLL_PX = 40;
const PAGE_SCROLL_RATIO = 0.875;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isBodyFocus(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

function hasBlockingOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.querySelector(
      '.reader-shell, [data-reader-opening], [role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]',
    ),
  );
}

export function forwardStageScrollKey(event: KeyboardEvent, stage: HTMLElement | null): boolean {
  if (!stage || !stage.isConnected || event.defaultPrevented || event.isComposing) {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (event.shiftKey && event.key !== ' ') {
    return false;
  }
  if (!isBodyFocus() || hasBlockingOverlay()) {
    return false;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (
    target &&
    target !== document.body &&
    target !== document.documentElement &&
    target.closest(INTERACTIVE_STAGE_TARGET_SELECTOR)
  ) {
    return false;
  }

  const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
  const pageStep = Math.max(LINE_SCROLL_PX, Math.round(stage.clientHeight * PAGE_SCROLL_RATIO));
  let delta: number | null = null;
  let absoluteTop: number | null = null;

  switch (event.key) {
    case 'ArrowDown':
      delta = LINE_SCROLL_PX;
      break;
    case 'ArrowUp':
      delta = -LINE_SCROLL_PX;
      break;
    case 'PageDown':
      delta = pageStep;
      break;
    case 'PageUp':
      delta = -pageStep;
      break;
    case ' ':
      delta = event.shiftKey ? -pageStep : pageStep;
      break;
    case 'Home':
      absoluteTop = 0;
      break;
    case 'End':
      absoluteTop = maxScrollTop;
      break;
    default:
      return false;
  }

  event.preventDefault();
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';

  if (absoluteTop !== null) {
    if (typeof stage.scrollTo === 'function') {
      stage.scrollTo({ top: absoluteTop, behavior });
    } else if (stage.scrollTop !== absoluteTop) {
      stage.scrollTop = absoluteTop;
      stage.dispatchEvent(new Event('scroll'));
    }
    return true;
  }

  if (delta !== null) {
    if (typeof stage.scrollBy === 'function') {
      stage.scrollBy({ top: delta, behavior });
    } else {
      const nextTop = Math.max(0, Math.min(maxScrollTop, stage.scrollTop + delta));
      if (stage.scrollTop !== nextTop) {
        stage.scrollTop = nextTop;
        stage.dispatchEvent(new Event('scroll'));
      }
    }
  }

  return true;
}
