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
const SAFE_DATA_FONT =
  /^data:(?:font\/(?:otf|ttf|woff2?)|application\/(?:font-sfnt|font-woff2?|vnd\.ms-opentype|x-font-(?:otf|truetype|ttf|woff)));base64,[a-z0-9+/=\s]+$/i;
const SAFE_DATA_STYLESHEET = /^data:text\/css(?:;charset=[^;,]+)?(?:;base64)?,/i;
const EPUBJS_THEME_STYLE_PREFIX = 'epubjs-inserted-css-';
const PASSAGE_BLOCK_SELECTOR = 'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dt, dd, figcaption';
const FOCUSABLE_LINK_SELECTOR = 'a[href], area[href]';
const SAVED_TABINDEX_ATTR = 'data-turnleaf-tabindex';
const VIEWPORT_RECT_EPSILON = 0.5;

function createEpubElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  const namespace = document.documentElement?.namespaceURI;
  return (
    namespace ? document.createElementNS(namespace, tagName) : document.createElement(tagName)
  ) as HTMLElementTagNameMap[K];
}

function isSameOriginBlobUrl(value: string, baseURI?: string): boolean {
  if (!value.toLowerCase().startsWith('blob:')) return false;
  const inner = value.slice(5).trim();
  if (inner.toLowerCase().startsWith('nodedata:')) return true;
  try {
    const innerUrl = new URL(inner);
    const normalizedBase = baseURI?.toLowerCase().startsWith('blob:') ? baseURI.slice(5) : baseURI;
    const reference =
      normalizedBase &&
      !normalizedBase.startsWith('about:') &&
      !normalizedBase.toLowerCase().startsWith('nodedata:')
        ? new URL(normalizedBase)
        : typeof window !== 'undefined'
          ? new URL(window.location.href)
          : null;
    if (['capacitor:', 'ionic:', 'file:'].includes(innerUrl.protocol)) {
      return reference
        ? innerUrl.protocol === reference.protocol && innerUrl.host === reference.host
        : ['localhost', ''].includes(innerUrl.hostname);
    }
    if (!['http:', 'https:'].includes(innerUrl.protocol)) return false;
    if (reference && reference.origin !== 'null' && innerUrl.origin === reference.origin) {
      return true;
    }
    return ['localhost', '127.0.0.1', '[::1]'].includes(innerUrl.hostname);
  } catch {
    return false;
  }
}

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

function isSafeEpubReference(value: string, kind: EpubReferenceKind, baseURI?: string): boolean {
  const decoded = decodedReference(value);
  if (!decoded) return false;
  if (decoded.startsWith('#')) return true;
  if (kind === 'resource' && (SAFE_DATA_IMAGE.test(decoded) || SAFE_DATA_FONT.test(decoded))) {
    return true;
  }
  if (kind === 'stylesheet' && SAFE_DATA_STYLESHEET.test(decoded)) return true;
  if (kind !== 'link' && decoded.toLowerCase().startsWith('blob:')) {
    return isSameOriginBlobUrl(decoded, baseURI);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)) return false;
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return false;
  return true;
}

function sanitizeSrcset(value: string, baseURI?: string): string | null {
  const candidates = value
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const match = candidate.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match?.[1] || !isSafeEpubReference(match[1], 'resource', baseURI)) return null;
      return match[2] ? `${match[1]} ${match[2]}` : match[1];
    })
    .filter((candidate): candidate is string => candidate !== null);
  return candidates.length ? candidates.join(', ') : null;
}

export function sanitizeCss(value: string, baseURI?: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutRemoteImports = withoutComments.replace(
    /@import(?:\s*url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")\s]+))\s*\)|\s*'([^']*)'|\s*"([^"]*)"|\s+([^;\s]+))[^;]*;?/gi,
    (
      statement,
      urlSingle?: string,
      urlDouble?: string,
      urlBare?: string,
      strSingle?: string,
      strDouble?: string,
      strBare?: string,
    ) => {
      const target = urlSingle ?? urlDouble ?? urlBare ?? strSingle ?? strDouble ?? strBare ?? '';
      return isSafeEpubReference(target, 'stylesheet', baseURI) ? statement : '';
    },
  );
  return withoutRemoteImports.replace(
    /url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")]*?))\s*\)/gi,
    (whole, singleQuoted?: string, doubleQuoted?: string, unquoted?: string) => {
      const url = singleQuoted ?? doubleQuoted ?? unquoted ?? '';
      return isSafeEpubReference(url, 'resource', baseURI) ? whole : 'none';
    },
  );
}

function isLocalContentUrl(value: string, document: Document): boolean {
  try {
    const url = new URL(value, document.baseURI);
    if (url.protocol === 'blob:') return isSameOriginBlobUrl(url.href, document.baseURI);
    if (['file:', 'capacitor:', 'ionic:'].includes(url.protocol)) return true;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (
      typeof window !== 'undefined' &&
      window.location.origin !== 'null' &&
      url.origin === window.location.origin
    ) {
      return true;
    }
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
    .then(async (response) => (response.ok ? sanitizeCss(await response.text(), key) : null))
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

function isStylesheetLink(element: Element): element is HTMLLinkElement {
  return (
    element.localName === 'link' &&
    (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')
  );
}

async function sanitizeStylesheets(document: Document, cache: StylesheetCache): Promise<void> {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[href]')].filter(
    isStylesheetLink,
  );
  await Promise.all(
    links.map(async (link) => {
      const href = link.getAttribute('href') ?? '';
      const placeholder = document.createComment('');
      link.replaceWith(placeholder);
      const embedded = decodeDataStylesheet(href);
      const stylesheet = embedded
        ? sanitizeCss(embedded, document.baseURI)
        : isLocalContentUrl(href, document)
          ? await loadLocalStylesheet(new URL(href, document.baseURI), cache)
          : null;
      if (stylesheet) {
        const style = createEpubElement(document, 'style');
        style.textContent = stylesheet;
        placeholder.replaceWith(style);
      } else {
        placeholder.remove();
      }
    }),
  );
}

function installEpubContentPolicy(document: Document): void {
  const head =
    document.head ??
    document.querySelector('head') ??
    document.documentElement.insertBefore(
      createEpubElement(document, 'head'),
      document.documentElement.firstChild,
    );
  const policy = createEpubElement(document, 'meta');
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

function sanitizeEpubMarkup(document: Document, stripReservedStyleIds: boolean): void {
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
      if (
        stripReservedStyleIds &&
        name === 'id' &&
        attribute.value.startsWith(EPUBJS_THEME_STYLE_PREFIX)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name.startsWith('on') || name === 'ping') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'srcset' || name === 'imagesrcset') {
        const safeSrcset = sanitizeSrcset(attribute.value, document.baseURI);
        if (safeSrcset) element.setAttribute(attribute.name, safeSrcset);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style') {
        const safeStyle = sanitizeCss(attribute.value, document.baseURI);
        if (safeStyle) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (element.localName === 'base' && name === 'href') continue;
      if (!RESOURCE_ATTRIBUTES.has(name)) continue;
      const isStylesheet = name === 'href' && isStylesheetLink(element);
      const kind =
        name === 'href' && ['a', 'area'].includes(element.localName)
          ? 'link'
          : isStylesheet
            ? 'stylesheet'
            : 'resource';
      if (!isSafeEpubReference(attribute.value, kind, document.baseURI)) {
        element.removeAttribute(attribute.name);
        if (isStylesheet) element.remove();
      }
    }
  });

  document.querySelectorAll('style').forEach((style) => {
    if (
      !stripReservedStyleIds &&
      style.id.startsWith(EPUBJS_THEME_STYLE_PREFIX) &&
      !(style.textContent ?? '').trim()
    ) {
      return;
    }
    const safeStyle = sanitizeCss(style.textContent ?? '', document.baseURI);
    style.textContent = safeStyle;
  });
  installEpubContentPolicy(document);
}

export async function sanitizeEpubDocument(
  document: Document,
  stylesheetCache: StylesheetCache = new Map(),
): Promise<void> {
  sanitizeEpubMarkup(document, false);
  await sanitizeStylesheets(document, stylesheetCache);
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private readonly createdBlobUrls = new Set<string>();
  private readonly authorStyleMedia = new WeakMap<Element, string | null>();
  private readonly authorInlineStyles = new WeakMap<Element, string>();
  private destroyed = false;
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
  private viewportTarget: HTMLElement | null = null;
  private epubContainer: HTMLElement | null = null;
  private lockedScrollLeft = 0;
  private displayOperationCount = 0;
  private aligningFocusTarget: Element | null = null;
  private renderedListener: (() => void) | null = null;
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

  constructor(private readonly bookUrl: string | ArrayBuffer) {
    this.book = ePub(bookUrl);
    const book = this.book as typeof this.book & {
      spine?: { hooks?: { content?: { register?: (hook: (document: Document) => void) => void } } };
      loaded?: { resources?: Promise<unknown> };
      resources?: unknown;
    };
    book.spine?.hooks?.content?.register?.((document: Document) => {
      sanitizeEpubMarkup(document, true);
    });
    let currentResources: unknown = book.resources;
    if (currentResources) this.installResourceCssSanitizer(currentResources);
    Object.defineProperty(book, 'resources', {
      configurable: true,
      enumerable: true,
      get: () => currentResources,
      set: (value: unknown) => {
        currentResources = value;
        this.installResourceCssSanitizer(value);
      },
    });
    void book.loaded?.resources?.then(
      (loadedResources) => {
        this.installResourceCssSanitizer(loadedResources ?? book.resources);
      },
      () => {},
    );
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

  displayServerLocation(xpath: string): Promise<boolean> {
    return this.displayXPath(xpath, this.beginLocationOperation(false));
  }

  displayServerPercentage(percentage: number): Promise<boolean> {
    return this.displayPercentage(percentage, this.beginLocationOperation(false));
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
    const rawContents =
      typeof (rendition as Partial<Rendition>).getContents === 'function'
        ? (rendition.getContents() as unknown as Contents | Contents[])
        : [];
    const renderedContents = Array.isArray(rawContents)
      ? rawContents
      : rawContents
        ? [rawContents]
        : [];
    for (const content of renderedContents) {
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
    const bodyRules: Record<string, string> = {
      color: `${this.resolveToken(colors.text)} !important`,
      background: `${this.resolveToken(colors.background)} !important`,
      'font-size': `${value.fontSize}px !important`,
      'line-height': `${value.lineHeight} !important`,
      'text-align': value.publisherStyles ? value.alignment : `${value.alignment} !important`,
      padding: `0.5rem max(${value.margin}px, env(safe-area-inset-right)) max(${value.bottomMargin}px, env(safe-area-inset-bottom)) max(${value.margin}px, env(safe-area-inset-left)) !important`,
      'box-sizing': 'border-box',
    };
    if (!value.publisherStyles || value.fontFamily !== 'book') {
      bodyRules['font-family'] = `${family} !important`;
    }
    const paragraphRules: Record<string, string> = value.publisherStyles
      ? {
          'margin-bottom': `${value.paragraphSpacing}em`,
          hyphens,
        }
      : {
          'margin-bottom': `${value.paragraphSpacing}em !important`,
          'text-align': `${value.alignment} !important`,
          hyphens: `${hyphens} !important`,
        };
    rendition.themes.register('turnleaf', {
      html: {
        background: `${this.resolveToken(colors.background)} !important`,
        'box-sizing': 'border-box',
      },
      ...(value.publisherStyles && value.fontFamily === 'book'
        ? { ':where(body)': { 'font-family': family } }
        : {}),
      body: bodyRules,
      [value.publisherStyles ? ':where(p)' : 'p']: paragraphRules,
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
    for (const contents of renderedContents) {
      if (contents?.document) {
        this.syncPublisherStyles(contents.document, value.publisherStyles);
      }
      if (layoutChanged) {
        (contents as unknown as { expand?: () => void } | undefined)?.expand?.();
      }
    }
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
    this.destroyed = true;
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
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
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
    this.viewportTarget = null;
    this.lockedScrollLeft = 0;
    this.displayOperationCount = 0;
    this.aligningFocusTarget = null;
    this.unloadedHookRegistered = false;
    this.rendition = null;
    this.relocated = null;
    this.renderedListener = null;
    this.resizedListener = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.current = null;
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
      ...this.createdBlobUrls,
    ]);
    this.createdBlobUrls.clear();
    for (const url of urls) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.book.destroy();
  }

  private async prepareContents(contents: Contents): Promise<void> {
    await this.harden(contents);
    this.registerContentFocusAndLinks(contents);
    this.syncVisibleColumnLinks();
  }

  private async harden(contents: Contents): Promise<void> {
    await sanitizeEpubDocument(contents.document, this.stylesheetCache);
    const publisherStyles = this.appearance?.publisherStyles !== false;
    this.syncPublisherStyles(contents.document, publisherStyles);
    if (!publisherStyles) {
      (contents as unknown as { expand?: () => void }).expand?.();
    }
  }

  private readonly patchedResources = new WeakSet<object>();

  private installResourceCssSanitizer(target: unknown): void {
    const resources = target as {
      urls?: string[];
      cssUrls?: string[];
      replacementUrls?: Array<string | undefined>;
      settings?: {
        replacements?: string;
        archive?: {
          urlCache?: Record<string, string>;
          getText?: (path: string) => Promise<string> | undefined;
        };
        resolver?: (href: string) => string;
        request?: (path: string, type: string) => Promise<string> | undefined;
      };
      substitute?: (content: string, url?: string) => string;
      replaceCss?: (archive?: unknown, resolver?: unknown) => Promise<unknown>;
      createCssFile?: (
        href: string,
        archive?: unknown,
        resolver?: unknown,
      ) => Promise<string | undefined>;
    } | null;
    if (!resources || typeof resources !== 'object' || this.patchedResources.has(resources)) return;
    const originalCreateCssFile = resources.createCssFile;
    if (typeof originalCreateCssFile !== 'function') return;
    this.patchedResources.add(resources);

    const baseOrigin = (): string | undefined =>
      typeof window !== 'undefined' && window.location?.href ? window.location.href : undefined;

    const mintCssUrl = (sanitized: string): string => {
      if (resources.settings?.replacements === 'base64') {
        return `data:text/css;charset=utf-8,${encodeURIComponent(sanitized)}`;
      }
      const sanitizedUrl = URL.createObjectURL(new Blob([sanitized], { type: 'text/css' }));
      this.createdBlobUrls.add(sanitizedUrl);
      this.stylesheetCache.set(sanitizedUrl, Promise.resolve(sanitized));
      return sanitizedUrl;
    };

    const revokeMintedCssUrl = (url: string | undefined): void => {
      if (!url?.startsWith('blob:')) return;
      URL.revokeObjectURL(url);
      this.createdBlobUrls.delete(url);
      this.stylesheetCache.delete(url);
    };

    const loadSanitizedCssText = async (
      href: string,
      archive?: unknown,
      resolver?: unknown,
    ): Promise<{ absolute: string; sanitized: string } | null> => {
      if (this.destroyed || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
        return null;
      }
      const resolveHref =
        (typeof resolver === 'function' ? (resolver as (path: string) => string) : undefined) ??
        resources.settings?.resolver;
      const archiveSource =
        (archive as { getText?: (path: string) => Promise<string> | undefined } | undefined) ??
        resources.settings?.archive;
      if (typeof resolveHref !== 'function' || typeof resources.substitute !== 'function') {
        return null;
      }
      const absolute = resolveHref(href);
      const textResponse = archiveSource?.getText
        ? archiveSource.getText(absolute)
        : resources.settings?.request?.(absolute, 'text');
      if (!textResponse) return null;
      try {
        const rawText = await textResponse;
        if (this.destroyed || typeof rawText !== 'string') return null;
        const substituted = resources.substitute(rawText, absolute);
        return { absolute, sanitized: sanitizeCss(substituted, baseOrigin()) };
      } catch {
        return null;
      }
    };

    resources.createCssFile = async (href: string, archive?: unknown, resolver?: unknown) => {
      if (this.destroyed || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
        return undefined;
      }
      const direct = await loadSanitizedCssText(href, archive, resolver);
      if (direct) return mintCssUrl(direct.sanitized);
      if (
        typeof (resolver ?? resources.settings?.resolver) === 'function' &&
        typeof resources.substitute === 'function'
      ) {
        return undefined;
      }

      const rawUrl = await originalCreateCssFile.call(resources, href, archive, resolver);
      if (!rawUrl) return rawUrl;
      if (this.destroyed) {
        if (rawUrl.startsWith('blob:')) URL.revokeObjectURL(rawUrl);
        return undefined;
      }
      const embedded = decodeDataStylesheet(rawUrl);
      if (embedded !== null) {
        return `data:text/css;charset=utf-8,${encodeURIComponent(sanitizeCss(embedded, baseOrigin()))}`;
      }
      if (!rawUrl.startsWith('blob:')) return rawUrl;
      try {
        const response = await fetch(rawUrl);
        if (!response.ok) return undefined;
        const sanitized = sanitizeCss(await response.text(), rawUrl);
        if (this.destroyed) return undefined;
        return mintCssUrl(sanitized);
      } catch {
        return undefined;
      } finally {
        URL.revokeObjectURL(rawUrl);
      }
    };

    const originalReplaceCss = resources.replaceCss;
    if (typeof originalReplaceCss === 'function') {
      resources.replaceCss = async (archive?: unknown, resolver?: unknown) => {
        const { cssUrls, urls, replacementUrls } = resources;
        if (
          !Array.isArray(cssUrls) ||
          !Array.isArray(urls) ||
          !Array.isArray(replacementUrls) ||
          typeof resources.substitute !== 'function'
        ) {
          return originalReplaceCss.call(resources, archive, resolver);
        }
        const archiveCache = (
          (archive as { urlCache?: Record<string, string> } | undefined) ??
          resources.settings?.archive
        )?.urlCache;
        for (const href of cssUrls) {
          const indexInUrls = urls.indexOf(href);
          if (indexInUrls < 0) continue;
          const rawCssUrl = replacementUrls[indexInUrls];
          replacementUrls[indexInUrls] = undefined;
          if (rawCssUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(rawCssUrl);
            if (archiveCache) {
              for (const [cacheKey, cachedUrl] of Object.entries(archiveCache)) {
                if (cachedUrl === rawCssUrl) delete archiveCache[cacheKey];
              }
            }
          }
        }

        const loaded = await Promise.all(
          cssUrls.map(async (href) => {
            const indexInUrls = urls.indexOf(href);
            const result = await loadSanitizedCssText(href, archive, resolver);
            return { href, indexInUrls, result };
          }),
        );
        if (this.destroyed) return [];

        const entries: Array<{ indexInUrls: number; absolute: string; sanitized: string }> = [];
        for (const { indexInUrls, result } of loaded) {
          if (indexInUrls < 0) continue;
          if (!result) {
            replacementUrls[indexInUrls] = undefined;
            continue;
          }
          replacementUrls[indexInUrls] = mintCssUrl(result.sanitized);
          entries.push({ indexInUrls, absolute: result.absolute, sanitized: result.sanitized });
        }

        if (entries.length > 1 && entries.some((entry) => /@import/i.test(entry.sanitized))) {
          const maxPasses = Math.min(entries.length, 4);
          for (let pass = 0; pass < maxPasses; pass += 1) {
            let changed = false;
            for (const entry of entries) {
              if (!/@import/i.test(entry.sanitized)) continue;
              const nextSanitized = sanitizeCss(
                resources.substitute(entry.sanitized, entry.absolute),
                baseOrigin(),
              );
              if (nextSanitized !== entry.sanitized) {
                revokeMintedCssUrl(replacementUrls[entry.indexInUrls]);
                entry.sanitized = nextSanitized;
                replacementUrls[entry.indexInUrls] = mintCssUrl(nextSanitized);
                changed = true;
              }
            }
            if (!changed) break;
          }
        }
        return replacementUrls;
      };
    }
  }

  private syncPublisherStyles(document: Document, enabled: boolean): void {
    document.querySelectorAll<HTMLElement>('style, link').forEach((node) => {
      const isAuthorStyle =
        node.localName === 'style'
          ? !node.id.startsWith(EPUBJS_THEME_STYLE_PREFIX)
          : isStylesheetLink(node);
      if (!isAuthorStyle) return;
      (node as HTMLStyleElement | HTMLLinkElement).disabled = !enabled;
      if (!enabled) {
        if (!this.authorStyleMedia.has(node)) {
          this.authorStyleMedia.set(node, node.getAttribute('media'));
        }
        node.setAttribute('media', 'not all');
      } else if (this.authorStyleMedia.has(node)) {
        const previousMedia = this.authorStyleMedia.get(node) ?? null;
        if (previousMedia === null) node.removeAttribute('media');
        else node.setAttribute('media', previousMedia);
        this.authorStyleMedia.delete(node);
      }
    });

    document.body?.querySelectorAll<HTMLElement>('*').forEach((element) => {
      if (!enabled) {
        const inlineStyle = element.getAttribute('style');
        if (inlineStyle !== null) {
          this.authorInlineStyles.set(element, inlineStyle);
          element.removeAttribute('style');
        }
      } else if (!element.hasAttribute('style')) {
        const savedStyle = this.authorInlineStyles.get(element);
        if (savedStyle !== undefined) element.setAttribute('style', savedStyle);
      }
    });
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
      this.displayOperationCount += 1;
      try {
        this.rendition.resize(width, height);
      } finally {
        const container = this.bindEpubContainer();
        if (container) this.lockedScrollLeft = container.scrollLeft;
        this.displayOperationCount = Math.max(0, this.displayOperationCount - 1);
        this.syncVisibleColumnLinks();
      }
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
    await this.runDisplayOperation(async () => {
      if (target === undefined) await rendition.display();
      else await rendition.display(target);
    });
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
      await this.runDisplayOperation(() => rendition.display(section.href));
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
      await this.runDisplayOperation(() => rendition.display(cfi));
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

  private async displayPercentage(percentage: number, generation: number): Promise<boolean> {
    if (!Number.isFinite(percentage) || !this.isCurrentLocationOperation(generation)) return false;
    const { sections } = this.getSpine();
    if (!sections.length) return false;
    const position = Math.max(0, Math.min(0.999, percentage));
    const section = sections[Math.floor(position * sections.length)];
    if (!section) return false;
    try {
      return await this.displayAtGeneration(section.href, generation);
    } catch {
      return false;
    }
  }

  private async navigate(display: () => Promise<unknown>): Promise<void> {
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
    void this.runDisplayOperation(() => rendition.display(cfi)).catch(() => {
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
