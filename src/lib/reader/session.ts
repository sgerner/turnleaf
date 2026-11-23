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

const SAFE_DATA_IMAGE = /^data:image\/(?:gif|jpe?g|png|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const SAFE_DATA_FONT =
  /^data:(?:font\/(?:otf|ttf|woff2?)|application\/(?:font-sfnt|font-woff2?|vnd\.ms-opentype|x-font-(?:otf|truetype|ttf|woff)));base64,[a-z0-9+/=\s]+$/i;
const SAFE_DATA_STYLESHEET = /^data:text\/css(?:;charset=[^;,]+)?(?:;base64)?,/i;
const EPUBJS_THEME_STYLE_PREFIX = 'epubjs-inserted-css-';

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
        previous.publisherStyles !== value.publisherStyles ||
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
    const bodyRules: Record<string, string> = {
      color: `${this.resolveToken(colors.text)} !important`,
      background: `${this.resolveToken(colors.background)} !important`,
      'font-size': `${value.fontSize}px !important`,
      'line-height': `${value.lineHeight} !important`,
      padding: `0.5rem max(${value.margin}px, env(safe-area-inset-right)) max(${value.bottomMargin}px, env(safe-area-inset-bottom)) max(${value.margin}px, env(safe-area-inset-left)) !important`,
      'box-sizing': 'border-box',
    };
    if (!value.publisherStyles || value.fontFamily !== 'book') {
      bodyRules['font-family'] = `${family} !important`;
    }
    const paragraphRules: Record<string, string> = value.publisherStyles
      ? {
          'margin-bottom': `${value.paragraphSpacing}em`,
          'text-align': value.alignment,
          hyphens: value.hyphenation ? 'auto' : 'none',
        }
      : {
          'margin-bottom': `${value.paragraphSpacing}em !important`,
          'text-align': `${value.alignment} !important`,
          hyphens: `${value.hyphenation ? 'auto' : 'none'} !important`,
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
    const renderedContents =
      (rendition as unknown as { getContents?: () => Contents[] }).getContents?.() ?? [];
    for (const contents of renderedContents) {
      this.syncPublisherStyles(contents.document, value.publisherStyles);
      if (layoutChanged) {
        (contents as unknown as { expand?: () => void }).expand?.();
      }
    }
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
