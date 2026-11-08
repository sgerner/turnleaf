import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  type ReaderSearchResult,
} from './search';
import {
  kavitaXPathToCfi,
  parseKavitaXPath,
  resolveContentXPath,
  toKavitaXPath,
} from './kavita-xpath';

export {
  kavitaXPathToCfi,
  parseKavitaXPath,
  resolveContentXPath,
  toKavitaXPath,
} from './kavita-xpath';

export interface ReaderLocation {
  cfi: string;
  xpath: string | null;
  href: string;
  percentage: number;
  spineIndex: number;
  pageIndex: number;
  pageCount: number;
}

export type ReaderLocationOrigin = 'navigation' | 'restore';

export interface ReaderSelection {
  cfi: string;
  text: string;
}

export interface TocItem {
  label: string;
  href: string;
}

interface SpineSection {
  href: string;
  index: number;
  cfiBase: string;
  load: (request: (url: string) => Promise<Document>) => Promise<unknown>;
  unload: () => void;
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
  if (decoded.startsWith('/') || decoded.startsWith('\\') || decoded.startsWith('//')) return false;
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
  if (separator < 0) return null;
  const metadata = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 1);
  try {
    if (metadata.endsWith(';base64')) return atob(body);
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

async function sanitizeStylesheets(document: Document): Promise<void> {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[href]')].filter((link) =>
    (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'),
  );
  await Promise.all(
    links.map(async (link) => {
      const href = link.getAttribute('href') ?? '';
      const next = link.nextSibling;
      const parent = link.parentNode;
      link.remove();
      let stylesheet: string | null = decodeDataStylesheet(href);
      if (!stylesheet && isLocalContentUrl(href, document)) {
        try {
          const response = await fetch(new URL(href, document.baseURI));
          if (response.ok) stylesheet = await response.text();
        } catch {
          stylesheet = null;
        }
      }
      if (!stylesheet) return;
      const style = document.createElement('style');
      style.textContent = sanitizeCss(stylesheet);
      parent?.insertBefore(style, next);
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
    return !decoded.startsWith('/') && !decoded.startsWith('\\') && !decoded.startsWith('//');
  }
  return isLocalContentUrl(decoded, document);
}

export async function sanitizeEpubDocument(document: Document): Promise<void> {
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
  await sanitizeStylesheets(document);
  installEpubContentPolicy(document);
}

export class ReaderSession {
  private readonly book;
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private selectionListeners: Array<() => void> = [];
  private current: Location | null = null;
  private spine: { sections: SpineSection[]; indexes: Map<string, number> } | null = null;
  private locationGeneration = 0;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private onLocation: ((location: ReaderLocation, origin: ReaderLocationOrigin) => void) | null =
    null;

  constructor(private readonly bookUrl: string) {
    this.book = ePub(bookUrl);
  }

  async open(
    target: HTMLElement,
    cfi: string | null,
    serverXPath: string | null,
    serverPercentage: number | null,
    appearance: Appearance,
    onLocation: (location: ReaderLocation, origin: ReaderLocationOrigin) => void,
    onTap: (zone: 'previous' | 'center' | 'next') => void,
    onSelection?: (selection: ReaderSelection) => void,
    onKeyboardNavigation?: (event: KeyboardEvent) => void,
  ): Promise<void> {
    this.rendition = this.book.renderTo(target, {
      width: '100%',
      height: '100%',
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      allowScriptedContent: false,
    });
    this.rendition.hooks.content.register((contents: Contents) => this.harden(contents));
    if (onSelection) {
      this.rendition.hooks.content.register((contents: Contents) => {
        const handler = () => {
          const selection = contents.window.getSelection();
          if (!selection || selection.isCollapsed || !selection.rangeCount) return;
          const text = selection.toString().replace(/\s+/g, ' ').trim();
          if (!text) return;
          try {
            onSelection({ cfi: contents.cfiFromRange(selection.getRangeAt(0)), text });
          } catch {
            // Selection can change while a section is being replaced.
          }
        };
        contents.document.addEventListener('selectionchange', handler);
        this.selectionListeners.push(() =>
          contents.document.removeEventListener('selectionchange', handler),
        );
      });
    }
    this.onLocation = onLocation;
    this.relocated = (location) => {
      const startCfi = this.userNavigationStartCfi ?? this.current?.start.cfi ?? null;
      const isUserNavigation =
        this.userNavigationPending &&
        (startCfi ? startCfi !== location.start.cfi : !this.reflowPending);
      this.current = location;
      const origin = isUserNavigation ? 'navigation' : 'restore';
      if (isUserNavigation) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
      this.reportLocation(location, origin);
      if (this.reflowPending) {
        this.reflowPending = false;
        this.preserveCfi(location.start.cfi, this.locationGeneration);
      }
    };
    this.rendition.on('relocated', this.relocated);
    this.contentClick = (event, contents) => {
      const target = event.target as Element | null;
      const selection = contents.window.getSelection();
      if (
        event.defaultPrevented ||
        target?.closest?.('a, button, input, select, textarea, [contenteditable="true"]') ||
        (selection && !selection.isCollapsed)
      ) {
        return;
      }
      const position = event.clientX / contents.window.innerWidth;
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
      await this.displayAtGeneration(cfi, restoreGeneration);
    } else if (serverXPath) {
      const restored = await this.displayXPath(serverXPath, restoreGeneration);
      if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      const restoredByPercentage =
        !restored && serverPercentage && serverPercentage > 0
          ? await this.displayPercentage(serverPercentage, restoreGeneration)
          : false;
      if (
        this.isCurrentLocationOperation(restoreGeneration) &&
        !restored &&
        !restoredByPercentage
      ) {
        await this.displayAtGeneration(undefined, restoreGeneration);
      }
    } else if (serverPercentage && serverPercentage > 0) {
      const restored = await this.displayPercentage(serverPercentage, restoreGeneration);
      if (this.isCurrentLocationOperation(restoreGeneration) && !restored) {
        await this.displayAtGeneration(undefined, restoreGeneration);
      }
    } else {
      await this.displayAtGeneration(undefined, restoreGeneration);
    }
  }

  private reportLocation(location: Location, origin: ReaderLocationOrigin): void {
    if (!this.onLocation) return;
    const start = location.start;
    const { sections, indexes } = this.getSpine();
    const sectionCount = Math.max(1, sections.length);
    const sectionIndex = indexes.get(start.href) ?? 0;
    const pageIndex = this.pageIndex(start.displayed.page);
    const sectionProgress = pageIndex / Math.max(1, start.displayed.total);
    const semanticPercentage = (sectionIndex + sectionProgress) / sectionCount;
    this.onLocation(
      {
        ...start,
        percentage: semanticPercentage,
        spineIndex: start.index,
        pageIndex,
        pageCount: start.displayed.total,
        xpath: this.cfiToXPath(start.cfi, start.index),
      },
      origin,
    );
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
    return [...this.book.navigation.toc.values()].map((item) => ({
      label: item.label,
      href: item.href,
    }));
  }

  async search(query: string, signal?: AbortSignal, limit = 100): Promise<ReaderSearchResult[]> {
    const normalizedQuery = normalizeReaderSearchQuery(query);
    if (!normalizedQuery) return [];
    const results: ReaderSearchResult[] = [];
    const { sections } = this.getSpine();
    const request = this.book.request as (url: string) => Promise<Document>;

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
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.rendition?.destroy();
    this.selectionListeners.forEach((remove) => remove());
    this.selectionListeners = [];
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.current = null;
    this.userNavigationStartCfi = null;
    this.appearance = null;
    this.reflowPending = false;
    this.spine = null;
    this.book.destroy();
  }

  private harden(contents: Contents): Promise<void> {
    return sanitizeEpubDocument(contents.document);
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
        const siblings = element.parentElement
          ? [...element.parentElement.children].filter((child) => child.localName === tag)
          : [];
        parts.unshift(`${tag}[${Math.max(1, siblings.indexOf(element) + 1)}]`);
        element = element.parentElement;
      }
      return toKavitaXPath(`/${parts.join('/')}`, spineIndex);
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
      const cfi = kavitaXPathToCfi(xpath, section.cfiBase);
      if (!cfi) return false;
      await rendition.display(cfi);
      if (!this.isCurrentLocationOperation(generation)) return false;
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return true;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return true;
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
    this.userNavigationStartCfi = userNavigation
      ? (this.current?.start.cfi ?? this.rendition?.location?.start.cfi ?? null)
      : null;
    return this.locationGeneration;
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
    if (typeof page === 'number') return Math.max(0, page - 1);
    const runtimePage = page as unknown as { index?: number };
    return Math.max(0, runtimePage.index ?? 0);
  }

  private resolveToken(token: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || token;
  }
}
