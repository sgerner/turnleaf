import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  type ReaderSearchResult,
} from './search';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';
import {
  createSpineHrefLookup,
  matchSpineHref,
  resolveDisplayHref,
  resolveTocHref,
  type TocItem,
} from './toc';

export type { TocItem } from './toc';

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

export type ReaderLocationOrigin = 'link' | 'navigation' | 'restore';

export interface ReaderSelection {
  cfi: string;
  text: string;
}

export type ReaderKeyboardAction = 'next' | 'previous' | 'clear-selection' | null;

export function resolveReaderKeyboardAction(
  event: KeyboardEvent,
  options: { hasOpenPanel?: boolean; hasSelection?: boolean } = {},
): ReaderKeyboardAction {
  if (event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (options.hasOpenPanel) return null;
  if (event.key === 'Escape') {
    return options.hasSelection ? 'clear-selection' : null;
  }
  const target = event.target as Element | null;
  if (target?.closest?.('button, a, input, select, textarea, [contenteditable="true"]')) {
    return null;
  }
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') return 'previous';
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') return 'next';
  return null;
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
const PASSAGE_BLOCK_SELECTOR = 'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dt, dd, figcaption';
const FOCUSABLE_LINK_SELECTOR = 'a[href], area[href]';
const SAVED_TABINDEX_ATTR = 'data-turnleaf-tabindex';
const VIEWPORT_RECT_EPSILON = 0.5;

function normalizePassageText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function mergeCfiRange(startCfi: string, endCfi?: string | null): string {
  if (!endCfi || startCfi === endCfi) return startCfi;
  if (
    !startCfi.startsWith('epubcfi(') ||
    !startCfi.endsWith(')') ||
    !endCfi.startsWith('epubcfi(') ||
    !endCfi.endsWith(')')
  ) {
    return startCfi;
  }
  const startParts = startCfi.slice(8, -1).split('!');
  const endParts = endCfi.slice(8, -1).split('!');
  if (startParts.length !== 2 || endParts.length !== 2) return startCfi;
  const [startBase, startPath] = startParts;
  const [endBase, endPath] = endParts;
  if (
    !startBase ||
    startBase !== endBase ||
    !startPath ||
    !endPath ||
    startPath.includes(',') ||
    endPath.includes(',')
  ) {
    return startCfi;
  }
  const startSteps = startPath.split('/').filter(Boolean);
  const endSteps = endPath.split('/').filter(Boolean);
  if (startSteps.length === 0 || endSteps.length === 0) return startCfi;
  let commonLength = 0;
  while (
    commonLength < startSteps.length - 1 &&
    commonLength < endSteps.length - 1 &&
    startSteps[commonLength] === endSteps[commonLength]
  ) {
    commonLength += 1;
  }
  const common = commonLength > 0 ? `/${startSteps.slice(0, commonLength).join('/')}` : '';
  const startRel = `/${startSteps.slice(commonLength).join('/')}`;
  const endRel = `/${endSteps.slice(commonLength).join('/')}`;
  return `epubcfi(${startBase}!${common},${startRel},${endRel})`;
}

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

interface PaginatedManagerView {
  section: { index: number; href: string; cfiBase: string };
  position: () => DOMRect;
  width: () => number;
  contents: unknown;
  expand?: () => void;
}

interface PaginatedRuntimeManager {
  isPaginated?: boolean;
  settings?: {
    axis?: string;
    direction?: string;
    fullsize?: boolean;
  };
  layout?: {
    delta?: number;
    width?: number;
    pageWidth?: number;
    count?: (width: number) => { pages: number };
  };
  stage?: {
    resizeFunc?: EventListener;
    orientationChangeFunc?: EventListener;
  };
  container?: HTMLElement;
  views?: {
    length?: number;
    all?: () => Array<{ expand?: () => void }>;
  };
  mapping?: {
    page?: (contents: unknown, cfiBase: string, start: number, end: number) => unknown;
  };
  visible?: () => PaginatedManagerView[];
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  clear?: () => void;
  moveTo?: (offset: { left: number; top: number }, width?: number) => void;
  scrollTo?: (x: number, y: number, silent?: boolean) => void;
  next?: () => Promise<unknown> | undefined;
  prev?: () => Promise<unknown> | undefined;
  paginatedLocation?: () => unknown[];
}

const patchedManagers = new WeakSet<object>();

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
  private attached: (() => void) | null = null;
  private rendered: ((section: unknown, view: object) => void) | null = null;
  private removed: ((section: unknown, view: object) => void) | null = null;
  private viewAdded: ((...args: unknown[]) => void) | null = null;
  private viewResized: ((...args: unknown[]) => void) | null = null;
  private observedManager: PaginatedRuntimeManager | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private current: Location | null = null;
  private spine: {
    sections: SpineSection[];
    indexes: Map<string, number>;
    hrefs: Map<string, string>;
  } | null = null;
  private locationGeneration = 0;
  private currentOperationIsUserNavigation = false;
  private lastUserNavigationFromCfi: string | null = null;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private userNavigationOrigin: ReaderLocationOrigin = 'navigation';
  private pendingLinkReturnTarget: ReaderLinkReturnTarget | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewportSize: { width: number; height: number } | null = null;
  private pendingViewportSize: { width: number; height: number } | null = null;
  private resizeDrain: Promise<void> | null = null;
  private activeNavigation: Promise<void> | null = null;
  private restoreTarget: { cfi?: string; href?: string } | null = null;
  private pendingContentWork = new Set<Promise<void>>();
  private contentObservers = new Map<Document, MutationObserver>();
  private pendingViewRenders = new Map<object, { promise: Promise<void>; resolve: () => void }>();
  private viewportTarget: HTMLElement | null = null;
  private epubContainer: HTMLElement | null = null;
  private lockedScrollLeft = 0;
  private displayOperationCount = 0;
  private aligningFocusTarget: Element | null = null;
  private resizedListener: (() => void) | null = null;
  private unloadedHookRegistered = false;
  private readonly trackedContents = new Set<Contents>();
  private readonly contentCleanups = new Map<Contents, Array<() => void>>();
  private highlightCfis = new Set<string>();
  private onLocation:
    | ((
        location: ReaderLocation,
        origin: ReaderLocationOrigin,
        returnTarget?: ReaderLinkReturnTarget,
      ) => void)
    | null = null;

  private readonly handleContainerScroll = (): void => {
    const container = this.epubContainer;
    if (!container) return;
    if (this.isProgrammaticScrollAllowed()) {
      this.lockedScrollLeft = container.scrollLeft;
      return;
    }
    if (container.scrollLeft !== this.lockedScrollLeft) {
      container.scrollLeft = this.lockedScrollLeft;
    }
  };

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
  ): Promise<void> {
    this.viewportTarget = target;
    const initial = target.getBoundingClientRect();
    const initialWidth = Math.floor(initial.width);
    const initialHeight = Math.floor(initial.height);
    this.viewportSize = { width: initialWidth, height: initialHeight };
    this.rendition = this.book.renderTo(target, {
      width: '100%',
      height: '100%',
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      resizeOnOrientationChange: false,
      allowScriptedContent: false,
    });
    this.attached = () => {
      this.detachStageWindowListeners();
      this.normalizePaginatedManager();
      this.observeManagerViews();
      this.bindEpubContainer();
    };
    this.rendition.on('attached', this.attached);
    this.rendered = (_section, view) => {
      this.settleViewRender(view);
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
    };
    this.removed = (_section, view) => {
      const doc = (view as { document?: Document } | null)?.document;
      if (doc) {
        this.contentObservers.get(doc)?.disconnect();
        this.contentObservers.delete(doc);
      }
      this.settleViewRender(view);
    };
    this.rendition.on('rendered', this.rendered);
    this.rendition.on('removed', this.removed);
    this.bindEpubContainer();
    this.rendition.hooks.content.register((contents: Contents) => this.prepareContents(contents));
    if (!this.unloadedHookRegistered && this.rendition.hooks.unloaded?.register) {
      this.unloadedHookRegistered = true;
      this.rendition.hooks.unloaded.register((view: { contents?: Contents } | undefined) => {
        if (view?.contents) this.cleanupContents(view.contents);
      });
    }
    if (onSelection) {
      this.rendition.hooks.content.register((contents: Contents) => {
        this.registerContentFocusAndLinks(contents);
        let tabKeyActive = false;
        let blurredByTab = false;
        let tabResetTimer: ReturnType<typeof setTimeout> | null = null;

        const clearTabTimer = () => {
          if (tabResetTimer !== null) {
            clearTimeout(tabResetTimer);
            tabResetTimer = null;
          }
        };
        const handleKeydown = (event: KeyboardEvent) => {
          if (event.key === 'Tab') {
            tabKeyActive = true;
            clearTabTimer();
            tabResetTimer = setTimeout(() => {
              tabResetTimer = null;
              tabKeyActive = false;
            }, 0);
          } else {
            clearTabTimer();
            tabKeyActive = false;
            blurredByTab = false;
          }
        };
        const handleWindowBlur = () => {
          if (tabKeyActive) blurredByTab = true;
        };
        const handleFocusOut = (event: FocusEvent) => {
          if (tabKeyActive && !event.relatedTarget) blurredByTab = true;
        };
        const clearBlurGuard = () => {
          clearTabTimer();
          tabKeyActive = false;
          blurredByTab = false;
        };
        const handler = () => {
          const selection = contents.window.getSelection();
          const hasRange = Boolean(selection && !selection.isCollapsed && selection.rangeCount);
          const text = hasRange ? normalizePassageText(selection!.toString()) : '';
          if (!hasRange || !text) {
            const frame = contents.window.frameElement as HTMLElement | null | undefined;
            const frameLostFocus = frame
              ? frame.ownerDocument.activeElement !== frame
              : typeof contents.document.hasFocus === 'function'
                ? !contents.document.hasFocus()
                : false;
            if (blurredByTab || (tabKeyActive && frameLostFocus)) {
              return;
            }
            onSelection(null);
            return;
          }
          blurredByTab = false;
          try {
            onSelection({ cfi: contents.cfiFromRange(selection!.getRangeAt(0)), text });
          } catch {
            // Selection can change while a section is being replaced.
          }
        };
        contents.document.addEventListener('keydown', handleKeydown, true);
        contents.document.addEventListener('focusout', handleFocusOut);
        contents.document.addEventListener('focusin', clearBlurGuard);
        contents.document.addEventListener('pointerdown', clearBlurGuard);
        contents.document.addEventListener('mousedown', clearBlurGuard);
        contents.document.addEventListener('selectionchange', handler);
        contents.window.addEventListener?.('blur', handleWindowBlur);
        contents.window.addEventListener?.('focus', clearBlurGuard);
        this.addContentCleanup(contents, () => {
          clearTabTimer();
          contents.document.removeEventListener('keydown', handleKeydown, true);
          contents.document.removeEventListener('focusout', handleFocusOut);
          contents.document.removeEventListener('focusin', clearBlurGuard);
          contents.document.removeEventListener('pointerdown', clearBlurGuard);
          contents.document.removeEventListener('mousedown', clearBlurGuard);
          contents.document.removeEventListener('selectionchange', handler);
          contents.window.removeEventListener?.('blur', handleWindowBlur);
          contents.window.removeEventListener?.('focus', clearBlurGuard);
        });
      });
    }
    this.onLocation = onLocation;
    this.relocated = (location) => {
      const startCfi = this.userNavigationStartCfi ?? this.current?.start.cfi ?? null;
      const isUserNavigation =
        this.userNavigationPending &&
        (startCfi ? startCfi !== location.start.cfi : !this.reflowPending);
      const origin = isUserNavigation ? this.userNavigationOrigin : 'restore';
      const returnTarget = origin === 'link' ? this.pendingLinkReturnTarget : null;
      if (startCfi !== location.start.cfi) onSelection?.(null);
      this.current = location;
      if (isUserNavigation || this.userNavigationOrigin === 'link') {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
        this.userNavigationOrigin = 'navigation';
        this.pendingLinkReturnTarget = null;
      }
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
      this.reportLocation(location, origin, returnTarget);
      if (this.reflowPending) {
        this.reflowPending = false;
        this.preserveCfi(location.start.cfi, this.locationGeneration, true);
      }
    };
    this.rendition.on('relocated', this.relocated);
    this.resizedListener = () => {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
    };
    this.rendition.on('resized', this.resizedListener);
    this.contentClick = (event, contents) => {
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
    this.bindEpubContainer();
    if (!this.isCurrentLocationOperation(restoreGeneration)) return;
    this.normalizePaginatedManager();
    this.observeManagerViews();
    if (cfi) {
      try {
        if (await this.displayAtGeneration(cfi, restoreGeneration)) {
          await this.finishOpen(target, restoreGeneration, { cfi });
          return;
        }
      } catch {
        // A saved CFI can name a section removed in a newer copy of the EPUB.
      }
    }
    if (serverXPath) {
      const restored = await this.displayXPath(serverXPath, restoreGeneration);
      if (restored) {
        await this.finishOpen(
          target,
          restoreGeneration,
          restored.startsWith('epubcfi(') ? { cfi: restored } : { href: restored },
        );
        return;
      }
    }
    if (serverPercentage && serverPercentage > 0) {
      const restoredHref = await this.displayPercentage(serverPercentage, restoreGeneration);
      if (restoredHref) {
        await this.finishOpen(target, restoreGeneration, { href: restoredHref });
        return;
      }
    }
    if (await this.displayAtGeneration(undefined, restoreGeneration)) {
      await this.finishOpen(target, restoreGeneration, {});
    }
  }

  private reportLocation(
    location: Location,
    origin: ReaderLocationOrigin,
    returnTarget: ReaderLinkReturnTarget | null = null,
  ): void {
    if (!this.onLocation) return;
    const start = location.start;
    const { sections, indexes, hrefs } = this.getSpine();
    const sectionCount = Math.max(1, sections.length);
    const matchedHref = indexes.has(start.href)
      ? start.href
      : (matchSpineHref(start.href, hrefs) ?? start.href);
    const sectionIndex = indexes.get(matchedHref) ?? 0;
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
    const { hrefs } = this.getSpine();
    const navPath = this.navigationBasePath();
    const mapItems = (items: EpubTocItem[]): TocItem[] =>
      items.map((item) => ({
        label: item.label,
        href: resolveTocHref(item.href, navPath, hrefs),
        children: mapItems(item.subitems ?? []),
      }));

    return mapItems(this.book.navigation?.toc ?? []);
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

  getVisiblePassages(): ReaderSelection[] {
    if (!this.rendition) return [];
    const contentsList = this.getActiveContents();
    const passages: ReaderSelection[] = [];
    const seenCfis = new Set<string>();

    for (const contents of contentsList) {
      const doc = contents.document;
      if (!doc?.body) continue;
      const metrics = this.getViewportMetrics(contents);
      const pageRange = metrics === null ? this.resolveLocationRange(contents) : null;
      if (metrics === null && pageRange === null) continue;
      const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>(PASSAGE_BLOCK_SELECTOR));

      for (const block of candidates) {
        if (block.querySelector(PASSAGE_BLOCK_SELECTOR)) continue;
        if (metrics !== null) {
          if (!this.isElementVisibleInViewport(block, contents, metrics)) continue;
        } else if (pageRange && typeof pageRange.intersectsNode === 'function') {
          try {
            if (!pageRange.intersectsNode(block)) continue;
          } catch {
            // Fall through when range belongs to another document.
          }
        }
        const text = normalizePassageText(block.textContent ?? '');
        if (!text) continue;
        try {
          const range = doc.createRange();
          range.selectNodeContents(block);
          const cfi = contents.cfiFromRange(range);
          if (cfi && !seenCfis.has(cfi)) {
            seenCfis.add(cfi);
            passages.push({ cfi, text });
          }
        } catch {
          // Skip blocks whose CFI range cannot be computed while unloading.
        }
      }
    }

    if (passages.length > 0) return passages;
    return this.getFallbackPagePassages(contentsList);
  }

  clearTextSelection(): void {
    for (const contents of this.getActiveContents()) {
      try {
        contents.window.getSelection()?.removeAllRanges();
      } catch {
        // A contents document can unload while the selection is being cleared.
      }
    }
  }

  syncVisibleColumnLinks(): void {
    if (!this.rendition) return;
    for (const contents of this.getActiveContents()) {
      const doc = contents.document;
      if (!doc) continue;
      const metrics = this.getViewportMetrics(contents);
      if (!metrics) continue;
      const links = doc.querySelectorAll<HTMLElement>(FOCUSABLE_LINK_SELECTOR);
      for (const link of links) {
        if (this.isElementVisibleInViewport(link, contents, metrics)) {
          this.restoreSavedTabIndex(link);
        } else {
          if (!link.hasAttribute(SAVED_TABINDEX_ATTR)) {
            link.setAttribute(SAVED_TABINDEX_ATTR, link.getAttribute('tabindex') ?? '');
          }
          link.setAttribute('tabindex', '-1');
        }
      }
    }
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
    const target = this.resolveDisplayTarget(href);
    await this.navigate(() => this.rendition!.display(target));
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

  async displayServerLocation(xpath: string): Promise<boolean> {
    const generation = this.beginLocationOperation(false);
    const restored = await this.displayXPath(xpath, generation);
    if (!restored) return false;
    await this.settleRestoredTarget(
      restored.startsWith('epubcfi(') ? { cfi: restored } : { href: restored },
      generation,
    );
    return this.isCurrentLocationOperation(generation);
  }

  async displayServerPercentage(percentage: number): Promise<boolean> {
    const generation = this.beginLocationOperation(false);
    const restoredHref = await this.displayPercentage(percentage, generation);
    if (!restoredHref) return false;
    await this.settleRestoredTarget({ href: restoredHref }, generation);
    return this.isCurrentLocationOperation(generation);
  }

  applyAppearance(value: Appearance): void {
    const previous = this.appearance;
    this.appearance = { ...value };
    const rendition = this.rendition;
    if (!rendition) return;
    const layoutChanged =
      previous !== null &&
      (previous.fontFamily !== value.fontFamily ||
        previous.fontSize !== value.fontSize ||
        previous.lineHeight !== value.lineHeight ||
        previous.margin !== value.margin ||
        previous.bottomMargin !== value.bottomMargin ||
        previous.paragraphSpacing !== value.paragraphSpacing ||
        previous.alignment !== value.alignment ||
        previous.publisherStyles !== value.publisherStyles ||
        previous.hyphenation !== value.hyphenation);
    const themeChanged = !previous || previous.mode !== value.mode || layoutChanged;
    if (!themeChanged) return;
    const loadedContents =
      typeof (rendition as Partial<Rendition>).getContents === 'function'
        ? (rendition.getContents() as unknown as Contents | Contents[])
        : [];
    for (const content of Array.isArray(loadedContents) ? loadedContents : [loadedContents]) {
      content?.document?.getElementById('epubjs-inserted-css-turnleaf')?.remove();
    }
    const colors = MODE_COLORS[value.mode];
    const family =
      value.fontFamily === 'book'
        ? 'Iowan Old Style, Georgia, serif'
        : value.fontFamily === 'accessible'
          ? 'Atkinson Hyperlegible, Verdana, sans-serif'
          : 'Avenir Next, Segoe UI, sans-serif';
    const hyphens = value.hyphenation ? 'auto' : 'none';
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
        'text-align': value.publisherStyles ? value.alignment : `${value.alignment} !important`,
        padding: `0.5rem max(${value.margin}px, env(safe-area-inset-right)) max(${value.bottomMargin}px, env(safe-area-inset-bottom)) max(${value.margin}px, env(safe-area-inset-left)) !important`,
        'box-sizing': 'border-box',
      },
      p: value.publisherStyles
        ? {
            'margin-bottom': `${value.paragraphSpacing}em`,
            hyphens,
          }
        : {
            'margin-bottom': `${value.paragraphSpacing}em !important`,
            'text-align': `${value.alignment} !important`,
            hyphens: `${hyphens} !important`,
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
    this.syncVisibleColumnLinks();
    const cfi =
      this.restoreTarget?.cfi ?? this.current?.start.cfi ?? rendition.location?.start.cfi ?? null;
    if (!cfi) return;
    if (this.userNavigationPending) {
      this.reflowPending = true;
      return;
    }
    this.preserveCfi(cfi, this.locationGeneration, true);
  }

  destroy(): void {
    this.locationGeneration += 1;
    for (const contents of [...this.trackedContents]) {
      this.cleanupContents(contents);
    }
    this.trackedContents.clear();
    this.contentCleanups.clear();
    if (this.epubContainer) {
      this.epubContainer.removeEventListener('scroll', this.handleContainerScroll);
      this.epubContainer = null;
    }
    if (this.observedManager && this.viewAdded) {
      this.observedManager.off?.('added', this.viewAdded);
    }
    if (this.observedManager && this.viewResized) {
      this.observedManager.off?.('resize', this.viewResized);
    }
    if (this.rendition && this.attached) this.rendition.off('attached', this.attached);
    if (this.rendition && this.rendered) this.rendition.off('rendered', this.rendered);
    if (this.rendition && this.removed) this.rendition.off('removed', this.removed);
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.resizedListener) this.rendition.off('resized', this.resizedListener);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.settleAllViewRenders();
    for (const observer of this.contentObservers.values()) {
      observer.disconnect();
    }
    this.contentObservers.clear();
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportSize = null;
    this.pendingViewportSize = null;
    this.resizeDrain = null;
    this.activeNavigation = null;
    this.restoreTarget = null;
    this.pendingContentWork.clear();
    this.observedManager = null;
    this.viewAdded = null;
    this.viewResized = null;
    this.viewportTarget = null;
    this.lockedScrollLeft = 0;
    this.displayOperationCount = 0;
    this.aligningFocusTarget = null;
    this.unloadedHookRegistered = false;
    this.rendition = null;
    this.attached = null;
    this.rendered = null;
    this.removed = null;
    this.relocated = null;
    this.resizedListener = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.current = null;
    this.currentOperationIsUserNavigation = false;
    this.lastUserNavigationFromCfi = null;
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

  private prepareContents(contents: Contents): Promise<void> {
    const work = this.harden(contents).then(() => {
      if (!this.rendition) return;
      this.registerContentFocusAndLinks(contents);
      this.syncVisibleColumnLinks();
    });
    this.pendingContentWork.add(work);
    void work.finally(() => this.pendingContentWork.delete(work));
    return work;
  }

  private harden(contents: Contents): Promise<void> {
    const runtimeContents = contents as unknown as { resizeCheck?: () => void };
    return sanitizeEpubDocument(contents.document, this.stylesheetCache).then(() => {
      if (!this.rendition) return;
      const triggerResizeCheck = () => {
        if (!this.rendition) return;
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => runtimeContents.resizeCheck?.());
        } else {
          runtimeContents.resizeCheck?.();
        }
      };
      void contents.document.fonts?.ready?.then(triggerResizeCheck).catch(() => {});
      if (typeof MutationObserver !== 'undefined' && contents.document.head) {
        this.contentObservers.get(contents.document)?.disconnect();
        const observer = new MutationObserver(triggerResizeCheck);
        observer.observe(contents.document.head, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        this.contentObservers.set(contents.document, observer);
      }
    });
  }

  private detachStageWindowListeners(): void {
    if (typeof window === 'undefined') return;
    const stage = (this.rendition as (Rendition & { manager?: PaginatedRuntimeManager }) | null)
      ?.manager?.stage;
    if (stage?.resizeFunc) window.removeEventListener('resize', stage.resizeFunc);
    if (stage?.orientationChangeFunc) {
      window.removeEventListener('orientationchange', stage.orientationChangeFunc);
    }
  }

  private normalizePaginatedManager(): void {
    const manager = (this.rendition as (Rendition & { manager?: PaginatedRuntimeManager }) | null)
      ?.manager;
    if (!manager || patchedManagers.has(manager)) return;
    patchedManagers.add(manager);

    const canSnapHorizontalLtr = (requireMultipleViews = false) => {
      const dir = manager.settings?.direction;
      return Boolean(
        manager.isPaginated &&
        manager.settings?.axis === 'horizontal' &&
        (!dir || dir === 'ltr') &&
        manager.container &&
        (!requireMultipleViews ||
          (!manager.settings?.fullsize &&
            (manager.layout?.delta ?? 0) > 0 &&
            (manager.views?.length ?? 0) > 0)),
      );
    };

    if (typeof manager.next === 'function') {
      const origNext = manager.next.bind(manager);
      manager.next = () => {
        if (canSnapHorizontalLtr(true)) {
          const delta = manager.layout!.delta!;
          const container = manager.container!;
          const nextScrollLeft = (Math.round(container.scrollLeft / delta) + 1) * delta;
          if (nextScrollLeft + delta <= container.scrollWidth + 2) {
            manager.scrollTo?.(nextScrollLeft, 0, true);
            return undefined;
          }
          if (container.scrollLeft + container.offsetWidth + delta <= container.scrollWidth) {
            container.scrollLeft = Math.max(0, container.scrollWidth - container.offsetWidth);
          }
        }
        return origNext();
      };
    }

    if (typeof manager.prev === 'function') {
      const origPrev = manager.prev.bind(manager);
      manager.prev = () => {
        if (canSnapHorizontalLtr(true)) {
          const delta = manager.layout!.delta!;
          const container = manager.container!;
          const currentPage = Math.round(container.scrollLeft / delta);
          if (currentPage > 0) {
            manager.scrollTo?.((currentPage - 1) * delta, 0, true);
            return undefined;
          }
          if (container.scrollLeft > 0) container.scrollLeft = 0;
        }
        return origPrev();
      };
    }

    if (typeof manager.moveTo === 'function') {
      const origMoveTo = manager.moveTo.bind(manager);
      manager.moveTo = (offset, width) => {
        const delta = manager.layout?.delta ?? 0;
        const container = manager.container;
        if (
          canSnapHorizontalLtr() &&
          container &&
          delta > 0 &&
          offset &&
          Number.isFinite(offset.left)
        ) {
          const clampStep = (pos: number, max: number) => {
            const stepped = Math.floor((pos + 0.5) / delta) * delta;
            return stepped + delta > max ? Math.max(0, max - delta) : stepped;
          };
          manager.scrollTo?.(
            clampStep(offset.left, container.scrollWidth),
            clampStep(offset.top, container.scrollHeight),
            true,
          );
          return;
        }
        origMoveTo(offset, width);
      };
    }

    if (typeof manager.paginatedLocation === 'function') {
      const origPaginatedLocation = manager.paginatedLocation.bind(manager);
      manager.paginatedLocation = () => {
        const layout = manager.layout;
        const containerEl = manager.container;
        if (
          !canSnapHorizontalLtr() ||
          !containerEl ||
          !layout?.pageWidth ||
          !layout.width ||
          !layout.count ||
          !manager.visible ||
          !manager.mapping?.page
        ) {
          return origPaginatedLocation();
        }

        const visible = manager.visible();
        const container = containerEl.getBoundingClientRect();
        const left = manager.settings?.fullsize ? window.scrollX : 0;
        const unitWidth = layout.pageWidth;
        let used = 0;

        return visible.map((view) => {
          const { index, href } = view.section;
          const position = view.position();
          const width = view.width();
          const offset = container.left + left;
          const rawPageWidth = Math.min(position.right - offset, layout.width!) - used;
          const rawStart = offset - position.left + used;
          const snappedPage = Math.max(0, Math.round(rawStart / unitWidth));
          const snappedStart = snappedPage * unitWidth;
          const start =
            Math.abs(rawStart - snappedStart) <= 2 ? snappedStart : Math.max(0, rawStart);
          const snappedWidth = Math.round(rawPageWidth / unitWidth) * unitWidth;
          const pageWidth =
            snappedWidth > 0 && Math.abs(rawPageWidth - snappedWidth) <= 2
              ? snappedWidth
              : Math.max(0, rawPageWidth);
          const end = start + pageWidth;
          used += pageWidth;

          const mapping = manager.mapping!.page!(view.contents, view.section.cfiBase, start, end);
          const totalPages = layout.count!(width).pages;
          const safeTotal = Math.max(1, totalPages);
          const startPage = Math.min(
            safeTotal - 1,
            Math.max(0, Math.floor((start + 0.5) / unitWidth)),
          );
          const endPage = Math.min(
            safeTotal,
            Math.max(startPage + 1, Math.floor((end + 0.5) / unitWidth)),
          );
          const pages: number[] = [];
          for (let i = startPage + 1; i <= endPage; i += 1) {
            pages.push(i);
          }
          return { index, href, pages, totalPages, mapping };
        });
      };
    }
  }

  private observeManagerViews(): void {
    const manager = (this.rendition as (Rendition & { manager?: PaginatedRuntimeManager }) | null)
      ?.manager;
    if (!manager || this.observedManager === manager || typeof manager.on !== 'function') return;
    this.observedManager = manager;
    this.viewAdded = (view) => {
      if (!view || typeof view !== 'object' || this.pendingViewRenders.has(view)) return;
      let resolveRender!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveRender = resolve;
      });
      this.pendingViewRenders.set(view, { promise, resolve: resolveRender });
    };
    manager.on('added', this.viewAdded);
    this.viewResized = () => {
      if (
        this.displayOperationCount > 0 ||
        this.pendingViewRenders.size > 0 ||
        this.pendingContentWork.size > 0 ||
        this.activeNavigation !== null ||
        this.resizeDrain !== null ||
        this.userNavigationPending
      ) {
        return;
      }
      if (this.restoreTarget?.cfi) {
        this.preserveCfi(this.restoreTarget.cfi, this.locationGeneration);
        return;
      }
      const runtimeRendition = this.rendition as
        (Rendition & { reportLocation?: () => Promise<unknown> }) | null;
      if (!runtimeRendition?.reportLocation) return;
      const generation = this.locationGeneration;
      this.rearmSettledUserNavigation();
      void Promise.resolve(runtimeRendition.reportLocation()).finally(() => {
        if (this.locationGeneration === generation) {
          this.userNavigationPending = false;
          this.userNavigationStartCfi = null;
        }
      });
    };
    manager.on('resize', this.viewResized);
    if (typeof manager.clear === 'function') {
      const origClear = manager.clear.bind(manager);
      manager.clear = () => {
        this.settleAllViewRenders();
        origClear();
      };
    }
  }

  private settleViewRender(view: unknown): void {
    if (!view || typeof view !== 'object') return;
    const entry = this.pendingViewRenders.get(view);
    if (!entry) return;
    this.pendingViewRenders.delete(view);
    entry.resolve();
  }

  private settleAllViewRenders(): void {
    for (const entry of this.pendingViewRenders.values()) {
      entry.resolve();
    }
    this.pendingViewRenders.clear();
  }

  private async alignCfiAfterRender(cfi: string, generation: number): Promise<void> {
    const runtimeRendition = this.rendition as
      | (Rendition & {
          manager?: {
            container?: HTMLElement;
            views?: { all?: () => Array<{ expand?: () => void }> };
          };
        })
      | null;
    if (!runtimeRendition?.manager || !cfi.startsWith('epubcfi(')) return;
    if (!this.isCurrentLocationOperation(generation) || this.userNavigationPending) return;
    await Promise.resolve();
    while (this.pendingViewRenders.size > 0 || this.pendingContentWork.size > 0) {
      await Promise.allSettled([
        ...[...this.pendingViewRenders.values()].map((entry) => entry.promise),
        ...this.pendingContentWork,
      ]);
      if (!this.isCurrentLocationOperation(generation) || this.userNavigationPending) return;
    }
    if (typeof requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!this.isCurrentLocationOperation(generation) || this.userNavigationPending) return;
    runtimeRendition.manager.views?.all?.().forEach((view) => view.expand?.());
    void runtimeRendition.manager.container?.scrollWidth;
    try {
      await this.displayAtGeneration(cfi, generation);
    } catch {
      // The restored passage can be superseded by a newer navigation or resize.
    }
  }

  private async settleRestoredTarget(
    restoreTarget: { cfi?: string; href?: string },
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentLocationOperation(generation)) return;
    this.restoreTarget = restoreTarget;
    if (restoreTarget.cfi) {
      await this.alignCfiAfterRender(restoreTarget.cfi, generation);
    } else {
      await this.settlePendingSectionRenders(generation);
    }
  }

  private async finishOpen(
    target: HTMLElement,
    generation: number,
    restoreTarget: { cfi?: string; href?: string },
  ): Promise<void> {
    await this.settleRestoredTarget(restoreTarget, generation);
    if (!this.isCurrentLocationOperation(generation)) return;
    this.detachStageWindowListeners();
    this.observeViewport(target);
    const current = target.getBoundingClientRect();
    await this.resizeViewport(Math.floor(current.width), Math.floor(current.height));
  }

  private addContentCleanup(contents: Contents, cleanup: () => void): void {
    const existing = this.contentCleanups.get(contents);
    if (existing) existing.push(cleanup);
    else this.contentCleanups.set(contents, [cleanup]);
  }

  private registerContentFocusAndLinks(contents: Contents): void {
    if (this.trackedContents.has(contents)) return;
    this.trackedContents.add(contents);
    this.bindEpubContainer(contents);
    const doc = contents.document;
    if (!doc?.addEventListener) return;

    const handleFocusIn = (event: FocusEvent) => {
      const rawTarget = event.target as Element | null;
      if (!rawTarget || rawTarget.nodeType !== 1 || rawTarget === this.aligningFocusTarget) return;
      if (rawTarget === doc.documentElement || rawTarget === doc.body) return;

      const container = this.bindEpubContainer(contents);
      if (
        container &&
        !this.isProgrammaticScrollAllowed() &&
        container.scrollLeft !== this.lockedScrollLeft
      ) {
        container.scrollLeft = this.lockedScrollLeft;
      }

      const focusTarget =
        (rawTarget.closest?.(
          'a[href], area[href], button, input, select, textarea, [tabindex]',
        ) as HTMLElement | null) ?? (rawTarget as HTMLElement);
      if (focusTarget === doc.documentElement || focusTarget === doc.body) return;

      const metrics = this.getViewportMetrics(contents);
      if (!metrics || this.isElementVisibleInViewport(focusTarget, contents, metrics)) {
        if (
          container &&
          !this.isProgrammaticScrollAllowed() &&
          container.scrollLeft !== this.lockedScrollLeft
        ) {
          container.scrollLeft = this.lockedScrollLeft;
        }
        return;
      }

      const cfi = this.cfiForElement(focusTarget, contents);
      if (!cfi || !this.rendition) return;
      void this.alignOffscreenFocus(cfi, focusTarget, contents);
    };

    doc.addEventListener('focusin', handleFocusIn);
    this.addContentCleanup(contents, () => {
      doc.removeEventListener('focusin', handleFocusIn);
      if (doc.querySelectorAll) {
        for (const link of doc.querySelectorAll<HTMLElement>(`[${SAVED_TABINDEX_ATTR}]`)) {
          this.restoreSavedTabIndex(link);
        }
      }
    });
  }

  private cleanupContents(contents: Contents): void {
    const cleanups = this.contentCleanups.get(contents);
    if (cleanups) {
      for (const cleanup of cleanups) cleanup();
      this.contentCleanups.delete(contents);
    }
    this.trackedContents.delete(contents);
  }

  private restoreSavedTabIndex(element: HTMLElement): void {
    if (!element.hasAttribute(SAVED_TABINDEX_ATTR)) return;
    const saved = element.getAttribute(SAVED_TABINDEX_ATTR) ?? '';
    element.removeAttribute(SAVED_TABINDEX_ATTR);
    if (saved === '') element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', saved);
  }

  private cfiForElement(element: Element, contents: Contents): string | null {
    try {
      const range = contents.document.createRange();
      range.selectNodeContents(element);
      const cfi = contents.cfiFromRange(range);
      if (cfi) return cfi;
    } catch {
      // Fall back to node CFI when element contents cannot form a range.
    }
    try {
      return contents.cfiFromNode?.(element) ?? null;
    } catch {
      return null;
    }
  }

  private async alignOffscreenFocus(
    cfi: string,
    element: HTMLElement,
    contents: Contents,
  ): Promise<void> {
    if (!this.rendition) return;
    try {
      await this.navigate(() => this.rendition!.display(cfi));
      const container = this.bindEpubContainer(contents);
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
      if (element.isConnected && contents.document?.activeElement !== element) {
        this.aligningFocusTarget = element;
        try {
          element.focus({ preventScroll: true });
        } finally {
          this.aligningFocusTarget = null;
        }
      }
    } catch {
      // Ignore canceled or stale focus alignment when switching chapters.
    }
  }

  private bindEpubContainer(contents?: Contents): HTMLElement | null {
    const frameContainer = contents?.window?.frameElement?.closest?.(
      '.epub-container',
    ) as HTMLElement | null;
    const queriedContainer =
      frameContainer ?? this.viewportTarget?.querySelector<HTMLElement>('.epub-container') ?? null;
    if (queriedContainer && queriedContainer !== this.epubContainer) {
      this.epubContainer?.removeEventListener('scroll', this.handleContainerScroll);
      this.epubContainer = queriedContainer;
      this.lockedScrollLeft = queriedContainer.scrollLeft;
      queriedContainer.addEventListener('scroll', this.handleContainerScroll);
    }
    return this.epubContainer;
  }

  private isProgrammaticScrollAllowed(): boolean {
    return this.displayOperationCount > 0 || this.userNavigationPending;
  }

  private async runDisplayOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.displayOperationCount += 1;
    try {
      return await operation();
    } finally {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.displayOperationCount = Math.max(0, this.displayOperationCount - 1);
      this.syncVisibleColumnLinks();
    }
  }

  private getActiveContents(): Contents[] {
    const rendition = this.rendition as
      (Rendition & { getContents?: () => Contents | Contents[] }) | null;
    const fromRendition =
      typeof rendition?.getContents === 'function' ? rendition.getContents() : null;
    const list = Array.isArray(fromRendition)
      ? fromRendition
      : fromRendition
        ? [fromRendition]
        : [];
    const combined = list.length > 0 ? list : [...this.trackedContents];
    const currentIndex = this.current?.start?.index;
    if (typeof currentIndex === 'number') {
      const matching = combined.filter(
        (item) => item.sectionIndex === undefined || item.sectionIndex === currentIndex,
      );
      if (matching.length > 0) return matching;
    }
    return combined;
  }

  private getViewportMetrics(contents: Contents): {
    viewportWidth: number;
    viewportHeight: number;
    frameOffsetLeft: number;
    frameOffsetTop: number;
  } | null {
    const container = this.bindEpubContainer(contents) ?? this.viewportTarget;
    if (!container) return null;
    const viewportRect = container.getBoundingClientRect();
    const viewportWidth =
      viewportRect.width || container.clientWidth || this.viewportSize?.width || 0;
    const viewportHeight =
      viewportRect.height || container.clientHeight || this.viewportSize?.height || 0;
    if (viewportWidth <= 0) return null;

    const frame = contents.window?.frameElement as HTMLElement | null | undefined;
    if (!frame || typeof frame.getBoundingClientRect !== 'function') {
      return {
        viewportWidth,
        viewportHeight,
        frameOffsetLeft: this.epubContainer ? -this.epubContainer.scrollLeft : 0,
        frameOffsetTop: this.epubContainer ? -this.epubContainer.scrollTop : 0,
      };
    }

    const frameRect = frame.getBoundingClientRect();
    const rawLeft = frameRect.left - viewportRect.left;
    const rawTop = frameRect.top - viewportRect.top;
    const frameOffsetLeft =
      this.epubContainer &&
      this.epubContainer.scrollLeft !== 0 &&
      Math.abs(rawLeft - (frame.offsetLeft || 0)) < VIEWPORT_RECT_EPSILON
        ? (frame.offsetLeft || 0) - this.epubContainer.scrollLeft
        : rawLeft;
    const frameOffsetTop =
      this.epubContainer &&
      this.epubContainer.scrollTop !== 0 &&
      Math.abs(rawTop - (frame.offsetTop || 0)) < VIEWPORT_RECT_EPSILON
        ? (frame.offsetTop || 0) - this.epubContainer.scrollTop
        : rawTop;

    return { viewportWidth, viewportHeight, frameOffsetLeft, frameOffsetTop };
  }

  private getElementRects(element: Element): DOMRect[] {
    const clientRects =
      typeof element.getClientRects === 'function' ? Array.from(element.getClientRects()) : [];
    const nonEmpty = clientRects.filter((rect) => rect.width > 0 || rect.height > 0);
    if (nonEmpty.length > 0) return nonEmpty;
    if (typeof element.getBoundingClientRect === 'function') {
      const bounding = element.getBoundingClientRect();
      if (bounding.width > 0 || bounding.height > 0) return [bounding];
    }
    return [];
  }

  private isElementVisibleInViewport(
    element: Element,
    contents: Contents,
    precomputedMetrics?: {
      viewportWidth: number;
      viewportHeight: number;
      frameOffsetLeft: number;
      frameOffsetTop: number;
    },
  ): boolean {
    const metrics = precomputedMetrics ?? this.getViewportMetrics(contents);
    if (!metrics) return true;
    const rects = this.getElementRects(element);
    if (rects.length === 0) return false;
    const { viewportWidth, viewportHeight, frameOffsetLeft, frameOffsetTop } = metrics;
    return rects.some((rect) => {
      const left = frameOffsetLeft + rect.left;
      const right = frameOffsetLeft + rect.right;
      const horizontallyVisible =
        right > VIEWPORT_RECT_EPSILON && left < viewportWidth - VIEWPORT_RECT_EPSILON;
      if (!horizontallyVisible) return false;
      if (viewportHeight <= 0) return true;
      const top = frameOffsetTop + rect.top;
      const bottom = frameOffsetTop + rect.bottom;
      return bottom > VIEWPORT_RECT_EPSILON && top < viewportHeight - VIEWPORT_RECT_EPSILON;
    });
  }

  private resolveSingleCfiRange(cfi: string, contents?: Contents): Range | null {
    if (!cfi) return null;
    try {
      const fromContents = contents?.range?.(cfi);
      if (fromContents) return fromContents;
    } catch {
      // Try rendition range lookup next.
    }
    try {
      return this.rendition?.getRange?.(cfi) ?? null;
    } catch {
      return null;
    }
  }

  private resolveLocationRange(contents?: Contents): Range | null {
    const location = this.current ?? this.rendition?.location ?? null;
    const startCfi = location?.start?.cfi;
    if (!startCfi) return null;
    const endCfi = location?.end?.cfi ?? startCfi;
    const startRange = this.resolveSingleCfiRange(startCfi, contents);
    const endRange =
      endCfi === startCfi ? startRange : this.resolveSingleCfiRange(endCfi, contents);
    if (!startRange || !endRange) return null;
    const doc = startRange.startContainer.ownerDocument;
    if (!doc || doc !== endRange.endContainer.ownerDocument) return null;
    try {
      const range = doc.createRange();
      range.setStart(startRange.startContainer, startRange.startOffset);
      range.setEnd(endRange.endContainer, endRange.endOffset);
      return range;
    } catch {
      return null;
    }
  }

  private getFallbackPagePassages(contentsList: Contents[]): ReaderSelection[] {
    const location = this.current ?? this.rendition?.location ?? null;
    const startCfi = location?.start?.cfi ?? '';
    if (!startCfi) return [];
    const endCfi = location?.end?.cfi ?? startCfi;
    const primaryContents = contentsList[0];
    const pageRange = this.resolveLocationRange(primaryContents);
    let cfi = mergeCfiRange(startCfi, endCfi);
    let text = '';

    if (pageRange) {
      text = normalizePassageText(pageRange.toString());
      if (primaryContents?.cfiFromRange) {
        try {
          cfi = primaryContents.cfiFromRange(pageRange) || cfi;
        } catch {
          // Keep merged start..end CFI range fallback.
        }
      }
    }
    return cfi && text ? [{ cfi, text }] : [];
  }

  private observeViewport(target: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this.rendition) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      void this.resizeViewport(width, height);
    });
    this.resizeObserver.observe(target);
  }

  private resizeViewport(width: number, height: number): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || !width || !height) return Promise.resolve();
    if (
      !this.resizeDrain &&
      this.viewportSize?.width === width &&
      this.viewportSize.height === height
    ) {
      return Promise.resolve();
    }
    const runtimeRendition = rendition as Rendition & {
      manager?: {
        stage?: unknown;
        container?: HTMLElement;
        views?: { all?: () => Array<{ expand?: () => void }> };
      };
      q?: { enqueue: (task: () => void) => Promise<unknown> };
      resize: (nextWidth: number, nextHeight: number, epubcfi?: string) => void;
    };
    if (!runtimeRendition.q?.enqueue) {
      return this.runDisplayOperation(async () => {
        this.applyViewportResize(runtimeRendition, width, height);
      });
    }
    this.pendingViewportSize = { width, height };
    if (!this.resizeDrain) {
      const drain = this.drainViewportResize(runtimeRendition).finally(() => {
        if (this.resizeDrain === drain) this.resizeDrain = null;
      });
      this.resizeDrain = drain;
    }
    return this.resizeDrain;
  }

  private async drainViewportResize(
    runtimeRendition: Rendition & {
      manager?: {
        stage?: unknown;
        container?: HTMLElement;
        views?: { all?: () => Array<{ expand?: () => void }> };
      };
      q?: { enqueue: (task: () => void) => Promise<unknown> };
      resize: (nextWidth: number, nextHeight: number, epubcfi?: string) => void;
    },
  ): Promise<void> {
    while (this.pendingViewportSize && this.rendition === runtimeRendition) {
      while (this.activeNavigation && this.rendition === runtimeRendition) {
        await this.activeNavigation;
      }
      if (!this.pendingViewportSize || this.rendition !== runtimeRendition) break;
      let target: string | undefined;
      let resized = false;
      let generation = this.locationGeneration;
      await this.runDisplayOperation(async () => {
        await runtimeRendition.q!.enqueue(() => {
          const next = this.pendingViewportSize;
          this.pendingViewportSize = null;
          if (!next || this.rendition !== runtimeRendition) return;
          generation = this.locationGeneration;
          this.rearmSettledUserNavigation();
          const applied = this.applyViewportResize(runtimeRendition, next.width, next.height);
          resized = applied.resized;
          target = applied.target;
        });
        if (resized && this.rendition === runtimeRendition) {
          await runtimeRendition.q!.enqueue(() => {});
          if (!this.pendingViewportSize && target?.startsWith('epubcfi(')) {
            if (this.locationGeneration === generation) {
              this.rearmSettledUserNavigation();
            }
            await this.alignCfiAfterRender(target, generation);
          }
        }
      });
      if (this.locationGeneration === generation) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
    }
  }

  private applyViewportResize(
    runtimeRendition: Rendition & {
      manager?: { stage?: unknown };
      resize: (nextWidth: number, nextHeight: number, epubcfi?: string) => void;
    },
    width: number,
    height: number,
  ): { resized: boolean; target?: string | undefined } {
    if (this.viewportSize?.width === width && this.viewportSize.height === height) {
      return { resized: false };
    }
    if (runtimeRendition.manager && !runtimeRendition.manager.stage) {
      return { resized: false };
    }

    this.viewportSize = { width, height };
    const target =
      this.restoreTarget !== null
        ? (this.restoreTarget.cfi ?? this.restoreTarget.href)
        : (this.current?.start.cfi ?? runtimeRendition.location?.start.cfi);
    const hadRenditionLocation = Boolean(runtimeRendition.location?.start);
    if (target !== undefined) {
      runtimeRendition.resize(width, height, target);
    } else {
      runtimeRendition.resize(width, height);
    }
    if (runtimeRendition.manager && !hadRenditionLocation && !this.userNavigationPending) {
      void this.runDisplayOperation(() =>
        target === undefined ? runtimeRendition.display() : runtimeRendition.display(target),
      ).catch(() => {
        // The restored passage can be superseded by a newer navigation or resize.
      });
    }
    return { resized: true, target };
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
    await this.runDisplayOperation(() =>
      target === undefined ? rendition.display() : rendition.display(target),
    );
    return this.isCurrentLocationOperation(generation);
  }

  private async displayXPath(xpath: string, generation: number): Promise<string | null> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return null;
    const target = parseKavitaXPath(xpath);
    if (!target) return null;
    const section = this.getSpine().sections[target.spineIndex];
    if (!section) return null;
    try {
      await this.runDisplayOperation(() => rendition.display(section.href));
      if (!this.isCurrentLocationOperation(generation)) return null;
      if (target.contentXPath === '/html/body') return section.href;
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return null;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return null;
      const cfi = this.cfiFromXPathNode(contents, node);
      if (!(contents.range(cfi) as Range | null)) return null;
      await this.runDisplayOperation(() => rendition.display(cfi));
      return this.isCurrentLocationOperation(generation) ? cfi : null;
    } catch {
      // A server XPath from a changed EPUB is not safe to guess around.
      return null;
    }
  }

  private cfiFromXPathNode(contents: Contents, node: Element): string {
    const walker = contents.document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.parentElement?.localName === 'style') continue;
      const offset = current.textContent?.search(/\S/) ?? -1;
      if (offset >= 0) {
        const range = contents.document.createRange();
        range.setStart(current, offset);
        range.collapse(true);
        return contents.cfiFromRange(range);
      }
    }
    return contents.cfiFromNode(node);
  }

  private async displayPercentage(percentage: number, generation: number): Promise<string | null> {
    if (!Number.isFinite(percentage) || !this.isCurrentLocationOperation(generation)) return null;
    const { sections } = this.getSpine();
    if (!sections.length) return null;
    const position = Math.max(0, Math.min(0.999, percentage));
    const section = sections[Math.floor(position * sections.length)];
    if (!section) return null;
    try {
      return (await this.displayAtGeneration(section.href, generation)) ? section.href : null;
    } catch {
      return null;
    }
  }

  private async navigate(display: () => Promise<unknown>): Promise<void> {
    const previousNavigation = this.activeNavigation;
    let releaseNavigation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    this.activeNavigation = gate;
    try {
      if (previousNavigation) await previousNavigation;
      while (this.resizeDrain) await this.resizeDrain;
      const generation = this.beginLocationOperation(true);
      await this.runDisplayOperation(async () => {
        try {
          await display();
          await this.settlePendingSectionRenders(generation, true);
        } catch (error) {
          if (this.isCurrentLocationOperation(generation)) {
            this.userNavigationPending = false;
            this.userNavigationStartCfi = null;
          }
          throw error;
        }
      });
    } finally {
      if (this.activeNavigation === gate) this.activeNavigation = null;
      releaseNavigation();
    }
  }

  private async settlePendingSectionRenders(generation: number, awaitFrame = false): Promise<void> {
    const runtimeRendition = this.rendition as
      | (Rendition & {
          q?: unknown;
          reportLocation?: () => Promise<unknown>;
          manager?: {
            container?: HTMLElement;
            views?: { all?: () => Array<{ expand?: () => void; width?: () => number }> };
          };
        })
      | null;
    if (!runtimeRendition?.q || !this.isCurrentLocationOperation(generation)) return;
    let settledSectionRender = false;
    while (this.pendingViewRenders.size > 0 || this.pendingContentWork.size > 0) {
      settledSectionRender = true;
      await Promise.allSettled([
        ...[...this.pendingViewRenders.values()].map((entry) => entry.promise),
        ...this.pendingContentWork,
      ]);
      if (!this.isCurrentLocationOperation(generation)) return;
    }
    if (settledSectionRender && this.isCurrentLocationOperation(generation)) {
      const views = runtimeRendition.manager?.views?.all?.() ?? [];
      let widthChanged = false;
      for (const view of views) {
        const before = view.width?.();
        view.expand?.();
        const after = view.width?.();
        if (before !== undefined && after !== undefined && before !== after) {
          widthChanged = true;
        }
      }
      void runtimeRendition.manager?.container?.scrollWidth;
      if (widthChanged && runtimeRendition.reportLocation) {
        this.rearmSettledUserNavigation();
        try {
          await runtimeRendition.reportLocation();
        } finally {
          if (this.locationGeneration === generation) {
            this.userNavigationPending = false;
            this.userNavigationStartCfi = null;
          }
        }
      }
    }
    if (
      (awaitFrame || settledSectionRender) &&
      this.isCurrentLocationOperation(generation) &&
      typeof requestAnimationFrame === 'function'
    ) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  private beginLocationOperation(userNavigation: boolean): number {
    this.locationGeneration += 1;
    this.restoreTarget = null;
    this.currentOperationIsUserNavigation = userNavigation;
    this.userNavigationPending = userNavigation;
    this.userNavigationOrigin = userNavigation ? 'navigation' : 'restore';
    this.pendingLinkReturnTarget = null;
    const fromCfi = userNavigation
      ? (this.current?.start.cfi ?? this.rendition?.location?.start.cfi ?? null)
      : null;
    this.lastUserNavigationFromCfi = fromCfi;
    this.userNavigationStartCfi = fromCfi;
    return this.locationGeneration;
  }

  private beginLinkedNavigation(): void {
    const start = this.current?.start ?? this.rendition?.location?.start;
    if (!start) return;
    this.locationGeneration += 1;
    this.restoreTarget = null;
    this.currentOperationIsUserNavigation = true;
    this.lastUserNavigationFromCfi = start.cfi;
    this.userNavigationPending = true;
    this.userNavigationStartCfi = start.cfi;
    this.userNavigationOrigin = 'link';
    this.pendingLinkReturnTarget = { cfi: start.cfi, href: start.href };
  }

  private rearmSettledUserNavigation(): void {
    if (!this.currentOperationIsUserNavigation) return;
    this.userNavigationPending = true;
    this.userNavigationOrigin = 'navigation';
    this.userNavigationStartCfi = this.lastUserNavigationFromCfi;
  }

  private isCurrentLocationOperation(generation: number): boolean {
    return generation === this.locationGeneration && this.rendition !== null;
  }

  private preserveCfi(cfi: string, generation: number, expandViews = false): void {
    const rendition = this.rendition as
      | (Rendition & {
          manager?: {
            container?: HTMLElement;
            views?: { all?: () => Array<{ expand?: () => void }> };
          };
        })
      | null;
    if (!rendition || !this.isCurrentLocationOperation(generation) || this.userNavigationPending) {
      return;
    }
    void this.runDisplayOperation(() => {
      if (expandViews && rendition.manager) {
        rendition.manager.views?.all?.().forEach((view) => view.expand?.());
        void rendition.manager.container?.scrollWidth;
      }
      return rendition.display(cfi);
    }).catch(() => {
      // The current passage may disappear while a reflow is being applied.
    });
  }

  private getSpine(): NonNullable<ReaderSession['spine']> {
    if (this.spine) return this.spine;
    const sections: SpineSection[] = [];
    const indexes = new Map<string, number>();
    const spineHrefs: string[] = [];
    this.book.spine.each((section: SpineSection) => {
      if (!indexes.has(section.href)) indexes.set(section.href, sections.length);
      sections.push(section);
      spineHrefs.push(section.href);
    });
    const hrefs = createSpineHrefLookup(spineHrefs);
    this.spine = { sections, indexes, hrefs };
    return this.spine;
  }

  private navigationBasePath(): string {
    const packaging = (
      this.book as typeof this.book & {
        packaging?: { navPath?: string | false; ncxPath?: string | false };
      }
    ).packaging;
    const navPath = typeof packaging?.navPath === 'string' ? packaging.navPath.trim() : '';
    if (navPath) return navPath;
    const ncxPath = typeof packaging?.ncxPath === 'string' ? packaging.ncxPath.trim() : '';
    return ncxPath;
  }

  private resolveDisplayTarget(href: string): string {
    const trimmed = href.trim();
    if (!trimmed) return href;
    if (trimmed.startsWith('#')) {
      const spineById = (
        this.book.spine as typeof this.book.spine & {
          spineById?: Record<string, number | undefined>;
        }
      ).spineById;
      if (spineById && spineById[trimmed.slice(1)] !== undefined) {
        return trimmed;
      }
    }
    const { hrefs } = this.getSpine();
    const currentHref = this.current?.start.href ?? this.rendition?.location?.start.href ?? null;
    return resolveDisplayHref(trimmed, this.navigationBasePath(), hrefs, currentHref);
  }

  private pageIndex(page: number): number {
    return Math.max(0, page - 1);
  }

  private resolveToken(token: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || token;
  }
}
