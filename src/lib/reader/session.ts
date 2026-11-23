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

export type ReaderLocationOrigin = 'link' | 'navigation' | 'restore';

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

const REMOVABLE_ELEMENTS = new Set(['script', 'iframe', 'object', 'embed', 'form']);
const SANITIZED_NONCE_ATTRIBUTE = 'data-turnleaf-sanitized';
const MAX_STYLESHEET_CACHE_ENTRIES = 32;

const SAFE_DATA_IMAGE = /^data:image\/(?:gif|jpe?g|png|webp|avif);base64,[a-z0-9+/=\t\r\n ]+$/i;
const SAFE_DATA_FONT =
  /^data:font\/(?:woff2?|ttf|otf|sfnt|collection|opentype|truetype)(?:;charset=[a-z0-9._-]+)?;base64,[a-z0-9+/=\t\r\n ]+$/i;
const SAFE_DATA_STYLESHEET = /^data:text\/css(?:;charset=[^;,\r\n]+)?(?:;base64)?,/i;
const BASE64_PAYLOAD = /^[a-z0-9+/=\t\r\n ]*$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_CSS_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CSS_NEEDS_SANITIZATION = /@import|url\(/i;
const CSS_IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:'([^']*)'\s*|"([^"]*)"\s*|([^'")\s][^')"]*))\)|'([^']*)'|"([^"]*)"|([^\s;'")]+))([^;{}]*;?)/gi;
const CSS_URL_PATTERN = /url\(\s*(?:'([^']*)'\s*|"([^"]*)"\s*|([^'")\s][^')"]*)?)\)/gi;
const STYLESHEET_REL_TOKEN = /(?:^|\s)stylesheet(?:\s|$)/i;

function hasUnsafeControl(value: string): boolean {
  return UNSAFE_CONTROL_CHARACTER.test(value);
}

function decodedReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || hasUnsafeControl(trimmed)) return null;
  if (!trimmed.includes('%')) return trimmed;
  try {
    const decoded = decodeURIComponent(trimmed).trim();
    return hasUnsafeControl(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function isSafeEpubReference(value: string, kind: EpubReferenceKind): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:/i.test(trimmed)) {
    if (kind === 'resource') {
      return SAFE_DATA_IMAGE.test(trimmed) || SAFE_DATA_FONT.test(trimmed);
    }
    return kind === 'stylesheet' && decodeDataStylesheet(trimmed) !== null;
  }
  const decoded = decodedReference(trimmed);
  if (!decoded) return false;
  if (decoded.startsWith('#')) return true;
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

function resolveRelativeStylesheetAsset(reference: string, baseUrl?: URL): string | null {
  if (!baseUrl) return null;
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:data|blob):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

function sanitizeCss(value: string, baseUrl?: URL): string {
  if (!CSS_NEEDS_SANITIZATION.test(value)) return value;
  const withoutRemoteImports = value.replace(
    CSS_IMPORT_PATTERN,
    (
      statement,
      urlSingle?: string,
      urlDouble?: string,
      urlBare?: string,
      strSingle?: string,
      strDouble?: string,
      strBare?: string,
      suffix = '',
    ) => {
      const target = urlSingle ?? urlDouble ?? urlBare ?? strSingle ?? strDouble ?? strBare ?? '';
      if (!target || !isSafeEpubReference(target, 'resource')) return '';
      const resolved = resolveRelativeStylesheetAsset(target, baseUrl);
      return resolved ? `@import "${resolved}"${suffix}` : statement;
    },
  );
  return withoutRemoteImports.replace(
    CSS_URL_PATTERN,
    (whole, singleQuoted?: string, doubleQuoted?: string, unquoted?: string) => {
      const target = singleQuoted ?? doubleQuoted ?? unquoted ?? '';
      if (!isSafeEpubReference(target, 'resource')) return 'none';
      const resolved = resolveRelativeStylesheetAsset(target, baseUrl);
      return resolved ? `url("${resolved}")` : whole;
    },
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
  const trimmed = value.trim();
  if (!SAFE_DATA_STYLESHEET.test(trimmed)) return null;
  const separator = trimmed.indexOf(',');
  const metadata = trimmed.slice(0, separator).toLowerCase();
  const body = trimmed.slice(separator + 1);
  try {
    if (metadata.endsWith(';base64')) {
      if (!BASE64_PAYLOAD.test(body)) return null;
      const decoded = atob(body.replace(/[\t\r\n ]+/g, ''));
      return UNSAFE_CSS_CONTROL_CHARACTER.test(decoded) ? null : decoded;
    }
    if (hasUnsafeControl(body)) return null;
    const decoded = decodeURIComponent(body);
    return UNSAFE_CSS_CONTROL_CHARACTER.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

interface StylesheetCacheEntry {
  promise: Promise<string | null>;
  blobUrl: string | null;
  revoked: boolean;
}

export type StylesheetCache = Map<string, StylesheetCacheEntry>;

interface SanitizeEpubOptions {
  nonce?: string | undefined;
  archived?: boolean | undefined;
  preservedStylesheetPaths?: ReadonlySet<string> | undefined;
  sectionUrl?: string | undefined;
}

function revokeStylesheetCacheEntry(entry: StylesheetCacheEntry): void {
  entry.revoked = true;
  if (entry.blobUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  entry.blobUrl = null;
}

function createSanitizationNonce(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function resolveArchivePath(href: string, basePath?: string): string | null {
  try {
    const base = basePath
      ? new URL(basePath.startsWith('/') ? basePath : `/${basePath}`, 'https://epub.local')
      : new URL('https://epub.local/');
    const resolved = new URL(href, base);
    if (resolved.origin !== 'https://epub.local') return null;
    return decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
}

async function loadLocalStylesheet(url: URL, cache: StylesheetCache): Promise<string | null> {
  const key = url.href;
  const existing = cache.get(key);
  if (existing && !existing.revoked) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.promise;
  }
  const entry: StylesheetCacheEntry = {
    promise: Promise.resolve(null),
    blobUrl: null,
    revoked: false,
  };
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) return null;
      const sanitized = sanitizeCss(await response.text(), url);
      if (entry.revoked) return null;
      const blobUrl = URL.createObjectURL(new Blob([sanitized], { type: 'text/css' }));
      if (entry.revoked) {
        URL.revokeObjectURL(blobUrl);
        return null;
      }
      entry.blobUrl = blobUrl;
      return blobUrl;
    })
    .catch(() => null);
  entry.promise = request;
  if (cache.size >= MAX_STYLESHEET_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      if (evicted) revokeStylesheetCacheEntry(evicted);
    }
  }
  cache.set(key, entry);
  const stylesheet = await request;
  if (stylesheet === null && cache.get(key) === entry) cache.delete(key);
  return stylesheet;
}

function isCachedStylesheetBlob(href: string, cache: StylesheetCache): boolean {
  for (const entry of cache.values()) {
    if (!entry.revoked && entry.blobUrl === href) return true;
  }
  return false;
}

async function sanitizeStylesheets(
  document: Document,
  links: HTMLLinkElement[],
  cache: StylesheetCache,
  options?: SanitizeEpubOptions,
): Promise<void> {
  if (!links.length) return;
  await Promise.all(
    links.map(async (link) => {
      const href = (link.getAttribute('href') ?? '').trim();
      if (!href) {
        link.remove();
        return;
      }
      if (SAFE_DATA_STYLESHEET.test(href)) {
        const embedded = decodeDataStylesheet(href);
        const stylesheet = embedded !== null ? sanitizeCss(embedded) : '';
        if (stylesheet) {
          const style = document.createElement('style');
          style.textContent = stylesheet;
          link.replaceWith(style);
        } else {
          link.remove();
        }
        return;
      }
      if (isCachedStylesheetBlob(href, cache)) {
        return;
      }
      if (options?.archived) {
        const archivePath = resolveArchivePath(href, options.sectionUrl);
        if (!archivePath || !options.preservedStylesheetPaths?.has(archivePath)) {
          link.remove();
        }
        return;
      }
      if (!isLocalContentUrl(href, document)) {
        link.remove();
        return;
      }
      const blobUrl = await loadLocalStylesheet(new URL(href, document.baseURI), cache);
      if (!blobUrl) {
        link.remove();
      } else if (link.getAttribute('href') !== blobUrl) {
        link.setAttribute('href', blobUrl);
      }
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

function nextElementSkippingChildren(node: Element, root: Element): Element | null {
  let cursor: Element | null = node;
  while (cursor && cursor !== root) {
    if (cursor.nextElementSibling) return cursor.nextElementSibling;
    cursor = cursor.parentElement;
  }
  return null;
}

function hasHttpEquivAttribute(element: Element): boolean {
  if (element.hasAttribute('http-equiv')) return true;
  return (
    element.hasAttributes() &&
    element
      .getAttributeNames()
      .some((attributeName) => attributeName.toLowerCase() === 'http-equiv')
  );
}

export async function sanitizeEpubDocument(
  document: Document,
  stylesheetCache: StylesheetCache = new Map(),
  options?: SanitizeEpubOptions,
): Promise<void> {
  const root = document.documentElement;
  if (!root) return;
  if (options?.nonce && root.getAttribute(SANITIZED_NONCE_ATTRIBUTE) === options.nonce) {
    return;
  }

  const stylesheetLinks: HTMLLinkElement[] = [];
  let current: Element | null = root;
  while (current) {
    const element = current;
    const tag = element.localName.toLowerCase();

    if (REMOVABLE_ELEMENTS.has(tag) || (tag === 'meta' && hasHttpEquivAttribute(element))) {
      const next = nextElementSkippingChildren(element, root);
      element.remove();
      current = next;
      continue;
    }

    if (tag === 'base') {
      const href = element.getAttribute('href') ?? '';
      if (!isSafeBaseReference(href, document)) {
        const next = nextElementSkippingChildren(element, root);
        element.remove();
        current = next;
        continue;
      }
    }

    let isStylesheetLink = false;
    if (element.hasAttributes()) {
      isStylesheetLink =
        tag === 'link' && STYLESHEET_REL_TOKEN.test(element.getAttribute('rel') ?? '');
      for (const attributeName of element.getAttributeNames()) {
        const name = attributeName.toLowerCase();
        if (name === SANITIZED_NONCE_ATTRIBUTE || name.startsWith('on') || name === 'ping') {
          element.removeAttribute(attributeName);
          continue;
        }
        if (name === 'srcset' || name === 'imagesrcset') {
          const value = element.getAttribute(attributeName) ?? '';
          const safeSrcset = sanitizeSrcset(value);
          if (!safeSrcset) element.removeAttribute(attributeName);
          else if (safeSrcset !== value) element.setAttribute(attributeName, safeSrcset);
          continue;
        }
        if (name === 'style') {
          const value = element.getAttribute(attributeName) ?? '';
          const safeStyle = sanitizeCss(value);
          if (!safeStyle) element.removeAttribute(attributeName);
          else if (safeStyle !== value) element.setAttribute(attributeName, safeStyle);
          continue;
        }
        if (tag === 'base' && name === 'href') continue;
        if (!RESOURCE_ATTRIBUTES.has(name)) continue;
        const value = element.getAttribute(attributeName) ?? '';
        const kind: EpubReferenceKind =
          name === 'href' && (tag === 'a' || tag === 'area')
            ? 'link'
            : name === 'href' && isStylesheetLink
              ? 'stylesheet'
              : 'resource';
        if (!isSafeEpubReference(value, kind)) element.removeAttribute(attributeName);
      }
    }

    if (tag === 'style') {
      const rawCss = element.textContent ?? '';
      const safeCss = sanitizeCss(rawCss);
      if (safeCss !== rawCss) element.textContent = safeCss;
    } else if (isStylesheetLink) {
      if (element.hasAttribute('href')) {
        stylesheetLinks.push(element as HTMLLinkElement);
      } else {
        const next = nextElementSkippingChildren(element, root);
        element.remove();
        current = next;
        continue;
      }
    }

    current = element.firstElementChild ?? nextElementSkippingChildren(element, root);
  }

  if (!document.documentElement) return;
  installEpubContentPolicy(document);
  await sanitizeStylesheets(document, stylesheetLinks, stylesheetCache, options);
  if (options?.nonce) {
    document.documentElement.setAttribute(SANITIZED_NONCE_ATTRIBUTE, options.nonce);
  }
}

interface BookArchive {
  urlCache?: Record<string, string>;
  getText?: (url: string) => Promise<string> | undefined;
}

interface BookResources {
  urls?: string[];
  cssUrls?: string[];
  replacementUrls?: string[];
  settings?: { resolver?: (href: string) => string };
  substitute?: (content: string, url?: string) => string;
}

interface InternalBook {
  archived?: boolean;
  archive?: BookArchive;
  resources?: BookResources;
  resolve?: (path: string, absolute?: boolean) => string;
  spine?: {
    hooks?: {
      content?: {
        register: (
          hook: (document: Document, section?: SpineSection & { url?: string }) => Promise<void>,
        ) => void;
      };
    };
  };
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private readonly sanitizationNonce = createSanitizationNonce();
  private sanitizedResourcePaths: Promise<ReadonlySet<string>> | null = null;
  private destroyed = false;
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private current: Location | null = null;
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
    this.destroyed = false;
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
    const internalBook = this.book as typeof this.book & InternalBook;
    internalBook.spine?.hooks?.content?.register(
      (document: Document, section?: SpineSection & { url?: string }) =>
        this.hardenSpineDocument(document, section),
    );
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
      this.reportLocation(location, origin, returnTarget);
      if (this.reflowPending) {
        this.reflowPending = false;
        this.preserveCfi(location.start.cfi, this.locationGeneration);
      }
    };
    this.rendition.on('relocated', this.relocated);
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
    if (!this.isCurrentLocationOperation(restoreGeneration)) return;
    await this.ensureResourcesSanitized();
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
        previous.hyphenation !== value.hyphenation);
    const themeChanged = !previous || previous.mode !== value.mode || layoutChanged;
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
    this.destroyed = true;
    this.locationGeneration += 1;
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportSize = null;
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.current = null;
    this.userNavigationStartCfi = null;
    this.appearance = null;
    this.highlightCfis.clear();
    this.reflowPending = false;
    this.spine = null;
    this.sanitizedResourcePaths = null;
    // EPUB.js 0.3 revokes its archive cache's keys, which are file paths.
    const book = this.book as typeof this.book & InternalBook;
    const urls = new Set([
      ...Object.values(book.archive?.urlCache ?? {}),
      ...(book.resources?.replacementUrls ?? []),
    ]);
    for (const entry of this.stylesheetCache.values()) {
      entry.revoked = true;
      if (entry.blobUrl) {
        urls.add(entry.blobUrl);
        entry.blobUrl = null;
      }
    }
    this.stylesheetCache.clear();
    for (const url of urls) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.book.destroy();
  }

  private harden(contents: Contents): Promise<void> {
    if (
      contents.document.documentElement?.getAttribute(SANITIZED_NONCE_ATTRIBUTE) ===
      this.sanitizationNonce
    ) {
      return Promise.resolve();
    }
    return sanitizeEpubDocument(contents.document, this.stylesheetCache, {
      nonce: this.sanitizationNonce,
    });
  }

  private async hardenSpineDocument(
    document: Document,
    section?: SpineSection & { url?: string },
  ): Promise<void> {
    const internalBook = this.book as typeof this.book & InternalBook;
    const preservedStylesheetPaths = await this.ensureResourcesSanitized();
    return sanitizeEpubDocument(document, this.stylesheetCache, {
      nonce: this.sanitizationNonce,
      archived: Boolean(internalBook.archived),
      preservedStylesheetPaths,
      sectionUrl: section?.url ?? section?.href,
    });
  }

  private ensureResourcesSanitized(): Promise<ReadonlySet<string>> {
    this.sanitizedResourcePaths ??= this.sanitizeBookResources();
    return this.sanitizedResourcePaths;
  }

  private async sanitizeBookResources(): Promise<ReadonlySet<string>> {
    const paths = new Set<string>();
    const internalBook = this.book as typeof this.book & InternalBook;
    const resources = internalBook.resources;
    if (!resources?.urls || !resources.cssUrls || !resources.replacementUrls?.length) {
      return paths;
    }
    const resolver =
      resources.settings?.resolver ??
      (typeof internalBook.resolve === 'function'
        ? (href: string) => internalBook.resolve!(href, true)
        : undefined);

    await Promise.all(
      resources.cssUrls.map(async (cssHref) => {
        const index = resources.urls!.indexOf(cssHref);
        if (index < 0) return;
        const currentUrl = resources.replacementUrls![index];
        if (!currentUrl) return;

        const canonicalHref = resolver ? resolver(cssHref) : cssHref;
        let rawCss: string | null = null;
        if (typeof internalBook.archive?.getText === 'function') {
          try {
            const archiveText = await internalBook.archive.getText(canonicalHref);
            if (typeof archiveText === 'string') {
              rawCss =
                typeof resources.substitute === 'function'
                  ? resources.substitute(archiveText, canonicalHref)
                  : archiveText;
            }
          } catch {
            rawCss = null;
          }
        }
        if (rawCss === null) {
          if (/^data:/i.test(currentUrl)) {
            rawCss = decodeDataStylesheet(currentUrl);
          } else if (currentUrl.startsWith('blob:')) {
            try {
              const response = await fetch(currentUrl);
              rawCss = response.ok ? await response.text() : null;
            } catch {
              rawCss = null;
            }
          }
        }
        if (rawCss === null) {
          if (currentUrl.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
          resources.replacementUrls![index] = '';
          return;
        }

        const sanitized = sanitizeCss(rawCss);
        if (this.destroyed) return;

        if (sanitized !== rawCss || !currentUrl.startsWith('blob:')) {
          const nextBlobUrl = URL.createObjectURL(new Blob([sanitized], { type: 'text/css' }));
          if (this.destroyed) {
            URL.revokeObjectURL(nextBlobUrl);
            return;
          }
          if (currentUrl.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
          resources.replacementUrls![index] = nextBlobUrl;
        }

        const canonicalPath = resolveArchivePath(canonicalHref);
        if (canonicalPath) paths.add(canonicalPath);
      }),
    );
    return paths;
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
      if (target.contentXPath === '/html/body') return true;
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return false;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return false;
      const cfi = this.cfiFromXPathNode(contents, node);
      if (!(contents.range(cfi) as Range | null)) return false;
      await rendition.display(cfi);
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
