import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  MAX_STORED_EXCERPT_LENGTH,
  buildDocumentTextMap,
  extractSelectionContext,
  findExcerptMatchInDocument,
  findExcerptRangeInDocument,
  getEpubCfiConstructor,
  normalizeSpineHref,
  normalizeWhitespace,
  parseRuntimeCfi,
  recordRangeInTextMap,
  validateAndClampReadingCfi,
  validateHighlightRangeInDocument,
  type ClaimedTextSpan,
  type DocumentTextMap,
  type EpubCfiConstructor,
  type ReaderAnnotationDisplayResult,
  type ReaderCfiDisplayStatus,
  type ReaderHighlightInput,
  type ReaderHighlightResolution,
  type RenderedEpubView,
  type RuntimeParsedCfi,
} from './cfi-anchors';
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

export {
  findExcerptRangeInDocument,
  type ReaderAnnotationDisplayResult,
  type ReaderCfiDisplayStatus,
  type ReaderHighlightInput,
  type ReaderHighlightResolution,
};
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
  href?: string;
  prefix?: string;
  suffix?: string;
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
  id?: string | null;
  idref?: string | null;
  cfiBase?: string;
  href: string;
  index: number;
  contents?: unknown;
  document?: Document;
  load: (request: (url: string) => Promise<Document>) => Promise<unknown>;
  unload: () => void;
}

interface EpubTocItem {
  label: string;
  href: string;
  subitems?: EpubTocItem[];
}

interface ActiveDisplayContext {
  generation: number;
  signal: AbortSignal;
  isAborted: () => boolean;
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

function raceWithAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
  void pending.catch(() => {});
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([pending, abortPromise]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private current: Location | null = null;
  private spine: {
    sections: SpineSection[];
    indexes: Map<string, number>;
    hrefs: Map<string, string>;
  } | null = null;
  private locationGeneration = 0;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private userNavigationOrigin: ReaderLocationOrigin = 'navigation';
  private pendingLinkReturnTarget: ReaderLinkReturnTarget | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewportSize: { width: number; height: number } | null = null;
  private pendingObservedSize: { width: number; height: number } | null = null;
  private viewportTarget: HTMLElement | null = null;
  private openingInitialLocation = false;
  private initialDisplayTarget: string | null = null;
  private epubContainer: HTMLElement | null = null;
  private lockedScrollLeft = 0;
  private displayOperationCount = 0;
  private inFlightDisplayCount = 0;
  private activeDisplayAbort: AbortController | null = null;
  private aligningFocusTarget: Element | null = null;
  private displayedListener: (() => void) | null = null;
  private renderedListener: (() => void) | null = null;
  private resizedListener: (() => void) | null = null;
  private unloadedHookRegistered = false;
  private readonly trackedContents = new Set<Contents>();
  private readonly contentCleanups = new Map<Contents, Array<() => void>>();
  private highlightCfis = new Set<string>();
  private storedHighlights: ReaderHighlightInput[] = [];
  private reportedMissingHighlightIds = new Set<string>();
  private onHighlightResolution: ((resolution: ReaderHighlightResolution) => void) | null = null;
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
    onHighlightResolution?: (resolution: ReaderHighlightResolution) => void,
  ): Promise<void> {
    this.viewportTarget = target;
    this.onHighlightResolution = onHighlightResolution ?? null;
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
    this.bindEpubContainer();
    this.rendition.hooks.content.register((contents: Contents) => this.prepareContents(contents));
    if (!this.unloadedHookRegistered && this.rendition.hooks.unloaded?.register) {
      this.unloadedHookRegistered = true;
      this.rendition.hooks.unloaded.register((view: { contents?: Contents } | undefined) => {
        if (view?.contents) this.cleanupContents(view.contents);
        this.syncRenderedHighlights();
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
            const range = selection!.getRangeAt(0);
            const sectionIndex = (contents as unknown as { sectionIndex?: number }).sectionIndex;
            const href =
              typeof sectionIndex === 'number'
                ? this.getSpine().sections[sectionIndex]?.href
                : undefined;
            onSelection({
              cfi: contents.cfiFromRange(range),
              text,
              ...(href ? { href } : {}),
              ...extractSelectionContext(contents.document, range),
            });
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
    this.displayedListener = () => this.syncRenderedHighlights();
    this.rendition.on('displayed', this.displayedListener);
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
      this.initialDisplayTarget = null;
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
        this.preserveCfi(location.start.cfi, this.locationGeneration);
      }
    };
    this.rendition.on('relocated', this.relocated);
    this.renderedListener = () => {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
    };
    this.resizedListener = () => {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.syncVisibleColumnLinks();
    };
    this.rendition.on('rendered', this.renderedListener);
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
    this.syncViewportSize(target);
    this.openingInitialLocation = true;
    try {
      if (cfi) {
        if (await this.displaySavedCfi(cfi, restoreGeneration)) return;
        if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      }
      if (serverXPath) {
        if (await this.displayXPath(serverXPath, restoreGeneration)) return;
        if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      }
      if (serverPercentage && serverPercentage > 0) {
        if (await this.displayPercentage(serverPercentage, restoreGeneration)) return;
        if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      }
      await this.displayAtGeneration(undefined, restoreGeneration);
    } finally {
      this.openingInitialLocation = false;
      if (this.isCurrentLocationOperation(restoreGeneration)) {
        this.syncViewportSize(target);
      }
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
    await this.navigatePage(() => this.rendition!.next());
  }

  async previous(): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.navigatePage(() => this.rendition!.prev());
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

  updateHighlights(annotations: readonly ReaderHighlightInput[]): void {
    this.storedHighlights = annotations.map((annotation) => ({ ...annotation }));
    const activeIds = new Set(
      annotations
        .map((annotation) => annotation.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    for (const id of [...this.reportedMissingHighlightIds]) {
      if (!activeIds.has(id)) this.reportedMissingHighlightIds.delete(id);
    }
    this.syncRenderedHighlights();
  }

  async displayAnnotation(
    annotation: ReaderHighlightInput,
    signal?: AbortSignal,
  ): Promise<ReaderAnnotationDisplayResult> {
    if (!this.rendition) return { status: 'missing' };
    return this.runAbortableDisplay(
      true,
      signal,
      async (op): Promise<ReaderAnnotationDisplayResult> => {
        const CfiClass = getEpubCfiConstructor(this.rendition);
        if (!CfiClass) return { status: 'missing' };

        const trackedBefore = Boolean(
          annotation.id && this.storedHighlights.some((item) => item.id === annotation.id),
        );
        const finalizeDisplay = (
          cfi: string,
          href: string,
          canRepair: boolean,
        ): ReaderAnnotationDisplayResult => {
          if (!canRepair) return { status: 'displayed', cfi, href };
          if (!trackedBefore) return { status: 'repaired', cfi, href };
          const current = this.storedHighlights.find((item) => item.id === annotation.id);
          if (!current) return { status: 'displayed', cfi, href };
          if (current.cfi === cfi && (!current.href || current.href === href)) {
            return { status: 'repaired', cfi, href };
          }
          const applied = this.recordRepairedHighlight(annotation.id, annotation.cfi, cfi, href);
          return { status: applied ? 'repaired' : 'displayed', cfi, href };
        };

        const parsed = parseRuntimeCfi(annotation.cfi, CfiClass);
        const primarySection =
          (annotation.href ? this.findSpineSectionByHref(annotation.href) : null) ??
          (parsed ? this.resolveSpineSectionForCfi(parsed) : null);

        if (primarySection) {
          const outcome = await this.resolveAnnotationInSection(
            annotation,
            parsed,
            primarySection,
            CfiClass,
            op.isAborted,
          );
          if (op.isAborted()) return { status: 'aborted' };
          if (outcome) {
            try {
              await this.awaitRenditionDisplay(outcome.cfi, op.signal);
              if (op.isAborted()) return { status: 'aborted' };
              return finalizeDisplay(outcome.cfi, primarySection.href, outcome.repaired);
            } catch {
              return op.isAborted() ? { status: 'aborted' } : { status: 'missing' };
            }
          }
        }

        if (annotation.excerpt && normalizeWhitespace(annotation.excerpt)) {
          const crossChapter = await this.findCrossChapterAnnotation(
            annotation,
            primarySection,
            CfiClass,
            op.isAborted,
          );
          if (op.isAborted()) return { status: 'aborted' };
          if (crossChapter) {
            const canPersistRepair = annotation.excerpt.length < MAX_STORED_EXCERPT_LENGTH;
            try {
              await this.awaitRenditionDisplay(crossChapter.cfi, op.signal);
              if (op.isAborted()) {
                crossChapter.unloadAfterFailure();
                return { status: 'aborted' };
              }
              return finalizeDisplay(crossChapter.cfi, crossChapter.section.href, canPersistRepair);
            } catch {
              crossChapter.unloadAfterFailure();
              return op.isAborted() ? { status: 'aborted' } : { status: 'missing' };
            }
          }
        }

        return op.isAborted() ? { status: 'aborted' } : { status: 'missing' };
      },
      () => ({ status: 'aborted' }),
    );
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
    await this.navigate((signal) => this.awaitRenditionDisplay(target, signal));
  }

  async displayHrefStatus(href: string, signal?: AbortSignal): Promise<ReaderCfiDisplayStatus> {
    if (!this.rendition) return 'missing';
    return this.runAbortableDisplay(
      true,
      signal,
      async (op): Promise<ReaderCfiDisplayStatus> => {
        const section = this.findSpineSectionByHref(href);
        if (!section) return 'missing';
        let target = section.href;
        const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1).trim() : '';
        if (fragment) {
          const loaded = await this.loadSectionDocument(section);
          if (op.isAborted()) {
            loaded?.unloadAfterFailure();
            return 'aborted';
          }
          if (loaded?.document.getElementById(fragment)) {
            target = `${section.href}#${fragment}`;
          } else {
            loaded?.unloadAfterFailure();
          }
        }
        try {
          await this.awaitRenditionDisplay(target, op.signal);
          return op.isAborted() ? 'aborted' : 'displayed';
        } catch {
          return op.isAborted() ? 'aborted' : 'missing';
        }
      },
      () => 'aborted',
    );
  }

  async displayHref(href: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.displayHrefStatus(href, signal)) === 'displayed';
  }

  async displayCfiStatus(
    cfi: string,
    fallbackHref?: string,
    signal?: AbortSignal,
  ): Promise<ReaderCfiDisplayStatus> {
    if (!this.rendition) return 'missing';
    return this.runAbortableDisplay(
      true,
      signal,
      async (op): Promise<ReaderCfiDisplayStatus> => {
        const resolvedCfi = await this.resolveValidCfi(cfi, fallbackHref, op.isAborted);
        if (op.isAborted()) return 'aborted';
        if (!resolvedCfi || !this.rendition) return 'missing';
        try {
          await this.awaitRenditionDisplay(resolvedCfi, op.signal);
          return op.isAborted() ? 'aborted' : 'displayed';
        } catch {
          return op.isAborted() ? 'aborted' : 'missing';
        }
      },
      () => 'aborted',
    );
  }

  async displayCfi(cfi: string, fallbackHref?: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.displayCfiStatus(cfi, fallbackHref, signal)) === 'displayed';
  }

  async displayPercentageLocationStatus(
    percentage: number,
    signal?: AbortSignal,
  ): Promise<ReaderCfiDisplayStatus> {
    if (!this.rendition || !Number.isFinite(percentage) || percentage < 0) return 'missing';
    return this.runAbortableDisplay(
      true,
      signal,
      async (op): Promise<ReaderCfiDisplayStatus> => {
        const { sections } = this.getSpine();
        if (!sections.length) return 'missing';
        const position = Math.max(0, Math.min(0.999, percentage));
        const section = sections[Math.floor(position * sections.length)];
        if (!section) return 'missing';
        try {
          await this.awaitRenditionDisplay(section.href, op.signal);
          return op.isAborted() ? 'aborted' : 'displayed';
        } catch {
          return op.isAborted() ? 'aborted' : 'missing';
        }
      },
      () => 'aborted',
    );
  }

  async displayPercentageLocation(percentage: number, signal?: AbortSignal): Promise<boolean> {
    return (await this.displayPercentageLocationStatus(percentage, signal)) === 'displayed';
  }

  displayServerLocation(xpath: string, signal?: AbortSignal): Promise<boolean> {
    return this.runAbortableDisplay(
      false,
      signal,
      (op) => this.displayXPath(xpath, op.generation, op.signal),
      () => false,
    );
  }

  displayServerPercentage(percentage: number, signal?: AbortSignal): Promise<boolean> {
    return this.runAbortableDisplay(
      false,
      signal,
      (op) => this.displayPercentage(percentage, op.generation, op.signal),
      () => false,
    );
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
    const cfi = this.current?.start.cfi ?? rendition.location?.start.cfi ?? null;
    if (!cfi) return;
    if (this.userNavigationPending) {
      this.reflowPending = true;
      return;
    }
    this.preserveCfi(cfi, this.locationGeneration);
  }

  destroy(): void {
    this.abortInFlightDisplay();
    for (const contents of [...this.trackedContents]) {
      this.cleanupContents(contents);
    }
    this.trackedContents.clear();
    this.contentCleanups.clear();
    if (this.epubContainer) {
      this.epubContainer.removeEventListener('scroll', this.handleContainerScroll);
      this.epubContainer = null;
    }
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.displayedListener)
      this.rendition.off('displayed', this.displayedListener);
    if (this.rendition && this.renderedListener)
      this.rendition.off('rendered', this.renderedListener);
    if (this.rendition && this.resizedListener) this.rendition.off('resized', this.resizedListener);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportSize = null;
    this.pendingObservedSize = null;
    this.viewportTarget = null;
    this.openingInitialLocation = false;
    this.initialDisplayTarget = null;
    this.lockedScrollLeft = 0;
    this.displayOperationCount = 0;
    this.inFlightDisplayCount = 0;
    this.aligningFocusTarget = null;
    this.unloadedHookRegistered = false;
    this.rendition = null;
    this.relocated = null;
    this.displayedListener = null;
    this.renderedListener = null;
    this.resizedListener = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.onHighlightResolution = null;
    this.current = null;
    this.userNavigationStartCfi = null;
    this.appearance = null;
    this.highlightCfis.clear();
    this.storedHighlights = [];
    this.reportedMissingHighlightIds.clear();
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

  private async prepareContents(contents: Contents): Promise<void> {
    await this.harden(contents);
    this.registerContentFocusAndLinks(contents);
    this.syncVisibleColumnLinks();
    this.syncRenderedHighlights();
  }

  private harden(contents: Contents): Promise<void> {
    return sanitizeEpubDocument(contents.document, this.stylesheetCache);
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
      const completed = await this.navigate((signal) => this.awaitRenditionDisplay(cfi, signal));
      if (!completed) return;
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

  private isRealEpubRendition(): boolean {
    return Boolean(this.rendition && 'q' in this.rendition);
  }

  private isRenditionStageReady(): boolean {
    if (!this.rendition) return false;
    if (this.isRealEpubRendition()) {
      return Boolean((this.rendition as { manager?: { stage?: unknown } }).manager?.stage);
    }
    return true;
  }

  private syncViewportSize(target: HTMLElement): void {
    if (!this.rendition || !this.isRenditionStageReady()) return;
    const rect = target.getBoundingClientRect();
    const rectWidth = Math.floor(rect.width);
    const rectHeight = Math.floor(rect.height);
    const pending = this.pendingObservedSize;
    this.pendingObservedSize = null;
    const width = pending?.width || rectWidth;
    const height = pending?.height || rectHeight;
    if (!width || !height) return;
    if (this.viewportSize?.width === width && this.viewportSize.height === height) return;
    this.applyViewportResize(width, height);
  }

  private applyViewportResize(width: number, height: number): void {
    if (!this.rendition) return;
    this.viewportSize = { width, height };
    if (this.inFlightDisplayCount > 0) {
      this.abortInFlightDisplay();
    }
    this.displayOperationCount += 1;
    try {
      this.rendition.resize(width, height);
    } finally {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.displayOperationCount = Math.max(0, this.displayOperationCount - 1);
      this.syncVisibleColumnLinks();
    }
    if (
      !this.current &&
      !this.rendition.location?.start &&
      this.initialDisplayTarget !== null &&
      this.isRealEpubRendition()
    ) {
      const restoreTarget = this.initialDisplayTarget;
      void this.runDisplayOperation(() =>
        restoreTarget === '' ? this.rendition!.display() : this.rendition!.display(restoreTarget),
      ).catch(() => {});
    }
  }

  private observeViewport(target: HTMLElement): void {
    const initial = target.getBoundingClientRect();
    this.viewportSize = { width: Math.floor(initial.width), height: Math.floor(initial.height) };
    this.pendingObservedSize = null;
    if (typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this.rendition) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (!width || !height) return;
      if (this.viewportSize?.width === width && this.viewportSize.height === height) return;
      if (!this.isRenditionStageReady() || this.openingInitialLocation) {
        this.pendingObservedSize = { width, height };
        return;
      }
      this.pendingObservedSize = null;
      this.applyViewportResize(width, height);
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

  private abortInFlightDisplay(): void {
    this.locationGeneration += 1;
    this.userNavigationPending = false;
    this.userNavigationStartCfi = null;
    this.userNavigationOrigin = 'navigation';
    this.pendingLinkReturnTarget = null;
    this.activeDisplayAbort?.abort();
    this.activeDisplayAbort = null;
  }

  private async runAbortableDisplay<T>(
    userNavigation: boolean,
    externalSignal: AbortSignal | undefined,
    work: (context: ActiveDisplayContext) => Promise<T>,
    onAborted: () => T,
  ): Promise<T> {
    if (externalSignal?.aborted || !this.rendition) return onAborted();
    this.activeDisplayAbort?.abort();
    const generation = this.beginLocationOperation(userNavigation);
    const controller = new AbortController();
    this.activeDisplayAbort = controller;
    const forwardAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const isAborted = () =>
      controller.signal.aborted ||
      Boolean(externalSignal?.aborted) ||
      !this.isCurrentLocationOperation(generation);
    this.inFlightDisplayCount += 1;
    try {
      const result = await work({ generation, signal: controller.signal, isAborted });
      return isAborted() ? onAborted() : result;
    } catch (error) {
      if (isAborted()) return onAborted();
      if (userNavigation && this.isCurrentLocationOperation(generation)) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort);
      this.inFlightDisplayCount = Math.max(0, this.inFlightDisplayCount - 1);
      if (this.activeDisplayAbort === controller) {
        this.activeDisplayAbort = null;
      }
    }
  }

  private async awaitRenditionDisplay(target?: string, signal?: AbortSignal): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) throw new Error('Reader is not open.');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const canListenForError =
      typeof rendition.on === 'function' && typeof rendition.off === 'function';
    let onError: ((error: unknown) => void) | null = null;
    try {
      await this.runDisplayOperation(async () => {
        if (this.openingInitialLocation && !this.current) {
          this.initialDisplayTarget = target ?? '';
        }
        const invoke = () =>
          target === undefined ? rendition.display() : rendition.display(target);
        if (!canListenForError) {
          await raceWithAbort(invoke, signal);
          return;
        }
        const errorPromise = new Promise<never>((_, reject) => {
          onError = (error: unknown) => {
            reject(error instanceof Error ? error : new Error('Failed to display EPUB section.'));
          };
          rendition.on('displayError', onError);
        });
        await raceWithAbort(async () => {
          const displayPromise = invoke();
          void Promise.resolve(displayPromise).catch(() => {});
          await Promise.race([displayPromise, errorPromise]);
        }, signal);
      });
    } finally {
      if (onError && canListenForError) rendition.off('displayError', onError);
    }
  }

  private async displayAtGeneration(
    target: string | undefined,
    generation: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    await this.awaitRenditionDisplay(target, signal);
    return this.isCurrentLocationOperation(generation);
  }

  private async displaySavedCfi(
    cfi: string,
    generation: number,
    fallbackHref?: string,
  ): Promise<boolean> {
    if (!this.rendition || !this.isCurrentLocationOperation(generation)) return false;
    const resolvedCfi = await this.resolveValidCfi(
      cfi,
      fallbackHref,
      () => !this.isCurrentLocationOperation(generation),
    );
    if (!resolvedCfi || !this.isCurrentLocationOperation(generation)) return false;
    try {
      return await this.displayAtGeneration(resolvedCfi, generation);
    } catch {
      return false;
    }
  }

  private async displayXPath(
    xpath: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    const target = parseKavitaXPath(xpath);
    if (!target) return false;
    const section = this.getSpine().sections[target.spineIndex];
    if (!section) return false;
    try {
      await this.awaitRenditionDisplay(section.href, signal);
      if (!this.isCurrentLocationOperation(generation)) return false;
      if (target.contentXPath === '/html/body') return true;
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return false;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return false;
      const cfi = this.cfiFromXPathNode(contents, node);
      if (!(contents.range(cfi) as Range | null)) return false;
      await this.awaitRenditionDisplay(cfi, signal);
      return this.isCurrentLocationOperation(generation);
    } catch {
      // A server XPath from a changed EPUB is not safe to guess around.
      return false;
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

  private async displayPercentage(
    percentage: number,
    generation: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isFinite(percentage) || !this.isCurrentLocationOperation(generation)) return false;
    const { sections } = this.getSpine();
    if (!sections.length) return false;
    const position = Math.max(0, Math.min(0.999, percentage));
    const section = sections[Math.floor(position * sections.length)];
    if (!section) return false;
    try {
      return await this.displayAtGeneration(section.href, generation, signal);
    } catch {
      return false;
    }
  }

  private async navigatePage(display: () => Promise<unknown>): Promise<void> {
    this.activeDisplayAbort?.abort();
    this.activeDisplayAbort = null;
    const generation = this.beginLocationOperation(true);
    try {
      await this.runDisplayOperation(display);
    } catch (error) {
      if (this.isCurrentLocationOperation(generation)) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
      throw error;
    }
  }

  private navigate(
    display: (signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.rendition) return Promise.reject(new Error('Reader is not open.'));
    return this.runAbortableDisplay(
      true,
      signal,
      async (op) => {
        await this.runDisplayOperation(() => display(op.signal));
        return true;
      },
      () => false,
    );
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
    this.activeDisplayAbort?.abort();
    this.activeDisplayAbort = null;
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
    void this.runDisplayOperation(() => rendition.display(cfi)).catch(() => {
      // The current passage may disappear while a reflow is being applied.
    });
  }

  private findSpineSectionByHref(href: string): SpineSection | null {
    const clean = normalizeSpineHref(href);
    if (!clean) return null;
    const { sections, indexes } = this.getSpine();
    const candidates = [clean];
    try {
      const decoded = decodeURIComponent(clean);
      if (decoded !== clean) candidates.push(decoded);
    } catch {
      // Ignore malformed URI escapes.
    }
    const encoded = encodeURI(clean);
    if (encoded !== clean) candidates.push(encoded);

    for (const candidate of candidates) {
      const index = indexes.get(candidate);
      if (index !== undefined) return sections[index] ?? null;
    }
    const spine = this.book.spine as unknown as {
      get?: (target: string) => SpineSection | null;
    };
    if (typeof spine?.get === 'function') {
      const found = spine.get(clean);
      if (found && typeof found.href === 'string') return found;
    }
    return null;
  }

  private resolveSpineSectionForCfi(
    parsed: RuntimeParsedCfi,
    fallbackHref?: string,
  ): SpineSection | null {
    if (fallbackHref) {
      const byHref = this.findSpineSectionByHref(fallbackHref);
      if (byHref) return byHref;
    }
    const { sections } = this.getSpine();
    const spineStep = parsed.base.steps[1];
    if (spineStep?.id) {
      const byId = sections.find(
        (section) => section.id === spineStep.id || section.idref === spineStep.id,
      );
      if (byId) return byId;
      const atPos = sections[parsed.spinePos];
      if (atPos && !atPos.id && !atPos.idref) return atPos;
      return null;
    }
    return sections[parsed.spinePos] ?? null;
  }

  private getRenderedViews(): RenderedEpubView[] {
    const rendition = this.rendition as unknown as {
      views?: () => { forEach?: (visit: (view: RenderedEpubView) => void) => void };
    } | null;
    if (!rendition || typeof rendition.views !== 'function') return [];
    const collection = rendition.views();
    if (!collection || typeof collection.forEach !== 'function') return [];
    const rendered: RenderedEpubView[] = [];
    collection.forEach((view) => {
      if (view && view.displayed !== false && view.contents?.document) {
        rendered.push(view);
      }
    });
    return rendered;
  }

  private async loadSectionDocument(section: SpineSection): Promise<{
    document: Document;
    cfiBase: string | undefined;
    unloadAfterFailure: () => void;
  } | null> {
    const targetSection = this.findSpineSectionByHref(section.href) ?? section;
    const rendered = this.getRenderedViews().find((view) => view.index === targetSection.index);
    if (rendered?.contents?.document) {
      return {
        document: rendered.contents.document,
        cfiBase: rendered.contents.cfiBase ?? rendered.section?.cfiBase ?? targetSection.cfiBase,
        unloadAfterFailure: () => {},
      };
    }

    const bookLoader = (this.book as unknown as { load?: (url: string) => Promise<Document> }).load;
    if (typeof targetSection.load !== 'function' || typeof bookLoader !== 'function') return null;
    const wasLoaded = Boolean(targetSection.contents && targetSection.document);
    try {
      await targetSection.load(bookLoader.bind(this.book));
      const rawDoc = targetSection.document;
      if (!rawDoc?.documentElement) {
        if (!wasLoaded && typeof targetSection.unload === 'function') targetSection.unload();
        return null;
      }
      const missingHead =
        rawDoc.documentElement.localName.toLowerCase() === 'html' && !rawDoc.querySelector('head');
      const hasBodyUnsafeNodes = Boolean(
        rawDoc.querySelector(
          'body script, body iframe, body object, body embed, body form, body meta[http-equiv]',
        ),
      );
      let document = rawDoc;
      if (missingHead || hasBodyUnsafeNodes) {
        document = rawDoc.cloneNode(true) as Document;
        if (missingHead) {
          const headNode = document.documentElement.namespaceURI
            ? document.createElementNS(document.documentElement.namespaceURI, 'head')
            : document.createElement('head');
          document.documentElement.insertBefore(headNode, document.documentElement.firstChild);
        }
        if (hasBodyUnsafeNodes) {
          document
            .querySelectorAll('script, iframe, object, embed, form, meta[http-equiv]')
            .forEach((node) => node.remove());
        }
      }
      return {
        document,
        cfiBase: targetSection.cfiBase,
        unloadAfterFailure: () => {
          if (!wasLoaded && typeof targetSection.unload === 'function') targetSection.unload();
        },
      };
    } catch {
      if (!wasLoaded && typeof targetSection.unload === 'function') targetSection.unload();
      return null;
    }
  }

  private async resolveValidCfi(
    cfi: string,
    fallbackHref?: string,
    isAborted?: () => boolean,
  ): Promise<string | null> {
    const CfiClass = getEpubCfiConstructor(this.rendition);
    if (!CfiClass) return cfi.trim() || null;
    const parsed = parseRuntimeCfi(cfi, CfiClass);
    if (!parsed) return null;
    const section = this.resolveSpineSectionForCfi(parsed, fallbackHref);
    if (!section) return null;
    const loaded = await this.loadSectionDocument(section);
    if (!loaded) return null;
    if (isAborted?.()) {
      loaded.unloadAfterFailure();
      return null;
    }
    const validated = validateAndClampReadingCfi(
      loaded.document,
      parsed,
      cfi,
      loaded.cfiBase,
      section.index,
      CfiClass,
    );
    if (!validated) {
      loaded.unloadAfterFailure();
      return null;
    }
    return validated;
  }

  private isHighlightCandidateForView(
    annotation: ReaderHighlightInput,
    parsed: RuntimeParsedCfi | null,
    viewIndex: number,
    viewHref: string,
  ): { matches: boolean; authoritative: boolean } {
    if (annotation.href) {
      const byHref = this.findSpineSectionByHref(annotation.href);
      if (!byHref) return { matches: false, authoritative: false };
      const same = byHref.index === viewIndex || normalizeSpineHref(viewHref) === byHref.href;
      return { matches: same, authoritative: same };
    }
    if (!parsed) return { matches: false, authoritative: false };
    const targetSection = this.resolveSpineSectionForCfi(parsed);
    const same = Boolean(targetSection && targetSection.index === viewIndex);
    return { matches: same, authoritative: same };
  }

  private collectClaimedSpansForSection(
    doc: Document,
    textMap: DocumentTextMap,
    section: SpineSection,
    cfiBase: string | undefined,
    CfiClass: EpubCfiConstructor,
    excludeAnnotation: ReaderHighlightInput,
  ): { claimedSpans: ClaimedTextSpan[]; ownedCfis: Set<string>; competingBrokenCount: number } {
    const claimedSpans: ClaimedTextSpan[] = [];
    const ownedCfis = new Set<string>();
    const targetExcerpt = excludeAnnotation.excerpt
      ? normalizeWhitespace(excludeAnnotation.excerpt)
      : '';
    let competingBrokenCount = 1;
    for (const other of this.storedHighlights) {
      const sameAnnotation =
        excludeAnnotation.id !== undefined && other.id !== undefined
          ? other.id === excludeAnnotation.id
          : other.cfi === excludeAnnotation.cfi;
      if (sameAnnotation) continue;
      const otherParsed = parseRuntimeCfi(other.cfi, CfiClass);
      if (
        !this.isHighlightCandidateForView(other, otherParsed, section.index, section.href).matches
      )
        continue;
      ownedCfis.add(other.cfi.trim());
      const otherTargetSection = otherParsed
        ? this.resolveSpineSectionForCfi(otherParsed, other.href)
        : null;
      const validated =
        otherParsed && otherTargetSection?.index === section.index
          ? validateHighlightRangeInDocument(
              doc,
              otherParsed,
              other,
              cfiBase,
              section.index,
              CfiClass,
            )
          : null;
      if (validated) {
        ownedCfis.add(validated.cfi.trim());
        recordRangeInTextMap(textMap, validated.range, claimedSpans);
      } else if (
        targetExcerpt &&
        other.excerpt &&
        normalizeWhitespace(other.excerpt) === targetExcerpt
      ) {
        competingBrokenCount += 1;
      }
    }
    return { claimedSpans, ownedCfis, competingBrokenCount };
  }

  private async resolveAnnotationInSection(
    annotation: ReaderHighlightInput,
    parsed: RuntimeParsedCfi | null,
    section: SpineSection,
    CfiClass: EpubCfiConstructor,
    isAborted: () => boolean,
  ): Promise<{ cfi: string; repaired: boolean } | null> {
    const loaded = await this.loadSectionDocument(section);
    if (!loaded) return null;
    if (isAborted()) {
      loaded.unloadAfterFailure();
      return null;
    }
    const cfiMatchesSection =
      parsed !== null &&
      this.resolveSpineSectionForCfi(parsed, annotation.href)?.index === section.index;
    const direct =
      parsed && cfiMatchesSection
        ? validateHighlightRangeInDocument(
            loaded.document,
            parsed,
            annotation,
            loaded.cfiBase,
            section.index,
            CfiClass,
          )
        : null;
    if (direct) return { cfi: direct.cfi, repaired: direct.repaired };
    if (annotation.excerpt && normalizeWhitespace(annotation.excerpt)) {
      const textMap = buildDocumentTextMap(loaded.document);
      const { claimedSpans, ownedCfis, competingBrokenCount } = this.collectClaimedSpansForSection(
        loaded.document,
        textMap,
        section,
        loaded.cfiBase,
        CfiClass,
        annotation,
      );
      const matched = findExcerptMatchInDocument(loaded.document, annotation.excerpt, {
        prefix: annotation.prefix,
        suffix: annotation.suffix,
        textMap,
        claimedSpans,
        competingBrokenCount,
        requireUnambiguous: true,
      });
      if (matched && loaded.cfiBase) {
        try {
          const freshCfi = new CfiClass(matched.range, loaded.cfiBase).toString();
          if (!ownedCfis.has(freshCfi.trim())) {
            const repaired =
              freshCfi !== annotation.cfi && annotation.excerpt.length < MAX_STORED_EXCERPT_LENGTH;
            return { cfi: freshCfi, repaired };
          }
        } catch {
          // Fall through and unload temporary section.
        }
      }
    }
    loaded.unloadAfterFailure();
    return null;
  }

  private async findCrossChapterAnnotation(
    annotation: ReaderHighlightInput,
    primarySection: SpineSection | null,
    CfiClass: EpubCfiConstructor,
    isAborted: () => boolean,
  ): Promise<{ section: SpineSection; cfi: string; unloadAfterFailure: () => void } | null> {
    const excerpt = annotation.excerpt ?? '';
    const { sections } = this.getSpine();
    const candidates: Array<{
      section: SpineSection;
      cfi: string;
      score: number;
      unambiguousInSection: boolean;
      unloadAfterFailure: () => void;
    }> = [];
    let totalOccurrences = 0;

    for (const section of sections) {
      if (isAborted()) {
        for (const candidate of candidates) candidate.unloadAfterFailure();
        return null;
      }
      if (primarySection && section.index === primarySection.index) continue;
      const loaded = await this.loadSectionDocument(section);
      if (!loaded) continue;
      if (isAborted()) {
        loaded.unloadAfterFailure();
        for (const candidate of candidates) candidate.unloadAfterFailure();
        return null;
      }
      const textMap = buildDocumentTextMap(loaded.document);
      const { claimedSpans, ownedCfis, competingBrokenCount } = this.collectClaimedSpansForSection(
        loaded.document,
        textMap,
        section,
        loaded.cfiBase,
        CfiClass,
        annotation,
      );
      const matched = findExcerptMatchInDocument(loaded.document, excerpt, {
        prefix: annotation.prefix,
        suffix: annotation.suffix,
        textMap,
        claimedSpans,
        competingBrokenCount,
      });
      if (!matched || !loaded.cfiBase) {
        if (claimedSpans.length > 0) {
          const anyOccurrence = findExcerptMatchInDocument(loaded.document, excerpt, { textMap });
          if (anyOccurrence) totalOccurrences += anyOccurrence.candidateCount;
        }
        loaded.unloadAfterFailure();
        continue;
      }
      totalOccurrences += matched.candidateCount;
      try {
        const freshCfi = new CfiClass(matched.range, loaded.cfiBase).toString();
        if (ownedCfis.has(freshCfi.trim())) {
          loaded.unloadAfterFailure();
          continue;
        }
        candidates.push({
          section,
          cfi: freshCfi,
          score: matched.score,
          unambiguousInSection: matched.unambiguous,
          unloadAfterFailure: loaded.unloadAfterFailure,
        });
      } catch {
        loaded.unloadAfterFailure();
      }
    }

    if (candidates.length === 0) return null;
    let winner = candidates[0]!;
    let bestScore = winner.score;
    let tiedBestCount = 1;
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (candidate.score > bestScore) {
        bestScore = candidate.score;
        tiedBestCount = 1;
        winner = candidate;
      } else if (candidate.score === bestScore) {
        tiedBestCount += 1;
      }
    }

    const expectedContextLength =
      (annotation.prefix ? normalizeWhitespace(annotation.prefix).length : 0) +
      (annotation.suffix ? normalizeWhitespace(annotation.suffix).length : 0);
    const minContextScore = Math.max(1, Math.min(4, expectedContextLength));
    const globallyUnambiguous =
      (totalOccurrences === 1 && winner.unambiguousInSection) ||
      (bestScore >= minContextScore && tiedBestCount === 1 && winner.unambiguousInSection);

    for (const candidate of candidates) {
      if (candidate !== winner || !globallyUnambiguous) candidate.unloadAfterFailure();
    }
    return globallyUnambiguous ? winner : null;
  }

  private isRangeUsableOnView(view: RenderedEpubView, cfi: string): boolean {
    if (!view.contents || typeof view.contents.range !== 'function') return false;
    try {
      const resolved = view.contents.range(cfi);
      return Boolean(resolved && !resolved.collapsed);
    } catch {
      return false;
    }
  }

  private recordRepairedHighlight(
    id: string | undefined,
    expectedOriginalCfi: string,
    cfi: string,
    href: string,
  ): boolean {
    if (!id) return false;
    const existing = this.storedHighlights.find((item) => item.id === id);
    if (!existing || existing.cfi !== expectedOriginalCfi) return false;
    const occupied = this.storedHighlights.some(
      (item) =>
        item.id !== id && item.cfi.trim() === cfi.trim() && (!item.href || item.href === href),
    );
    if (occupied) return false;
    this.reportedMissingHighlightIds.delete(id);
    this.storedHighlights = this.storedHighlights.map((item) =>
      item.id === id ? { ...item, cfi, href } : item,
    );
    return true;
  }

  private syncRenderedHighlights(): void {
    const rendition = this.rendition;
    if (!rendition) return;

    if (typeof (rendition as unknown as { views?: unknown }).views !== 'function') {
      const next = new Set(this.storedHighlights.map((annotation) => annotation.cfi));
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
      return;
    }

    const renderedViews = this.getRenderedViews();
    if (renderedViews.length === 0) return;

    const CfiClass = getEpubCfiConstructor(rendition);
    const desired = new Set<string>();
    const repaired: Array<{ id: string; cfi: string; href: string }> = [];
    const newlyMissingIds: string[] = [];

    for (const view of renderedViews) {
      const contents = view.contents;
      if (!contents?.document) continue;
      const viewHref = view.section?.href ?? this.getSpine().sections[view.index]?.href ?? '';
      const cfiBase = contents.cfiBase ?? view.section?.cfiBase;
      const claimedSpans: ClaimedTextSpan[] = [];
      let cachedMap: DocumentTextMap | null = null;
      const getTextMap = (): DocumentTextMap => {
        if (!cachedMap) cachedMap = buildDocumentTextMap(contents.document);
        return cachedMap;
      };

      const viewCandidates: Array<{
        annotation: ReaderHighlightInput;
        parsed: RuntimeParsedCfi | null;
        authoritative: boolean;
      }> = [];
      for (const annotation of this.storedHighlights) {
        const parsed = CfiClass ? parseRuntimeCfi(annotation.cfi, CfiClass) : null;
        const candidate = this.isHighlightCandidateForView(
          annotation,
          parsed,
          view.index,
          viewHref,
        );
        if (candidate.matches) {
          viewCandidates.push({ annotation, parsed, authoritative: candidate.authoritative });
        }
      }

      const directResolved = new Map<ReaderHighlightInput, { cfi: string; repaired: boolean }>();
      for (const { annotation, parsed } of viewCandidates) {
        if (!parsed || !CfiClass) continue;
        const targetSection = this.resolveSpineSectionForCfi(parsed, annotation.href);
        if (!targetSection || targetSection.index !== view.index) continue;
        const validated = validateHighlightRangeInDocument(
          contents.document,
          parsed,
          annotation,
          cfiBase,
          view.index,
          CfiClass,
        );
        if (!validated) continue;
        if (this.isRangeUsableOnView(view, validated.cfi)) {
          directResolved.set(annotation, { cfi: validated.cfi, repaired: validated.repaired });
          recordRangeInTextMap(getTextMap(), validated.range, claimedSpans);
        } else if (typeof contents.cfiFromRange === 'function') {
          try {
            const regenerated = contents.cfiFromRange(validated.range);
            if (this.isRangeUsableOnView(view, regenerated)) {
              directResolved.set(annotation, {
                cfi: regenerated,
                repaired: validated.repaired && regenerated !== annotation.cfi,
              });
              recordRangeInTextMap(getTextMap(), validated.range, claimedSpans);
            }
          } catch {
            // Fall back to excerpt search below.
          }
        }
      }

      const brokenExcerptCounts = new Map<string, number>();
      for (const { annotation } of viewCandidates) {
        if (directResolved.has(annotation) || !annotation.excerpt) continue;
        const normalizedExcerpt = normalizeWhitespace(annotation.excerpt);
        if (!normalizedExcerpt) continue;
        brokenExcerptCounts.set(
          normalizedExcerpt,
          (brokenExcerptCounts.get(normalizedExcerpt) ?? 0) + 1,
        );
      }

      for (const { annotation, authoritative } of viewCandidates) {
        let resolvedCfi: string | null = null;
        let wasRepaired = false;
        const direct = directResolved.get(annotation);
        if (direct) {
          resolvedCfi = direct.cfi;
          wasRepaired = direct.repaired;
        } else if (annotation.excerpt && typeof contents.cfiFromRange === 'function') {
          const normalizedExcerpt = normalizeWhitespace(annotation.excerpt);
          const matched = findExcerptMatchInDocument(contents.document, annotation.excerpt, {
            prefix: annotation.prefix,
            suffix: annotation.suffix,
            textMap: getTextMap(),
            claimedSpans,
            competingBrokenCount: brokenExcerptCounts.get(normalizedExcerpt) ?? 1,
            requireUnambiguous: true,
          });
          if (matched) {
            try {
              const freshCfi = contents.cfiFromRange(matched.range);
              if (!desired.has(freshCfi) && this.isRangeUsableOnView(view, freshCfi)) {
                resolvedCfi = freshCfi;
                wasRepaired =
                  annotation.excerpt.length < MAX_STORED_EXCERPT_LENGTH &&
                  (freshCfi !== annotation.cfi || annotation.href !== viewHref);
              }
            } catch {
              resolvedCfi = null;
            }
          }
        }

        if (resolvedCfi) {
          desired.add(resolvedCfi);
          if (annotation.id) this.reportedMissingHighlightIds.delete(annotation.id);
          if (wasRepaired && annotation.id && viewHref) {
            repaired.push({ id: annotation.id, cfi: resolvedCfi, href: viewHref });
          }
        } else if (
          authoritative &&
          annotation.id &&
          !this.reportedMissingHighlightIds.has(annotation.id)
        ) {
          this.reportedMissingHighlightIds.add(annotation.id);
          newlyMissingIds.push(annotation.id);
        }
      }
    }

    for (const cfi of this.highlightCfis) {
      if (!desired.has(cfi)) {
        try {
          rendition.annotations.remove(cfi, 'highlight');
        } catch {
          // Ignore removal errors on destroyed views.
        }
      }
    }

    const applied = new Set<string>();
    for (const cfi of desired) {
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
        // Skip unrenderable ranges without aborting remaining chapter highlights.
      }
    }
    this.highlightCfis = applied;

    const appliedRepairs = repaired.filter((entry) => {
      const current = this.storedHighlights.find((item) => item.id === entry.id);
      return Boolean(
        current && this.recordRepairedHighlight(entry.id, current.cfi, entry.cfi, entry.href),
      );
    });

    if ((appliedRepairs.length > 0 || newlyMissingIds.length > 0) && this.onHighlightResolution) {
      this.onHighlightResolution({ repaired: appliedRepairs, missingIds: newlyMissingIds });
    }
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
