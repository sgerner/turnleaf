import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  type ReaderSearchResult,
} from './search';

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

interface KavitaXPathTarget {
  spineIndex: number;
  contentXPath: string;
}

export function parseKavitaXPath(xpath: string): KavitaXPathTarget | null {
  const match = xpath.match(/^\/{1,2}body\/DocFragment\[(\d+)]\/body(?<content>\/.*)?$/i);
  if (!match) return null;
  const fragment = Number(match[1]);
  if (!Number.isInteger(fragment) || fragment < 1) return null;
  const content = match.groups?.content?.replace(/\/+$/, '') ?? '';
  return {
    spineIndex: fragment - 1,
    contentXPath: `/html/body${content}`,
  };
}

export function toKavitaXPath(contentXPath: string, spineIndex: number): string | null {
  if (!Number.isInteger(spineIndex) || spineIndex < 0) return null;
  const content = contentXPath
    .replace(/^\/?html(?:\[1])?\/body(?:\[1])?/i, '')
    .replace(/^\/?body(?:\[1])?/i, '');
  return `//body/DocFragment[${spineIndex + 1}]/body${content.startsWith('/') ? content : `/${content}`}`;
}

export function resolveContentXPath(document: Document, xpath: string): Element | null {
  const parts = xpath
    .replace(/^\/html(?:\[1])?\/body(?:\[1])?/i, '')
    .split('/')
    .filter(Boolean);
  let current: Element | null =
    [...document.documentElement.children].find((element) => element.localName === 'body') ?? null;
  if (!current) return null;

  for (const part of parts) {
    const match = part.match(/^([A-Za-z0-9:_-]+)\[(\d+)]$/);
    if (!match) return null;
    const [, rawName, rawIndex] = match;
    if (!rawName || !rawIndex) return null;
    const name = rawName.toLowerCase();
    const index = Number(rawIndex) - 1;
    const matches: Element[] = [...current.children].filter(
      (element) => element.localName.toLowerCase() === name,
    );
    current = matches[index] ?? null;
    if (!current) return null;
  }
  return current;
}

export function kavitaXPathToCfi(xpath: string, cfiBase: string): string | null {
  const target = parseKavitaXPath(xpath);
  if (!target) return null;
  const parts = target.contentXPath
    .replace(/^\/html(?:\[1])?\/body(?:\[1])?/i, '')
    .split('/')
    .filter(Boolean);
  const steps: number[] = [];
  for (const part of parts) {
    const match = part.match(/^[A-Za-z0-9:_-]+\[(\d+)]$/);
    if (!match) return null;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1) return null;
    steps.push(index * 2);
  }
  const elementPath = `/4${steps.map((step) => `/${step}`).join('')}`;
  return `epubcfi(${cfiBase}!${elementPath},/1:0,/1:1)`;
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
  private selectionListeners: Array<() => void> = [];
  private current: Location | null = null;
  private userNavigationPending = false;
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
      this.current = location;
      const origin = this.userNavigationPending ? 'navigation' : 'restore';
      this.userNavigationPending = false;
      this.reportLocation(location, origin);
    };
    this.rendition.on('relocated', this.relocated);
    this.contentClick = (event, contents) => {
      const position = event.clientX / contents.window.innerWidth;
      onTap(position < 0.33 ? 'previous' : position > 0.67 ? 'next' : 'center');
    };
    this.rendition.on('click', this.contentClick);
    this.applyAppearance(appearance);
    await this.rendition.started;
    if (cfi) {
      await this.rendition.display(cfi);
    } else if (serverXPath) {
      const restored = await this.displayXPath(serverXPath);
      const restoredByPercentage =
        !restored && serverPercentage && serverPercentage > 0
          ? await this.displayPercentage(serverPercentage)
          : false;
      if (!restored && !restoredByPercentage) await this.rendition.display();
    } else if (serverPercentage && serverPercentage > 0) {
      const restored = await this.displayPercentage(serverPercentage);
      if (!restored) await this.rendition.display();
    } else {
      await this.rendition.display();
    }
  }

  private reportLocation(location: Location, origin: ReaderLocationOrigin): void {
    if (!this.onLocation) return;
    const start = location.start;
    const sections = this.spineSections();
    const sectionCount = Math.max(1, sections.length);
    const sectionIndex = Math.max(
      0,
      sections.findIndex((section) => section.href === start.href),
    );
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
    const sections = this.spineSections();
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
    this.userNavigationPending = false;
    return this.displayXPath(xpath);
  }

  displayServerPercentage(percentage: number): Promise<boolean> {
    this.userNavigationPending = false;
    return this.displayPercentage(percentage);
  }

  applyAppearance(value: Appearance): void {
    if (!this.rendition) return;
    const colors = MODE_COLORS[value.mode];
    const family =
      value.fontFamily === 'book'
        ? 'Iowan Old Style, Georgia, serif'
        : value.fontFamily === 'accessible'
          ? 'Atkinson Hyperlegible, Verdana, sans-serif'
          : 'Avenir Next, Segoe UI, sans-serif';
    this.rendition.themes.register('turnleaf', {
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
        padding: `0.5rem max(${value.margin}px, env(safe-area-inset-right)) calc(max(${value.margin}px, env(safe-area-inset-bottom)) + 2.5rem) max(${value.margin}px, env(safe-area-inset-left)) !important`,
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
    this.rendition.themes.select('turnleaf');
  }

  destroy(): void {
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    this.rendition?.destroy();
    this.selectionListeners.forEach((remove) => remove());
    this.selectionListeners = [];
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.onLocation = null;
    this.current = null;
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

  private async displayXPath(xpath: string): Promise<boolean> {
    if (!this.rendition) return false;
    const target = parseKavitaXPath(xpath);
    if (!target) return false;
    const section = this.spineSections()[target.spineIndex];
    if (!section) return false;
    try {
      const cfi = kavitaXPathToCfi(xpath, section.cfiBase);
      if (!cfi) return false;
      await this.rendition.display(cfi);
      const contents = (this.rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return true;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return true;
      const range = contents.document.createRange();
      range.selectNodeContents(node);
      await this.rendition.display(contents.cfiFromRange(range));
      return true;
    } catch {
      // A server XPath from a changed EPUB is not safe to guess around.
      return false;
    }
  }

  private async displayPercentage(percentage: number): Promise<boolean> {
    if (!this.rendition) return false;
    try {
      if (!this.book.locations.length()) await this.book.locations.generate(1600);
      await this.rendition.display(Math.max(0, Math.min(0.999, percentage)));
      return true;
    } catch {
      return false;
    }
  }

  private async navigate(display: () => Promise<unknown>): Promise<void> {
    this.userNavigationPending = true;
    try {
      await display();
    } catch (error) {
      this.userNavigationPending = false;
      throw error;
    }
  }

  private spineSections(): SpineSection[] {
    const sections: SpineSection[] = [];
    this.book.spine.each((section: SpineSection) => sections.push(section));
    return sections;
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
