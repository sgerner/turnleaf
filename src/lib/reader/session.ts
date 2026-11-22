import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  type ReaderSearchResult,
} from './search';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';

export interface ReaderLocation {
  cfi: string;
  xpath: string | null;
  href: string;
  percentage: number;
  spineIndex: number;
  pageIndex: number;
  pageCount: number;
}

export type ReaderLinkReturnTarget = Pick<ReaderLocation, 'cfi' | 'href'>;

export type ReaderLocationOrigin = 'jump' | 'link' | 'navigation' | 'restore';

export type ReaderSwipeDirection = 'previous' | 'next';

export interface SwipeTouchPoint {
  identifier?: number;
  clientX: number;
  clientY: number;
}

export interface SwipeTouchEventLike {
  target?: EventTarget | null;
  touches?: ArrayLike<SwipeTouchPoint>;
  changedTouches?: ArrayLike<SwipeTouchPoint>;
  defaultPrevented?: boolean;
}

export interface SwipePointerEventLike {
  pointerId: number;
  pointerType?: string;
  button?: number;
  clientX: number;
  clientY: number;
  target?: EventTarget | null;
  defaultPrevented?: boolean;
}

export const SWIPE_MIN_DISTANCE_PX = 44;
export const SWIPE_MAX_DRIFT_RATIO = 0.5;
const SWIPE_CLICK_SUPPRESSION_MS = 500;
const INTERACTIVE_SWIPE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="slider"], [contenteditable="true"]';

function isInteractiveSwipeTarget(target: EventTarget | null | undefined): boolean {
  const element =
    target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
  return Boolean(element?.closest(INTERACTIVE_SWIPE_SELECTOR));
}

export function resolveSpinePercentageTarget(
  percentage: number,
  sectionCount: number,
): { sectionIndex: number; sectionProgress: number } | null {
  if (!Number.isFinite(percentage) || sectionCount <= 0) return null;
  const clamped = Math.max(0, Math.min(1, percentage));
  if (clamped >= 1) {
    return { sectionIndex: sectionCount - 1, sectionProgress: 1 };
  }
  const scaled = Math.max(0, Math.min(sectionCount - 1e-7, clamped * sectionCount + 1e-9));
  const sectionIndex = Math.floor(scaled);
  const sectionProgress = Math.max(0, Math.min(1, scaled - sectionIndex));
  return { sectionIndex, sectionProgress };
}

export function resolveSectionPageIndex(sectionProgress: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  if (!Number.isFinite(sectionProgress) || sectionProgress <= 0) return 0;
  if (sectionProgress >= 1) return safeTotal - 1;
  return Math.max(0, Math.min(safeTotal - 1, Math.floor(sectionProgress * safeTotal + 1e-6)));
}

export interface SwipeGestureTracker {
  onTouchStart: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchMove: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchEnd: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchCancel: () => void;
  onPointerDown: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerMove: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerUp: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerCancel: (event: SwipePointerEventLike) => void;
  consumeSuppressedClick: () => boolean;
  reset: () => void;
}

export function createSwipeGestureTracker(
  onSwipe: (direction: ReaderSwipeDirection) => void,
  now: () => number = () => Date.now(),
): SwipeGestureTracker {
  let touchStart: {
    id: number | undefined;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    maxDriftY: number;
    blocked: boolean;
  } | null = null;
  let touchCompletedAt = -Infinity;
  const activeTouchPointers = new Set<number>();
  let pointerStart: {
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    maxDriftY: number;
    blocked: boolean;
  } | null = null;
  let suppressClickUntil = 0;

  function evaluateSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    maxDriftY: number,
  ): ReaderSwipeDirection | null {
    const deltaX = endX - startX;
    const absX = Math.abs(deltaX);
    const absY = Math.max(Math.abs(endY - startY), maxDriftY);
    if (absX < SWIPE_MIN_DISTANCE_PX) return null;
    if (absY > absX * SWIPE_MAX_DRIFT_RATIO) return null;
    return deltaX < 0 ? 'next' : 'previous';
  }

  function findTouch(
    list: ArrayLike<SwipeTouchPoint> | undefined,
    id: number | undefined,
  ): SwipeTouchPoint | null {
    if (!list || list.length === 0) return null;
    if (id === undefined) return list[0] ?? null;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (item && item.identifier === id) return item;
    }
    return list[0] ?? null;
  }

  return {
    onTouchStart(event, hasSelection) {
      suppressClickUntil = 0;
      activeTouchPointers.clear();
      pointerStart = null;
      const touches = event.touches;
      const touchCount = touches?.length ?? 1;
      if (touchCount !== 1) {
        if (touchStart) touchStart.blocked = true;
        else {
          touchStart = {
            id: undefined,
            x: 0,
            y: 0,
            lastX: 0,
            lastY: 0,
            maxDriftY: 0,
            blocked: true,
          };
        }
        return;
      }
      const first = touches?.[0] ?? event.changedTouches?.[0];
      if (!first) return;
      const blocked =
        Boolean(event.defaultPrevented) ||
        isInteractiveSwipeTarget(event.target) ||
        Boolean(hasSelection?.());
      touchStart = {
        id: first.identifier,
        x: first.clientX,
        y: first.clientY,
        lastX: first.clientX,
        lastY: first.clientY,
        maxDriftY: 0,
        blocked,
      };
    },

    onTouchMove(event, hasSelection) {
      if (!touchStart) return;
      if ((event.touches?.length ?? 1) > 1 || hasSelection?.()) {
        touchStart.blocked = true;
        return;
      }
      const point = findTouch(event.touches ?? event.changedTouches, touchStart.id);
      if (!point) return;
      touchStart.lastX = point.clientX;
      touchStart.lastY = point.clientY;
      touchStart.maxDriftY = Math.max(touchStart.maxDriftY, Math.abs(point.clientY - touchStart.y));
    },

    onTouchEnd(event, hasSelection) {
      touchCompletedAt = now();
      if (!touchStart) return;
      const remaining = event.touches?.length ?? 0;
      if (touchStart.blocked || hasSelection?.()) {
        if (remaining === 0) touchStart = null;
        return;
      }
      if (remaining > 0) {
        touchStart.blocked = true;
        return;
      }
      const endPoint = findTouch(event.changedTouches, touchStart.id) ?? {
        clientX: touchStart.lastX,
        clientY: touchStart.lastY,
      };
      const gesture = touchStart;
      touchStart = null;
      const direction = evaluateSwipe(
        gesture.x,
        gesture.y,
        endPoint.clientX,
        endPoint.clientY,
        gesture.maxDriftY,
      );
      if (!direction) return;
      suppressClickUntil = touchCompletedAt + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },

    onTouchCancel() {
      touchStart = null;
    },

    onPointerDown(event, hasSelection) {
      if (event.pointerType !== 'touch') return;
      if (touchStart !== null || now() - touchCompletedAt < 100) return;
      suppressClickUntil = 0;
      activeTouchPointers.add(event.pointerId);
      if (activeTouchPointers.size !== 1) {
        if (pointerStart) pointerStart.blocked = true;
        return;
      }
      const blocked =
        Boolean(event.defaultPrevented) ||
        isInteractiveSwipeTarget(event.target) ||
        Boolean(hasSelection?.());
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        maxDriftY: 0,
        blocked,
      };
    },

    onPointerMove(event, hasSelection) {
      if (event.pointerType !== 'touch' || !pointerStart || touchStart !== null) return;
      if (activeTouchPointers.size > 1 || hasSelection?.()) {
        pointerStart.blocked = true;
        return;
      }
      if (event.pointerId !== pointerStart.id) return;
      pointerStart.lastX = event.clientX;
      pointerStart.lastY = event.clientY;
      pointerStart.maxDriftY = Math.max(
        pointerStart.maxDriftY,
        Math.abs(event.clientY - pointerStart.y),
      );
    },

    onPointerUp(event, hasSelection) {
      if (event.pointerType !== 'touch') return;
      activeTouchPointers.delete(event.pointerId);
      if (!pointerStart || touchStart !== null || now() - touchCompletedAt < 100) {
        if (activeTouchPointers.size === 0) pointerStart = null;
        return;
      }
      if (pointerStart.blocked || hasSelection?.() || activeTouchPointers.size > 0) {
        if (activeTouchPointers.size > 0) pointerStart.blocked = true;
        else pointerStart = null;
        return;
      }
      if (event.pointerId !== pointerStart.id) return;
      const gesture = pointerStart;
      pointerStart = null;
      const direction = evaluateSwipe(
        gesture.x,
        gesture.y,
        event.clientX,
        event.clientY,
        gesture.maxDriftY,
      );
      if (!direction) return;
      suppressClickUntil = now() + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },

    onPointerCancel(event) {
      activeTouchPointers.delete(event.pointerId);
      if (activeTouchPointers.size === 0) pointerStart = null;
      else if (pointerStart) pointerStart.blocked = true;
    },

    consumeSuppressedClick() {
      if (suppressClickUntil > 0 && now() <= suppressClickUntil) {
        suppressClickUntil = 0;
        return true;
      }
      suppressClickUntil = 0;
      return false;
    },

    reset() {
      touchStart = null;
      pointerStart = null;
      activeTouchPointers.clear();
      suppressClickUntil = 0;
    },
  };
}

export interface ReaderSelection {
  cfi: string;
  text: string;
}

export interface TocItem {
  label: string;
  href: string;
  children: TocItem[];
}

interface SpineSection {
  href: string;
  index: number;
  load: (request: (url: string) => Promise<Document>) => Promise<unknown>;
  unload: () => void;
}

interface EpubTocItem {
  label: string;
  href: string;
  subitems?: EpubTocItem[];
}

const MODE_COLORS = {
  light: {
    background: '--color-surface-50',
    text: '--color-surface-950',
    link: '--color-primary-700',
    selection: '--color-primary-200',
  },
  dark: {
    background: '--color-surface-950',
    text: '--color-surface-50',
    link: '--color-primary-300',
    selection: '--color-primary-800',
  },
} as const;

type EpubReferenceKind = 'link' | 'resource' | 'stylesheet';

const RESOURCE_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'longdesc',
  'manifest',
  'poster',
  'src',
  'xlink:href',
]);

const SAFE_DATA_IMAGE = /^data:image\/(?:gif|jpe?g|png|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const SAFE_DATA_STYLESHEET = /^data:text\/css(?:;charset=[^;,]+)?(?:;base64)?,/i;

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function decodedReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || hasUnsafeControl(trimmed)) return null;
  try {
    const decoded = decodeURIComponent(trimmed).trim();
    return hasUnsafeControl(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function isSafeEpubReference(value: string, kind: EpubReferenceKind): boolean {
  const decoded = decodedReference(value);
  if (!decoded) return false;
  if (decoded.startsWith('#')) return true;
  if (kind === 'resource' && SAFE_DATA_IMAGE.test(decoded)) return true;
  if (kind === 'stylesheet' && SAFE_DATA_STYLESHEET.test(decoded)) return true;
  if (kind !== 'link' && decoded.toLowerCase().startsWith('blob:')) return true;
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)) return false;
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return false;
  return true;
}

function sanitizeSrcset(value: string): string | null {
  const candidates = value
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const match = candidate.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match?.[1] || !isSafeEpubReference(match[1], 'resource')) return null;
      return match[2] ? `${match[1]} ${match[2]}` : match[1];
    })
    .filter((candidate): candidate is string => candidate !== null);
  return candidates.length ? candidates.join(', ') : null;
}

function sanitizeCss(value: string): string {
  const withoutRemoteImports = value.replace(
    /@import\s+(?:url\(\s*)?(?:'[^']*'|"[^"]*"|[^;\s)]+)\s*\)?\s*;?/gi,
    (statement) => {
      const match = statement.match(/(?:url\(\s*)?(['"]?)([^'"\s)]+)\1\s*\)?/i);
      return match?.[2] && isSafeEpubReference(match[2], 'resource') ? statement : '';
    },
  );
  return withoutRemoteImports.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (whole, _quote: string, url: string) => (isSafeEpubReference(url, 'resource') ? whole : 'none'),
  );
}

function isLocalContentUrl(value: string, document: Document): boolean {
  try {
    const url = new URL(value, document.baseURI);
    if (['blob:', 'file:', 'capacitor:', 'ionic:'].includes(url.protocol)) return true;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function decodeDataStylesheet(value: string): string | null {
  if (!SAFE_DATA_STYLESHEET.test(value)) return null;
  const separator = value.indexOf(',');
  const metadata = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 1);
  try {
    if (metadata.endsWith(';base64')) return atob(body);
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

type StylesheetCache = Map<string, Promise<string | null>>;

async function loadLocalStylesheet(url: URL, cache: StylesheetCache): Promise<string | null> {
  const key = url.href;
  const existing = cache.get(key);
  if (existing) return existing;
  const request = fetch(url)
    .then(async (response) => (response.ok ? sanitizeCss(await response.text()) : null))
    .catch(() => null);
  if (cache.size >= 32) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, request);
  const stylesheet = await request;
  if (stylesheet === null && cache.get(key) === request) cache.delete(key);
  return stylesheet;
}

async function sanitizeStylesheets(document: Document, cache: StylesheetCache): Promise<void> {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[href]')].filter((link) =>
    (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'),
  );
  await Promise.all(
    links.map(async (link) => {
      const href = link.getAttribute('href') ?? '';
      const style = document.createElement('style');
      link.replaceWith(style);
      const embedded = decodeDataStylesheet(href);
      const stylesheet = embedded
        ? sanitizeCss(embedded)
        : isLocalContentUrl(href, document)
          ? await loadLocalStylesheet(new URL(href, document.baseURI), cache)
          : null;
      if (stylesheet) style.textContent = stylesheet;
      else style.remove();
    }),
  );
}

function installEpubContentPolicy(document: Document): void {
  const head =
    document.head ??
    document.documentElement.insertBefore(
      document.createElement('head'),
      document.documentElement.firstChild,
    );
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute(
    'content',
    [
      "default-src 'none'",
      "base-uri 'self'",
      "connect-src 'none'",
      "font-src 'self' data: blob:",
      "frame-src 'none'",
      "img-src 'self' data: blob:",
      "manifest-src 'none'",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "script-src 'none'",
      "style-src 'self' 'unsafe-inline' data: blob:",
      "worker-src 'none'",
    ].join('; '),
  );
  head.prepend(policy);
}

function isSafeBaseReference(value: string, document: Document): boolean {
  const decoded = decodedReference(value);
  if (!decoded) return false;
  if (!/^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    return !decoded.startsWith('/') && !decoded.startsWith('\\');
  }
  return isLocalContentUrl(decoded, document);
}

export async function sanitizeEpubDocument(
  document: Document,
  stylesheetCache: StylesheetCache = new Map(),
): Promise<void> {
  document.querySelectorAll('base').forEach((base) => {
    const href = base.getAttribute('href') ?? '';
    if (!isSafeBaseReference(href, document)) base.remove();
  });
  document
    .querySelectorAll('script, iframe, object, embed, form, meta[http-equiv]')
    .forEach((node) => node.remove());

  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'ping') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'srcset' || name === 'imagesrcset') {
        const safeSrcset = sanitizeSrcset(attribute.value);
        if (safeSrcset) element.setAttribute(attribute.name, safeSrcset);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style') {
        const safeStyle = sanitizeCss(attribute.value);
        if (safeStyle) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (element.localName === 'base' && name === 'href') continue;
      if (!RESOURCE_ATTRIBUTES.has(name)) continue;
      const isStylesheet =
        name === 'href' &&
        element.localName === 'link' &&
        (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet');
      const kind =
        name === 'href' && ['a', 'area'].includes(element.localName)
          ? 'link'
          : isStylesheet
            ? 'stylesheet'
            : 'resource';
      if (!isSafeEpubReference(attribute.value, kind)) element.removeAttribute(attribute.name);
    }
  });

  document.querySelectorAll('style').forEach((style) => {
    const safeStyle = sanitizeCss(style.textContent ?? '');
    style.textContent = safeStyle;
  });
  await sanitizeStylesheets(document, stylesheetCache);
  installEpubContentPolicy(document);
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private contentTouchStart: ((event: TouchEvent, contents: Contents) => void) | null = null;
  private contentTouchMove: ((event: TouchEvent, contents: Contents) => void) | null = null;
  private contentTouchEnd: ((event: TouchEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private cleanupViewportGestures: (() => void) | null = null;
  private swipeTracker: SwipeGestureTracker | null = null;
  private current: Location | null = null;
  private deferringRelocation = false;
  private deferredRelocation: Location | null = null;
  private spine: { sections: SpineSection[]; indexes: Map<string, number> } | null = null;
  private locationGeneration = 0;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private userNavigationOrigin: ReaderLocationOrigin = 'navigation';
  private pendingLinkReturnTarget: ReaderLinkReturnTarget | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewportSize: { width: number; height: number } | null = null;
  private highlightCfis = new Set<string>();
  private onLocation:
    | ((
        location: ReaderLocation,
        origin: ReaderLocationOrigin,
        returnTarget?: ReaderLinkReturnTarget,
      ) => void)
    | null = null;
  private onSelection: ((selection: ReaderSelection | null) => void) | undefined = undefined;

  constructor(private readonly bookUrl: string) {
    this.book = ePub(bookUrl);
  }

  async open(
    target: HTMLElement,
    cfi: string | null,
    serverXPath: string | null,
    serverPercentage: number | null,
    appearance: Appearance,
    onLocation: (
      location: ReaderLocation,
      origin: ReaderLocationOrigin,
      returnTarget?: ReaderLinkReturnTarget,
    ) => void,
    onTap: (zone: 'previous' | 'center' | 'next') => void,
    onSelection?: (selection: ReaderSelection | null) => void,
    onKeyboardNavigation?: (event: KeyboardEvent) => void,
    onSwipe?: (direction: ReaderSwipeDirection) => void,
  ): Promise<void> {
    this.rendition = this.book.renderTo(target, {
      width: '100%',
      height: '100%',
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      resizeOnOrientationChange: true,
      allowScriptedContent: false,
    });
    this.observeViewport(target);
    const swipeTracker = createSwipeGestureTracker((direction) => {
      if (onSwipe) {
        onSwipe(direction);
        return;
      }
      if (direction === 'next') void this.next().catch(() => {});
      else void this.previous().catch(() => {});
    });
    this.swipeTracker = swipeTracker;
    const hasContentSelection = (contents?: Contents): boolean => {
      const selection = contents?.window?.getSelection?.();
      return Boolean(selection && !selection.isCollapsed);
    };
    const hasWindowSelection = (): boolean => {
      const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
      return Boolean(selection && !selection.isCollapsed);
    };
    this.rendition.hooks.content.register((contents: Contents) => this.harden(contents));
    if (onSelection) {
      this.rendition.hooks.content.register((contents: Contents) => {
        const handler = () => {
          const selection = contents.window.getSelection();
          if (!selection || selection.isCollapsed || !selection.rangeCount) {
            onSelection(null);
            return;
          }
          const text = selection.toString().replace(/\s+/g, ' ').trim();
          if (!text) {
            onSelection(null);
            return;
          }
          try {
            onSelection({ cfi: contents.cfiFromRange(selection.getRangeAt(0)), text });
          } catch {
            // Selection can change while a section is being replaced.
          }
        };
        contents.document.addEventListener('selectionchange', handler);
      });
    }
    this.rendition.hooks.content.register((contents: Contents) => {
      const doc = contents?.document;
      if (!doc?.addEventListener) return;
      doc.addEventListener('touchcancel', () => swipeTracker.onTouchCancel(), { passive: true });
      doc.addEventListener(
        'pointerdown',
        (event: PointerEvent) =>
          swipeTracker.onPointerDown(event, () => hasContentSelection(contents)),
        { passive: true },
      );
      doc.addEventListener(
        'pointermove',
        (event: PointerEvent) =>
          swipeTracker.onPointerMove(event, () => hasContentSelection(contents)),
        { passive: true },
      );
      doc.addEventListener(
        'pointerup',
        (event: PointerEvent) =>
          swipeTracker.onPointerUp(event, () => hasContentSelection(contents)),
        { passive: true },
      );
      doc.addEventListener(
        'pointercancel',
        (event: PointerEvent) => swipeTracker.onPointerCancel(event),
        { passive: true },
      );
    });
    this.onLocation = onLocation;
    this.onSelection = onSelection;
    this.relocated = (location) => {
      if (this.deferringRelocation) {
        this.current = location;
        this.deferredRelocation = location;
        return;
      }
      this.handleRelocated(location);
    };
    this.rendition.on('relocated', this.relocated);
    this.contentTouchStart = (event, contents) => {
      swipeTracker.onTouchStart(event, () => hasContentSelection(contents));
    };
    this.contentTouchMove = (event, contents) => {
      swipeTracker.onTouchMove(event, () => hasContentSelection(contents));
    };
    this.contentTouchEnd = (event, contents) => {
      swipeTracker.onTouchEnd(event, () => hasContentSelection(contents));
    };
    this.rendition.on('touchstart', this.contentTouchStart);
    this.rendition.on('touchmove', this.contentTouchMove);
    this.rendition.on('touchend', this.contentTouchEnd);
    this.attachViewportGestures(target, swipeTracker, hasWindowSelection);
    this.contentClick = (event, contents) => {
      if (swipeTracker.consumeSuppressedClick()) {
        event.preventDefault?.();
        return;
      }
      const eventTarget = event.target as Element | null;
      const selection = contents.window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const link = eventTarget?.closest?.('a') as HTMLAnchorElement | null;
      if (link) {
        const href = link.getAttribute('href') ?? '';
        if (isSafeEpubReference(href, 'link')) this.beginLinkedNavigation();
        return;
      }
      if (
        event.defaultPrevented ||
        eventTarget?.closest?.('button, input, select, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      const frame = contents.window.frameElement;
      const viewport = target.getBoundingClientRect();
      if (!frame || viewport.width === 0) return;
      // EPUB.js lays out multiple pages in one iframe and scrolls it past the viewport.
      const position =
        (frame.getBoundingClientRect().left + event.clientX - viewport.left) / viewport.width;
      onTap(position < 0.33 ? 'previous' : position > 0.67 ? 'next' : 'center');
    };
    this.rendition.on('click', this.contentClick);
    if (onKeyboardNavigation) {
      this.keyboardNavigation = onKeyboardNavigation;
      this.rendition.on('keydown', this.keyboardNavigation);
    }
    this.applyAppearance(appearance);
    const restoreGeneration = this.beginLocationOperation(false);
    await this.rendition.started;
    if (!this.isCurrentLocationOperation(restoreGeneration)) return;
    if (cfi) {
      try {
        if (await this.displayAtGeneration(cfi, restoreGeneration)) return;
      } catch {
        // A saved CFI can name a section removed in a newer copy of the EPUB.
      }
    }
    if (serverXPath && (await this.displayXPath(serverXPath, restoreGeneration))) return;
    if (
      serverPercentage &&
      serverPercentage > 0 &&
      (await this.displayPercentage(serverPercentage, restoreGeneration))
    ) {
      return;
    }
    await this.displayAtGeneration(undefined, restoreGeneration);
  }

  private reportLocation(
    location: Location,
    origin: ReaderLocationOrigin,
    returnTarget: ReaderLinkReturnTarget | null = null,
  ): void {
    if (!this.onLocation) return;
    const start = location.start;
    const { sections, indexes } = this.getSpine();
    const sectionCount = Math.max(1, sections.length);
    const sectionIndex = indexes.get(start.href) ?? 0;
    const pageIndex = this.pageIndex(start.displayed.page);
    const sectionProgress = pageIndex / Math.max(1, start.displayed.total);
    const semanticPercentage = (sectionIndex + sectionProgress) / sectionCount;
    const reported: ReaderLocation = {
      ...start,
      percentage: semanticPercentage,
      spineIndex: start.index,
      pageIndex,
      pageCount: start.displayed.total,
      xpath: this.cfiToXPath(start.cfi, start.index),
    };
    if (returnTarget) {
      this.onLocation(reported, origin, returnTarget);
    } else {
      this.onLocation(reported, origin);
    }
  }

  async next(): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.navigate(() => this.rendition!.next());
  }

  async previous(): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.navigate(() => this.rendition!.prev());
  }

  tableOfContents(): TocItem[] {
    const mapItems = (items: EpubTocItem[]): TocItem[] =>
      items.map((item) => ({
        label: item.label,
        href: item.href,
        children: mapItems(item.subitems ?? []),
      }));

    return mapItems(this.book.navigation.toc);
  }

  updateHighlights(annotations: Array<{ cfi: string }>): void {
    const rendition = this.rendition;
    if (!rendition) return;

    const next = new Set(annotations.map((annotation) => annotation.cfi));
    for (const cfi of this.highlightCfis) {
      if (!next.has(cfi)) rendition.annotations.remove(cfi, 'highlight');
    }

    const applied = new Set<string>();
    for (const cfi of next) {
      if (this.highlightCfis.has(cfi)) {
        applied.add(cfi);
        continue;
      }
      try {
        rendition.annotations.highlight(cfi, {}, undefined, 'turnleaf-highlight', {
          fill: '#facc15',
          'fill-opacity': '0.38',
        });
        applied.add(cfi);
      } catch {
        // A saved CFI can stop matching after an EPUB is replaced or changed.
      }
    }
    this.highlightCfis = applied;
  }

  async search(query: string, signal?: AbortSignal, limit = 100): Promise<ReaderSearchResult[]> {
    const normalizedQuery = normalizeReaderSearchQuery(query);
    if (!normalizedQuery) return [];
    const results: ReaderSearchResult[] = [];
    const { sections } = this.getSpine();
    const request = this.book.load.bind(this.book) as (url: string) => Promise<Document>;

    for (const section of sections) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const wasLoaded = Boolean((section as unknown as { contents?: unknown }).contents);
      try {
        await section.load(request);
        const matches = (
          section as unknown as {
            search: (value: string) => Array<{ cfi: string; excerpt: string }>;
          }
        ).search(normalizedQuery);
        for (const match of matches) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!match.cfi) continue;
          results.push({
            cfi: match.cfi,
            excerpt: clipReaderSearchExcerpt(match.excerpt),
            href: section.href,
            spineIndex: section.index,
          });
          if (results.length >= limit) return results;
        }
      } finally {
        if (!wasLoaded) section.unload();
      }
    }
    return results;
  }

  async display(href: string): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.navigate(() => this.rendition!.display(href));
  }

  async displayCfi(cfi: string): Promise<boolean> {
    if (!this.rendition) return false;
    try {
      await this.navigate(() => this.rendition!.display(cfi));
      return true;
    } catch {
      return false;
    }
  }

  displayServerLocation(xpath: string): Promise<boolean> {
    return this.displayXPath(xpath, this.beginLocationOperation(false));
  }

  displayServerPercentage(percentage: number): Promise<boolean> {
    return this.displayPercentage(percentage, this.beginLocationOperation(false));
  }

  async jumpToPercentage(percentage: number): Promise<boolean> {
    if (!this.rendition || !Number.isFinite(percentage)) return false;
    const generation = this.beginJumpOperation();
    const moved = await this.displayPercentage(percentage, generation);
    if (!moved && this.isCurrentLocationOperation(generation)) {
      this.clearPendingUserNavigation();
    }
    return moved;
  }

  async jumpToPage(pageNumber: number): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !Number.isFinite(pageNumber) || pageNumber < 1) return false;
    const generation = this.beginJumpOperation();
    try {
      const currentLocation = await this.resolveRenderedLocation();
      if (!this.isCurrentLocationOperation(generation)) return false;
      const totalPages = Math.max(1, currentLocation?.start?.displayed?.total ?? 1);
      const targetPageIndex = Math.max(0, Math.min(totalPages - 1, Math.floor(pageNumber) - 1));
      await this.moveToSectionPage(targetPageIndex, totalPages, generation, true);
      return this.isCurrentLocationOperation(generation);
    } catch {
      if (this.isCurrentLocationOperation(generation)) {
        this.clearPendingUserNavigation();
      }
      return false;
    }
  }

  applyAppearance(value: Appearance): void {
    const previous = this.appearance;
    this.appearance = { ...value };
    const rendition = this.rendition;
    if (!rendition) return;
    const themeChanged =
      !previous ||
      previous.mode !== value.mode ||
      previous.fontFamily !== value.fontFamily ||
      previous.fontSize !== value.fontSize ||
      previous.lineHeight !== value.lineHeight ||
      previous.margin !== value.margin ||
      previous.bottomMargin !== value.bottomMargin ||
      previous.paragraphSpacing !== value.paragraphSpacing ||
      previous.alignment !== value.alignment ||
      previous.hyphenation !== value.hyphenation;
    const layoutChanged =
      previous !== null &&
      (previous.fontFamily !== value.fontFamily ||
        previous.fontSize !== value.fontSize ||
        previous.lineHeight !== value.lineHeight ||
        previous.margin !== value.margin ||
        previous.bottomMargin !== value.bottomMargin ||
        previous.paragraphSpacing !== value.paragraphSpacing ||
        previous.alignment !== value.alignment ||
        previous.hyphenation !== value.hyphenation);
    if (!themeChanged) return;
    const colors = MODE_COLORS[value.mode];
    const family =
      value.fontFamily === 'book'
        ? 'Iowan Old Style, Georgia, serif'
        : value.fontFamily === 'accessible'
          ? 'Atkinson Hyperlegible, Verdana, sans-serif'
          : 'Avenir Next, Segoe UI, sans-serif';
    rendition.themes.register('turnleaf', {
      html: {
        background: `${this.resolveToken(colors.background)} !important`,
        'box-sizing': 'border-box',
      },
      body: {
        color: `${this.resolveToken(colors.text)} !important`,
        background: `${this.resolveToken(colors.background)} !important`,
        'font-family': `${family} !important`,
        'font-size': `${value.fontSize}px !important`,
        'line-height': `${value.lineHeight} !important`,
        padding: `0.5rem max(${value.margin}px, env(safe-area-inset-right)) max(${value.bottomMargin}px, env(safe-area-inset-bottom)) max(${value.margin}px, env(safe-area-inset-left)) !important`,
        'box-sizing': 'border-box',
      },
      p: {
        'margin-bottom': `${value.paragraphSpacing}em !important`,
        'text-align': `${value.alignment} !important`,
        hyphens: value.hyphenation ? 'auto' : 'none',
      },
      'img, svg, video, canvas, table, pre, blockquote': {
        'max-width': '100% !important',
      },
      img: {
        height: 'auto !important',
      },
      a: { color: `${this.resolveToken(colors.link)} !important` },
      '::selection': { background: `${this.resolveToken(colors.selection)} !important` },
    });
    rendition.themes.select('turnleaf');
    if (!layoutChanged) return;
    const cfi = this.current?.start.cfi ?? rendition.location?.start.cfi ?? null;
    if (!cfi) return;
    if (this.userNavigationPending) {
      this.reflowPending = true;
      return;
    }
    this.preserveCfi(cfi, this.locationGeneration);
  }

  destroy(): void {
    this.locationGeneration += 1;
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    if (this.rendition && this.contentTouchStart)
      this.rendition.off('touchstart', this.contentTouchStart);
    if (this.rendition && this.contentTouchMove)
      this.rendition.off('touchmove', this.contentTouchMove);
    if (this.rendition && this.contentTouchEnd)
      this.rendition.off('touchend', this.contentTouchEnd);
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.cleanupViewportGestures?.();
    this.cleanupViewportGestures = null;
    this.swipeTracker?.reset();
    this.swipeTracker = null;
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportSize = null;
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.contentTouchStart = null;
    this.contentTouchMove = null;
    this.contentTouchEnd = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.onSelection = undefined;
    this.current = null;
    this.deferringRelocation = false;
    this.deferredRelocation = null;
    this.userNavigationStartCfi = null;
    this.appearance = null;
    this.highlightCfis.clear();
    this.reflowPending = false;
    this.spine = null;
    this.stylesheetCache.clear();
    // EPUB.js 0.3 revokes its archive cache's keys, which are file paths.
    const book = this.book as typeof this.book & {
      archive?: { urlCache?: Record<string, string> };
      resources?: { replacementUrls?: string[] };
    };
    const urls = new Set([
      ...Object.values(book.archive?.urlCache ?? {}),
      ...(book.resources?.replacementUrls ?? []),
    ]);
    for (const url of urls) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.book.destroy();
  }

  private harden(contents: Contents): Promise<void> {
    return sanitizeEpubDocument(contents.document, this.stylesheetCache);
  }

  private observeViewport(target: HTMLElement): void {
    const initial = target.getBoundingClientRect();
    this.viewportSize = { width: Math.floor(initial.width), height: Math.floor(initial.height) };
    if (typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this.rendition) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (!width || !height) return;
      if (this.viewportSize?.width === width && this.viewportSize.height === height) return;
      this.viewportSize = { width, height };
      this.rendition.resize(width, height);
    });
    this.resizeObserver.observe(target);
  }

  private cfiToXPath(cfi: string, spineIndex: number): string | null {
    try {
      if (!this.rendition) return null;
      const range = this.rendition.getRange(cfi);
      let element =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      if (!element) return null;
      const parts: string[] = [];
      while (element && element.localName !== 'body' && element.localName !== 'html') {
        const tag = element.localName;
        let index = 1;
        for (
          let sibling = element.previousElementSibling;
          sibling;
          sibling = sibling.previousElementSibling
        ) {
          if (sibling.localName === tag) index += 1;
        }
        parts.push(`${tag}[${index}]`);
        element = element.parentElement;
      }
      return toKavitaXPath(`/${parts.reverse().join('/')}`, spineIndex);
    } catch {
      return null;
    }
  }

  private async displayAtGeneration(
    target: string | undefined,
    generation: number,
  ): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    if (target === undefined) await rendition.display();
    else await rendition.display(target);
    return this.isCurrentLocationOperation(generation);
  }

  private async displayXPath(xpath: string, generation: number): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    const target = parseKavitaXPath(xpath);
    if (!target) return false;
    const section = this.getSpine().sections[target.spineIndex];
    if (!section) return false;
    try {
      await rendition.display(section.href);
      if (!this.isCurrentLocationOperation(generation)) return false;
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return false;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return false;
      const range = contents.document.createRange();
      range.selectNodeContents(node);
      await rendition.display(contents.cfiFromRange(range));
      return this.isCurrentLocationOperation(generation);
    } catch {
      // A server XPath from a changed EPUB is not safe to guess around.
      return false;
    }
  }

  private async displayPercentage(percentage: number, generation: number): Promise<boolean> {
    if (!Number.isFinite(percentage) || !this.isCurrentLocationOperation(generation)) return false;
    const { sections } = this.getSpine();
    const target = resolveSpinePercentageTarget(percentage, sections.length);
    if (!target) return false;
    const section = sections[target.sectionIndex];
    if (!section) return false;

    this.deferringRelocation = true;
    this.deferredRelocation = null;
    try {
      if (!(await this.displayAtGeneration(section.href, generation))) return false;
      const rendered = await this.resolveRenderedLocation(section.href);
      if (!this.isCurrentLocationOperation(generation)) return false;
      const totalPages = Math.max(1, rendered?.start?.displayed?.total ?? 1);
      const targetPageIndex = resolveSectionPageIndex(target.sectionProgress, totalPages);
      if (targetPageIndex > 0) {
        const needsReportLocation =
          this.deferredRelocation !== null || !(this.rendition && '_display' in this.rendition);
        this.deferredRelocation = null;
        this.deferringRelocation = false;
        await this.moveToSectionPage(targetPageIndex, totalPages, generation, needsReportLocation);
      }
      return this.isCurrentLocationOperation(generation);
    } catch {
      return false;
    } finally {
      const pending = this.deferredRelocation;
      this.deferringRelocation = false;
      this.deferredRelocation = null;
      if (pending && this.isCurrentLocationOperation(generation)) {
        this.handleRelocated(pending);
      }
    }
  }

  private async resolveRenderedLocation(expectedHref?: string): Promise<Location | null> {
    const rendition = this.rendition as
      | (Omit<Rendition, 'currentLocation'> & {
          currentLocation?: () => Location | Promise<Location> | undefined;
        })
      | null;
    if (!rendition) return null;
    try {
      const located = await Promise.resolve(rendition.currentLocation?.());
      if (located?.start && (!expectedHref || located.start.href === expectedHref)) {
        return located;
      }
    } catch {
      // Fall back to the rendition's cached location if currentLocation fails.
    }
    if (
      rendition.location?.start &&
      (!expectedHref || rendition.location.start.href === expectedHref)
    ) {
      return rendition.location;
    }
    if (this.current?.start && (!expectedHref || this.current.start.href === expectedHref)) {
      return this.current;
    }
    return null;
  }

  private async moveToSectionPage(
    targetPageIndex: number,
    totalPages: number,
    generation: number,
    needsReportLocation: boolean,
  ): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return;

    const current = await this.resolveRenderedLocation();
    const currentPageIndex = current?.start ? this.pageIndex(current.start.displayed.page) : 0;
    if (targetPageIndex === currentPageIndex) {
      if (current && this.userNavigationPending) {
        this.handleRelocated(current);
      }
      return;
    }

    const manager = (
      rendition as unknown as {
        manager?: {
          layout?: { delta?: number };
          views?: { first?: () => { width?: () => number } | undefined };
          moveTo?: (offset: { left: number; top: number }, width?: number) => void;
        };
      }
    ).manager;

    const delta = manager?.layout?.delta ?? 0;
    if (delta > 0 && typeof manager?.moveTo === 'function') {
      const viewWidth = manager.views?.first?.()?.width?.() ?? totalPages * delta;
      manager.moveTo({ left: targetPageIndex * delta, top: 0 }, viewWidth);
      if (needsReportLocation) {
        await rendition.reportLocation?.();
      }
      return;
    }

    const steps = targetPageIndex - currentPageIndex;
    const stepFn = steps > 0 ? rendition.next?.bind(rendition) : rendition.prev?.bind(rendition);
    if (!stepFn) return;

    const stepCount = Math.abs(steps);
    for (let step = 0; step < stepCount; step += 1) {
      if (!this.isCurrentLocationOperation(generation)) return;
      const isLastStep = step === stepCount - 1;
      this.deferringRelocation = !isLastStep;
      this.deferredRelocation = null;
      try {
        await stepFn();
      } finally {
        this.deferringRelocation = false;
        this.deferredRelocation = null;
      }
    }
  }

  private handleRelocated(location: Location): void {
    const startCfi = this.userNavigationStartCfi ?? this.current?.start.cfi ?? null;
    const isUserNavigation =
      this.userNavigationPending &&
      (startCfi ? startCfi !== location.start.cfi : !this.reflowPending);
    const origin = isUserNavigation ? this.userNavigationOrigin : 'restore';
    const returnTarget =
      origin === 'link' || origin === 'jump' ? this.pendingLinkReturnTarget : null;
    if (startCfi !== location.start.cfi) this.onSelection?.(null);
    this.current = location;
    if (
      isUserNavigation ||
      this.userNavigationOrigin === 'link' ||
      this.userNavigationOrigin === 'jump'
    ) {
      this.clearPendingUserNavigation();
    }
    this.reportLocation(location, origin, returnTarget);
    if (this.reflowPending) {
      this.reflowPending = false;
      this.preserveCfi(location.start.cfi, this.locationGeneration);
    }
  }

  private attachViewportGestures(
    target: HTMLElement,
    swipeTracker: SwipeGestureTracker,
    hasSelection: () => boolean,
  ): void {
    this.cleanupViewportGestures?.();
    const onTouchStart = (event: TouchEvent) => swipeTracker.onTouchStart(event, hasSelection);
    const onTouchMove = (event: TouchEvent) => swipeTracker.onTouchMove(event, hasSelection);
    const onTouchEnd = (event: TouchEvent) => swipeTracker.onTouchEnd(event, hasSelection);
    const onTouchCancel = () => swipeTracker.onTouchCancel();
    const onPointerDown = (event: PointerEvent) => swipeTracker.onPointerDown(event, hasSelection);
    const onPointerMove = (event: PointerEvent) => swipeTracker.onPointerMove(event, hasSelection);
    const onPointerUp = (event: PointerEvent) => swipeTracker.onPointerUp(event, hasSelection);
    const onPointerCancel = (event: PointerEvent) => swipeTracker.onPointerCancel(event);
    const onClickCapture = (event: MouseEvent) => {
      if (!swipeTracker.consumeSuppressedClick()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    target.addEventListener('touchstart', onTouchStart, { passive: true });
    target.addEventListener('touchmove', onTouchMove, { passive: true });
    target.addEventListener('touchend', onTouchEnd, { passive: true });
    target.addEventListener('touchcancel', onTouchCancel, { passive: true });
    target.addEventListener('pointerdown', onPointerDown, { passive: true });
    target.addEventListener('pointermove', onPointerMove, { passive: true });
    target.addEventListener('pointerup', onPointerUp, { passive: true });
    target.addEventListener('pointercancel', onPointerCancel, { passive: true });
    target.addEventListener('click', onClickCapture, true);

    this.cleanupViewportGestures = () => {
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchCancel);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerCancel);
      target.removeEventListener('click', onClickCapture, true);
    };
  }

  private clearPendingUserNavigation(): void {
    this.userNavigationPending = false;
    this.userNavigationStartCfi = null;
    this.userNavigationOrigin = 'navigation';
    this.pendingLinkReturnTarget = null;
  }

  private beginJumpOperation(): number {
    const start = this.current?.start ?? this.rendition?.location?.start ?? null;
    this.locationGeneration += 1;
    this.userNavigationPending = true;
    this.userNavigationOrigin = 'jump';
    this.userNavigationStartCfi = start?.cfi ?? null;
    this.pendingLinkReturnTarget = start ? { cfi: start.cfi, href: start.href } : null;
    return this.locationGeneration;
  }

  private async navigate(display: () => Promise<unknown>): Promise<void> {
    const generation = this.beginLocationOperation(true);
    try {
      await display();
    } catch (error) {
      if (this.isCurrentLocationOperation(generation)) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
      throw error;
    }
  }

  private beginLocationOperation(userNavigation: boolean): number {
    this.locationGeneration += 1;
    this.userNavigationPending = userNavigation;
    this.userNavigationOrigin = userNavigation ? 'navigation' : 'restore';
    this.pendingLinkReturnTarget = null;
    this.userNavigationStartCfi = userNavigation
      ? (this.current?.start.cfi ?? this.rendition?.location?.start.cfi ?? null)
      : null;
    return this.locationGeneration;
  }

  private beginLinkedNavigation(): void {
    const start = this.current?.start ?? this.rendition?.location?.start;
    if (!start) return;
    this.locationGeneration += 1;
    this.userNavigationPending = true;
    this.userNavigationStartCfi = start.cfi;
    this.userNavigationOrigin = 'link';
    this.pendingLinkReturnTarget = { cfi: start.cfi, href: start.href };
  }

  private isCurrentLocationOperation(generation: number): boolean {
    return generation === this.locationGeneration && this.rendition !== null;
  }

  private preserveCfi(cfi: string, generation: number): void {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation) || this.userNavigationPending) {
      return;
    }
    void rendition.display(cfi).catch(() => {
      // The current passage may disappear while a reflow is being applied.
    });
  }

  private getSpine(): NonNullable<ReaderSession['spine']> {
    if (this.spine) return this.spine;
    const sections: SpineSection[] = [];
    const indexes = new Map<string, number>();
    this.book.spine.each((section: SpineSection) => {
      if (!indexes.has(section.href)) indexes.set(section.href, sections.length);
      sections.push(section);
    });
    this.spine = { sections, indexes };
    return this.spine;
  }

  private pageIndex(page: number): number {
    return Math.max(0, page - 1);
  }

  private resolveToken(token: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || token;
  }
}
