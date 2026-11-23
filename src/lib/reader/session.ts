import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  splitReaderSearchExcerpt,
  type ReaderSearchBatch,
  type ReaderSearchCursor,
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

const USER_HIGHLIGHT_STYLES = {
  fill: '#facc15',
  'fill-opacity': '0.38',
};

const SEARCH_HIGHLIGHT_STYLES = {
  fill: '#0ea5e9',
  'fill-opacity': '0.32',
  stroke: '#0284c7',
  'stroke-opacity': '0.85',
  'stroke-width': '1.5',
};

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
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private current: Location | null = null;
  private spine: { sections: SpineSection[]; indexes: Map<string, number> } | null = null;
  private locationGeneration = 0;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private userNavigationStartPage: { index: number; page: number } | null = null;
  private userNavigationOrigin: ReaderLocationOrigin = 'navigation';
  private pendingLinkReturnTarget: ReaderLinkReturnTarget | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private windowResizeHandler: (() => void) | null = null;
  private viewportSize: { width: number; height: number } | null = null;
  private pendingViewportSize: { width: number; height: number } | null = null;
  private readyForResize = false;
  private displayInFlight = false;
  private lastDisplayedTarget: string | undefined = undefined;
  private hasDisplayedTarget = false;
  private highlightCfis = new Set<string>();
  private activeSearchCfi: string | null = null;
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
    const initialRect = target.getBoundingClientRect();
    const initialWidth = Math.floor(initialRect.width);
    const initialHeight = Math.floor(initialRect.height);
    this.viewportSize = { width: initialWidth, height: initialHeight };
    this.pendingViewportSize = null;
    this.lastDisplayedTarget = undefined;
    this.hasDisplayedTarget = false;
    this.readyForResize = false;
    this.rendition = this.book.renderTo(target, {
      width: initialWidth > 0 ? initialWidth : '100%',
      height: initialHeight > 0 ? initialHeight : '100%',
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      resizeOnOrientationChange: false,
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
      const startPage = this.userNavigationStartPage;
      const movedCfi = startCfi ? startCfi !== location.start.cfi : !this.reflowPending;
      const movedPage = startPage
        ? startPage.index !== location.start.index ||
          startPage.page !== location.start.displayed.page
        : false;
      const isUserNavigation = this.userNavigationPending && (movedCfi || movedPage);
      const origin = isUserNavigation ? this.userNavigationOrigin : 'restore';
      const returnTarget = origin === 'link' ? this.pendingLinkReturnTarget : null;
      if (startCfi !== location.start.cfi || movedPage) onSelection?.(null);
      this.current = location;
      this.lastDisplayedTarget = location.start.cfi;
      this.hasDisplayedTarget = true;
      if (isUserNavigation || this.userNavigationOrigin === 'link') {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
        this.userNavigationStartPage = null;
        this.userNavigationOrigin = 'navigation';
        this.pendingLinkReturnTarget = null;
      }
      this.reportLocation(location, origin, returnTarget);
      if (!this.userNavigationPending && this.pendingViewportSize) {
        this.reflowPending = false;
        this.flushPendingViewportResize();
        return;
      }
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
    try {
      await this.rendition.started;
      if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      let displayed = false;
      if (cfi) {
        try {
          displayed = await this.displayAtGeneration(cfi, restoreGeneration);
        } catch {
          // A saved CFI can name a section removed in a newer copy of the EPUB.
        }
      }
      if (!displayed && serverXPath) {
        displayed = await this.displayXPath(serverXPath, restoreGeneration);
      }
      if (!displayed && serverPercentage && serverPercentage > 0) {
        displayed = await this.displayPercentage(serverPercentage, restoreGeneration);
      }
      if (!displayed) {
        await this.displayAtGeneration(undefined, restoreGeneration);
      }
      if (this.isCurrentLocationOperation(restoreGeneration)) {
        this.readyForResize = true;
        this.flushPendingViewportResize();
      }
    } finally {
      if (this.rendition && this.isCurrentLocationOperation(restoreGeneration)) {
        this.readyForResize = true;
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
      if (!next.has(cfi) && cfi !== this.activeSearchCfi) {
        rendition.annotations.remove(cfi, 'highlight');
      }
    }

    const applied = new Set<string>();
    for (const cfi of next) {
      if (this.highlightCfis.has(cfi) || cfi === this.activeSearchCfi) {
        applied.add(cfi);
        continue;
      }
      if (this.applyUserHighlight(cfi)) {
        applied.add(cfi);
      }
    }
    this.highlightCfis = applied;
  }

  setSearchHighlight(cfi: string | null): void {
    const rendition = this.rendition;
    const nextCfi = cfi?.trim() || null;
    if (!rendition) {
      this.activeSearchCfi = nextCfi;
      return;
    }
    if (this.activeSearchCfi === nextCfi) return;

    const previousCfi = this.activeSearchCfi;
    this.activeSearchCfi = null;
    if (previousCfi) {
      rendition.annotations.remove(previousCfi, 'highlight');
      if (this.highlightCfis.has(previousCfi)) {
        this.applyUserHighlight(previousCfi);
      }
    }

    if (!nextCfi) return;

    if (this.highlightCfis.has(nextCfi)) {
      rendition.annotations.remove(nextCfi, 'highlight');
    }
    try {
      rendition.annotations.highlight(
        nextCfi,
        {},
        undefined,
        'turnleaf-search-highlight',
        SEARCH_HIGHLIGHT_STYLES,
      );
      this.activeSearchCfi = nextCfi;
    } catch {
      if (this.highlightCfis.has(nextCfi)) {
        this.applyUserHighlight(nextCfi);
      }
    }
  }

  private applyUserHighlight(cfi: string): boolean {
    if (!this.rendition) return false;
    try {
      this.rendition.annotations.highlight(
        cfi,
        {},
        undefined,
        'turnleaf-highlight',
        USER_HIGHLIGHT_STYLES,
      );
      return true;
    } catch {
      // A saved CFI can stop matching after an EPUB is replaced or changed.
      return false;
    }
  }

  async search(
    query: string,
    signal?: AbortSignal,
    limit = 100,
    cursor: ReaderSearchCursor | null = null,
  ): Promise<ReaderSearchBatch> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const normalizedQuery = normalizeReaderSearchQuery(query);
    const { sections } = this.getSpine();
    const totalChapters = sections.length;
    if (!normalizedQuery || limit <= 0) {
      return {
        results: [],
        scannedChapters: 0,
        skippedChapters: 0,
        totalChapters,
        nextCursor: null,
      };
    }

    const startSection = Math.max(0, cursor?.sectionIndex ?? 0);
    const initialMatchIndex = Math.max(0, cursor?.matchIndex ?? 0);
    if (startSection >= totalChapters) {
      return {
        results: [],
        scannedChapters: 0,
        skippedChapters: 0,
        totalChapters,
        nextCursor: null,
      };
    }

    const results: ReaderSearchResult[] = [];
    const request = this.book.load.bind(this.book) as (url: string) => Promise<Document>;
    let scannedChapters = 0;

    for (
      let sectionPosition = startSection;
      sectionPosition < totalChapters;
      sectionPosition += 1
    ) {
      const section = sections[sectionPosition]!;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const wasLoaded = Boolean((section as unknown as { contents?: unknown }).contents);
      try {
        await section.load(request);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        scannedChapters += 1;
        const rawMatches = (
          section as unknown as {
            search: (value: string) => Array<{ cfi: string; excerpt: string }>;
          }
        ).search(normalizedQuery);
        const matches = rawMatches.filter((match) => Boolean(match.cfi));
        const matchStart = sectionPosition === startSection ? initialMatchIndex : 0;

        for (let matchIndex = matchStart; matchIndex < matches.length; matchIndex += 1) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const match = matches[matchIndex]!;
          const excerpt = clipReaderSearchExcerpt(match.excerpt, 180, normalizedQuery);
          results.push({
            cfi: match.cfi,
            excerpt,
            segments: splitReaderSearchExcerpt(excerpt, normalizedQuery),
            href: section.href,
            spineIndex: section.index,
          });
          if (results.length >= limit) {
            const hasMoreInSection = matchIndex + 1 < matches.length;
            const hasMoreSections = sectionPosition + 1 < totalChapters;
            const nextCursor: ReaderSearchCursor | null = hasMoreInSection
              ? { sectionIndex: sectionPosition, matchIndex: matchIndex + 1 }
              : hasMoreSections
                ? { sectionIndex: sectionPosition + 1, matchIndex: 0 }
                : null;
            return {
              results,
              scannedChapters,
              skippedChapters: totalChapters - (sectionPosition + 1),
              totalChapters,
              nextCursor,
            };
          }
        }
      } finally {
        if (!wasLoaded) section.unload();
      }
    }

    return {
      results,
      scannedChapters,
      skippedChapters: 0,
      totalChapters,
      nextCursor: null,
    };
  }

  async display(href: string, userNavigation = true): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    if (userNavigation) {
      this.lastDisplayedTarget = href;
      this.hasDisplayedTarget = true;
      await this.navigate(() => this.rendition!.display(href));
      return;
    }
    const generation = this.beginLocationOperation(false);
    await this.displayAtGeneration(href, generation);
  }

  async displayCfi(cfi: string, userNavigation = true): Promise<boolean> {
    if (!this.rendition) return false;
    try {
      if (userNavigation) {
        this.lastDisplayedTarget = cfi;
        this.hasDisplayedTarget = true;
        await this.navigate(() => this.rendition!.display(cfi));
        return true;
      }
      return await this.displayAtGeneration(cfi, this.beginLocationOperation(false));
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
    const cfi = this.liveLocation()?.start.cfi ?? null;
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
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.windowResizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.windowResizeHandler);
    }
    this.windowResizeHandler = null;
    this.viewportSize = null;
    this.pendingViewportSize = null;
    this.readyForResize = false;
    this.displayInFlight = false;
    this.lastDisplayedTarget = undefined;
    this.hasDisplayedTarget = false;
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.current = null;
    this.userNavigationPending = false;
    this.userNavigationStartCfi = null;
    this.userNavigationStartPage = null;
    this.appearance = null;
    this.highlightCfis.clear();
    this.activeSearchCfi = null;
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
    const handleViewportSize = (width: number, height: number): void => {
      if (!this.rendition || !width || !height) return;
      if (this.viewportSize?.width === width && this.viewportSize.height === height) {
        this.pendingViewportSize = null;
        return;
      }
      if (!this.readyForResize || this.displayInFlight || this.userNavigationPending) {
        this.pendingViewportSize = { width, height };
        return;
      }
      this.applyViewportResize(width, height);
    };

    if (typeof ResizeObserver === 'undefined') {
      if (typeof window !== 'undefined') {
        this.windowResizeHandler = () => {
          const rect = target.getBoundingClientRect();
          handleViewportSize(Math.floor(rect.width), Math.floor(rect.height));
        };
        window.addEventListener('resize', this.windowResizeHandler);
      }
      return;
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      handleViewportSize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height));
    });
    this.resizeObserver.observe(target);
  }

  private flushPendingViewportResize(): void {
    if (
      !this.readyForResize ||
      this.displayInFlight ||
      this.userNavigationPending ||
      !this.pendingViewportSize
    ) {
      return;
    }
    const { width, height } = this.pendingViewportSize;
    this.pendingViewportSize = null;
    if (!width || !height) return;
    if (this.viewportSize?.width === width && this.viewportSize.height === height) return;
    this.applyViewportResize(width, height);
  }

  private applyViewportResize(width: number, height: number): void {
    const rendition = this.rendition;
    if (!rendition) return;
    const internal = rendition as Rendition & {
      resize: (width?: number, height?: number, epubcfi?: string) => void;
      manager?: { rendered?: boolean; stage?: unknown; views?: { length?: number } };
    };
    if (internal.manager && (!internal.manager.rendered || !internal.manager.stage)) {
      this.pendingViewportSize = { width, height };
      return;
    }
    const hadLocation = Boolean(rendition.location?.start?.cfi);
    const cfi = this.liveLocation()?.start.cfi;
    const fallbackTarget = cfi ?? this.lastDisplayedTarget;
    this.viewportSize = { width, height };
    if (cfi) internal.resize(width, height, cfi);
    else internal.resize(width, height);
    const viewsAfter = internal.manager?.views?.length ?? 0;
    if (internal.manager && !hadLocation && viewsAfter === 0 && this.hasDisplayedTarget) {
      const generation = this.locationGeneration;
      this.displayInFlight = true;
      const recovery =
        fallbackTarget === undefined ? rendition.display() : rendition.display(fallbackTarget);
      void recovery
        .catch(() => {
          if (fallbackTarget !== undefined && this.isCurrentLocationOperation(generation)) {
            return rendition.display().catch(() => {});
          }
          return undefined;
        })
        .finally(() => {
          this.displayInFlight = false;
          this.flushPendingViewportResize();
        });
    }
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
    this.displayInFlight = true;
    try {
      if (target === undefined) await rendition.display();
      else await rendition.display(target);
      if (this.isCurrentLocationOperation(generation)) {
        if (!this.current) this.current = this.liveLocation();
        this.lastDisplayedTarget = target;
        this.hasDisplayedTarget = true;
        return true;
      }
      return false;
    } finally {
      this.displayInFlight = false;
      this.flushPendingViewportResize();
    }
  }

  private async displayXPath(xpath: string, generation: number): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    const target = parseKavitaXPath(xpath);
    if (!target) return false;
    const section = this.getSpine().sections[target.spineIndex];
    if (!section) return false;
    this.displayInFlight = true;
    try {
      await rendition.display(section.href);
      if (!this.isCurrentLocationOperation(generation)) return false;
      if (!this.current) this.current = this.liveLocation();
      this.lastDisplayedTarget = section.href;
      this.hasDisplayedTarget = true;
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
      if (this.isCurrentLocationOperation(generation)) {
        this.current = this.liveLocation() ?? this.current;
        this.lastDisplayedTarget = cfi;
        this.hasDisplayedTarget = true;
        return true;
      }
      return false;
    } catch {
      // A server XPath from a changed EPUB is not safe to guess around.
      return false;
    } finally {
      this.displayInFlight = false;
      this.flushPendingViewportResize();
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
    this.displayInFlight = true;
    try {
      await display();
    } catch (error) {
      if (this.isCurrentLocationOperation(generation)) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
        this.userNavigationStartPage = null;
      }
      throw error;
    } finally {
      this.displayInFlight = false;
      this.flushPendingViewportResize();
    }
  }

  private liveLocation(): Location | null {
    const currentLocation: unknown = (
      this.rendition as { currentLocation?: () => unknown } | null
    )?.currentLocation?.();
    if (
      currentLocation &&
      typeof currentLocation === 'object' &&
      'start' in currentLocation &&
      (currentLocation as Location).start?.cfi
    ) {
      return currentLocation as Location;
    }
    return this.current ?? this.rendition?.location ?? null;
  }

  private beginLocationOperation(userNavigation: boolean): number {
    this.locationGeneration += 1;
    this.userNavigationPending = userNavigation;
    this.userNavigationOrigin = userNavigation ? 'navigation' : 'restore';
    this.pendingLinkReturnTarget = null;
    const start = userNavigation ? this.liveLocation()?.start : null;
    this.userNavigationStartCfi = start?.cfi ?? null;
    this.userNavigationStartPage = start
      ? { index: start.index, page: start.displayed.page }
      : null;
    return this.locationGeneration;
  }

  private beginLinkedNavigation(): void {
    const start = this.liveLocation()?.start;
    if (!start) return;
    this.locationGeneration += 1;
    this.userNavigationPending = true;
    this.userNavigationStartCfi = start.cfi;
    this.userNavigationStartPage = { index: start.index, page: start.displayed.page };
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
