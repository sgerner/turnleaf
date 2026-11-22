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

export interface ReaderExternalLink {
  href: string;
  scheme: 'http:' | 'https:' | 'mailto:';
  label: string;
}

export interface ReaderFootnotePreview {
  title: string;
  paragraphs: string[];
}

export interface ReaderFigurePreview {
  src: string;
  alt: string;
  caption: string;
}

export interface ReaderHighlightAnnotation {
  id?: string;
  cfi: string;
  excerpt?: string;
  note?: string;
}

export interface ReaderInspectorCallbacks {
  onExternalLink?: (link: ReaderExternalLink, opener: HTMLElement | null) => void;
  onFootnote?: (footnote: ReaderFootnotePreview, opener: HTMLElement | null) => void;
  onHighlight?: (cfi: string, opener: HTMLElement | null) => void;
  onFigure?: (figure: ReaderFigurePreview, opener: HTMLElement | null) => void;
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

const EPUB_NS = 'http://www.idpf.org/2007/ops';
const EXTERNAL_HREF_ATTR = 'data-turnleaf-external-href';
const FIGURE_ATTR = 'data-turnleaf-figure';
const FIGURE_LABEL_ATTR = 'data-turnleaf-figure-label';
const MIN_TARGET_PX = 44;

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
const EMAIL_RECIPIENT = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NOTE_REF_TOKENS = new Set(['noteref', 'doc-noteref']);
const FOOTNOTE_TARGET_TOKENS = new Set([
  'footnote',
  'endnote',
  'rearnote',
  'note',
  'doc-footnote',
  'doc-endnote',
]);
const BACKLINK_TOKENS = new Set(['backlink', 'doc-backlink']);
const SVG_GRAPHIC_SELECTOR =
  'path, rect, circle, ellipse, line, polyline, polygon, text, image[href], image[*|href]';
const PROSE_BLOCK_SELECTOR = 'p, blockquote, li, pre, h1, h2, h3, h4, h5, h6, figcaption, dd, dt';

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

export function parseExternalLink(
  value: string,
): { href: string; scheme: 'http:' | 'https:' | 'mailto:' } | null {
  if (!decodedReference(value)) return null;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!url.hostname || url.username || url.password) return null;
      return { href: url.toString(), scheme: url.protocol };
    } catch {
      return null;
    }
  }
  if (/^mailto:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'mailto:') return null;
      const recipients = decodeURIComponent(url.pathname)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!recipients.length || recipients.some((entry) => !EMAIL_RECIPIENT.test(entry))) {
        return null;
      }
      return { href: url.toString(), scheme: 'mailto:' };
    } catch {
      return null;
    }
  }
  return null;
}

export function validateExternalBrowserUrl(value: string): string | null {
  const parsed = parseExternalLink(value);
  if (!parsed || (parsed.scheme !== 'http:' && parsed.scheme !== 'https:')) return null;
  return parsed.href;
}

export function validateExternalLaunchUrl(value: string): string | null {
  return parseExternalLink(value)?.href ?? null;
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

function unlockViewportMeta(document: Document): void {
  document.querySelectorAll('meta[name]').forEach((meta) => {
    if ((meta.getAttribute('name') ?? '').toLowerCase() !== 'viewport') return;
    const raw = meta.getAttribute('content') ?? '';
    const tokens = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^(?:maximum-scale|minimum-scale|user-scalable)\s*=/i.test(part));
    tokens.push('user-scalable=yes');
    meta.setAttribute('content', tokens.join(', '));
  });
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function extractFigureCaption(element: Element): string {
  const figure = element.closest('figure');
  const figcaption = normalizeWhitespace(figure?.querySelector('figcaption')?.textContent);
  if (figcaption) return figcaption;
  const describedBy = normalizeWhitespace(element.getAttribute('aria-describedby'));
  if (describedBy) {
    const parts = describedBy
      .split(/\s+/)
      .map((id) => normalizeWhitespace(element.ownerDocument?.getElementById(id)?.textContent))
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return normalizeWhitespace(element.getAttribute('title'));
}

function extractFigureLabel(element: Element, caption: string): string {
  if (element.localName === 'img') {
    const alt = normalizeWhitespace(element.getAttribute('alt'));
    if (alt && caption && alt !== caption) return `${alt} — ${caption}`;
    if (alt) return alt;
  } else if (element.localName === 'svg') {
    const svgLabel =
      normalizeWhitespace(element.getAttribute('aria-label')) ||
      normalizeWhitespace(element.querySelector('title')?.textContent);
    if (svgLabel && caption && svgLabel !== caption) return `${svgLabel} — ${caption}`;
    if (svgLabel) return svgLabel;
  }
  if (caption) return caption;
  return element.localName === 'svg' ? 'Diagram' : 'Illustration';
}

function hasRenderableSvgContent(svg: Element): boolean {
  try {
    if (svg.querySelector(SVG_GRAPHIC_SELECTOR)) return true;
  } catch {
    if (svg.querySelector('path, rect, circle, ellipse, line, polyline, polygon, text')) {
      return true;
    }
  }
  return Array.from(svg.querySelectorAll('image')).some((img) =>
    Boolean(img.getAttribute('href') || img.getAttribute('xlink:href')),
  );
}

function prepareEpubFigures(document: Document): void {
  const root = document.body ?? document.documentElement;
  if (!root) return;
  root.querySelectorAll('img, svg').forEach((element) => {
    if (element.closest('a, button, svg svg, [hidden], [aria-hidden="true"]')) return;
    const role = (element.getAttribute('role') ?? '').toLowerCase();
    if (role === 'presentation' || role === 'none') return;
    if (element.localName === 'img') {
      const hasSource = Boolean(element.getAttribute('src') || element.getAttribute('srcset'));
      if (!hasSource) return;
      const altAttr = element.getAttribute('alt');
      if (altAttr === '' && !extractFigureCaption(element)) return;
    } else if (!hasRenderableSvgContent(element)) {
      return;
    }
    const caption = extractFigureCaption(element);
    const label = extractFigureLabel(element, caption);
    element.setAttribute(FIGURE_ATTR, 'true');
    element.setAttribute(FIGURE_LABEL_ATTR, label);
    element.setAttribute('role', 'button');
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '0');
    element.setAttribute('aria-haspopup', 'dialog');
    element.setAttribute('aria-label', `Inspect figure: ${label}`);
  });
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
  unlockViewportMeta(document);

  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'ping' || name.startsWith('data-turnleaf-')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'target' && ['a', 'area'].includes(element.localName)) {
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
      if (!isSafeEpubReference(attribute.value, kind)) {
        const rawValue = attribute.value;
        element.removeAttribute(attribute.name);
        if (kind === 'link' && element.localName === 'a') {
          const external = parseExternalLink(rawValue);
          if (external) {
            element.setAttribute(EXTERNAL_HREF_ATTR, external.href);
            element.setAttribute('role', 'link');
            element.setAttribute('tabindex', '0');
          }
        }
      }
    }
    if (
      (element.localName === 'a' || element.localName === 'area') &&
      !element.hasAttribute('href')
    ) {
      element.onclick = null;
      if (!element.hasAttribute(EXTERNAL_HREF_ATTR)) {
        if ((element.getAttribute('role') ?? '').toLowerCase() === 'link') {
          element.removeAttribute('role');
        }
        element.removeAttribute('tabindex');
      }
    }
  });

  prepareEpubFigures(document);

  document.querySelectorAll('style').forEach((style) => {
    const safeStyle = sanitizeCss(style.textContent ?? '');
    style.textContent = safeStyle;
  });
  await sanitizeStylesheets(document, stylesheetCache);
  installEpubContentPolicy(document);
}

function getSemanticTokens(element: Element | null): string[] {
  if (!element) return [];
  const raw = [
    element.getAttribute('epub:type') ?? '',
    element.getAttributeNS?.(EPUB_NS, 'type') ?? '',
    element.getAttribute('role') ?? '',
  ].join(' ');
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

function isNoteRefElement(link: Element): boolean {
  return getSemanticTokens(link).some((token) => NOTE_REF_TOKENS.has(token));
}

function isFootnoteTargetElement(target: Element): boolean {
  let current: Element | null = target;
  while (current && current.localName !== 'body' && current.localName !== 'html') {
    if (getSemanticTokens(current).some((token) => FOOTNOTE_TARGET_TOKENS.has(token))) {
      return true;
    }
    if (!['aside', 'li', 'div', 'dd', 'p'].includes(current.localName)) break;
    current = current.parentElement;
  }
  return false;
}

function isElementHidden(element: Element, view?: Window | null): boolean {
  let current: Element | null = element;
  while (current && current.localName !== 'html') {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    }
    current = current.parentElement;
  }
  return false;
}

function findFragmentTarget(document: Document, fragmentId: string): Element | null {
  const byId = document.getElementById(fragmentId);
  if (byId) return byId;
  for (const candidate of document.querySelectorAll('[id], a[name]')) {
    if (
      candidate.getAttribute('id') === fragmentId ||
      candidate.getAttribute('name') === fragmentId
    ) {
      return candidate;
    }
  }
  return null;
}

function extractFootnotePreview(link: Element, target: Element): ReaderFootnotePreview {
  const rawLabel = normalizeWhitespace(link.textContent).replace(/^\[|\]$/g, '');
  const title = rawLabel && rawLabel.length <= 24 ? `Footnote ${rawLabel}` : 'Footnote';

  const clone = target.cloneNode(true) as Element;
  clone.removeAttribute('hidden');
  clone.removeAttribute('aria-hidden');
  clone
    .querySelectorAll('[hidden], [aria-hidden="true"], script, style')
    .forEach((n) => n.remove());
  clone.querySelectorAll('a').forEach((anchor) => {
    const isBacklink = getSemanticTokens(anchor).some((token) => BACKLINK_TOKENS.has(token));
    const text = normalizeWhitespace(anchor.textContent);
    if (isBacklink && (!/[a-z0-9]/i.test(text) || /^(?:back|return)$/i.test(text))) {
      anchor.remove();
    }
  });

  const blocks = Array.from(clone.querySelectorAll('p, li, blockquote, dd, pre')).filter(
    (block) => !block.querySelector('p, li, blockquote, dd, pre'),
  );
  const paragraphs = (
    blocks.length > 0
      ? blocks.map((block) => normalizeWhitespace(block.textContent))
      : [normalizeWhitespace(clone.textContent)]
  ).filter(Boolean);

  return { title, paragraphs };
}

function formatHighlightAriaLabel(annotation: ReaderHighlightAnnotation): string {
  const excerpt = normalizeWhitespace(annotation.excerpt).slice(0, 160);
  const note = normalizeWhitespace(annotation.note).slice(0, 120);
  if (excerpt && note) return `Highlight: “${excerpt}”, with note: ${note}`;
  if (excerpt) return `Highlight: “${excerpt}”, no note`;
  if (note) return `Highlight, with note: ${note}`;
  return 'Saved highlight, no note';
}

function resolveSafeImageCandidate(candidate: string, doc: Document): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (
    trimmed.toLowerCase().startsWith('blob:') ||
    SAFE_DATA_IMAGE.test(trimmed) ||
    isLocalContentUrl(trimmed, doc) ||
    isSafeEpubReference(trimmed, 'resource')
  ) {
    try {
      return new URL(trimmed, doc.baseURI).href;
    } catch {
      return trimmed;
    }
  }
  return null;
}

function serializeSvgPreview(svg: Element, doc: Document): string | null {
  try {
    const clone = svg.cloneNode(true) as Element;
    clone.removeAttribute(FIGURE_ATTR);
    clone.removeAttribute(FIGURE_LABEL_ATTR);
    clone.removeAttribute('tabindex');
    clone.removeAttribute('role');
    clone.removeAttribute('aria-haspopup');
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!clone.getAttribute('color')) {
      const computedColor = doc.defaultView?.getComputedStyle?.(svg)?.color?.trim();
      if (computedColor) clone.setAttribute('color', computedColor);
    }
    if (!clone.getAttribute('viewBox')) {
      const rect = svg.getBoundingClientRect?.();
      const width = Number(clone.getAttribute('width')) || Math.round(rect?.width ?? 0);
      const height = Number(clone.getAttribute('height')) || Math.round(rect?.height ?? 0);
      if (width > 0 && height > 0) {
        clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
      }
    }
    const serializer = doc.defaultView?.XMLSerializer ?? XMLSerializer;
    const markup = new serializer().serializeToString(clone);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  } catch {
    return null;
  }
}

function resolveFigurePreview(element: Element, doc: Document): ReaderFigurePreview | null {
  const caption = extractFigureCaption(element);
  const label =
    normalizeWhitespace(element.getAttribute(FIGURE_LABEL_ATTR)) ||
    extractFigureLabel(element, caption);
  if (element.localName === 'svg') {
    const alt =
      normalizeWhitespace(element.querySelector('title')?.textContent) || label || 'Diagram';
    const hasVectors = Boolean(
      element.querySelector('path, rect, circle, ellipse, line, polyline, polygon, text'),
    );
    const images = Array.from(element.querySelectorAll('image'));
    if (!hasVectors && images.length === 1) {
      const imageHref =
        images[0]?.getAttribute('href') || images[0]?.getAttribute('xlink:href') || '';
      const directSrc = resolveSafeImageCandidate(imageHref, doc);
      if (directSrc) return { src: directSrc, alt, caption };
    }
    const src = serializeSvgPreview(element, doc);
    if (!src) return null;
    return { src, alt, caption };
  }
  if (element.localName === 'img') {
    const img = element as HTMLImageElement;
    const rawAttrSrc = img.getAttribute('src') ?? '';
    const firstSrcset =
      (img.getAttribute('srcset') ?? '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0] ?? '')
        .find(Boolean) ?? '';
    const candidate = img.currentSrc || rawAttrSrc || firstSrcset;
    const resolvedSrc = resolveSafeImageCandidate(candidate, doc);
    if (!resolvedSrc) return null;
    const alt = normalizeWhitespace(img.getAttribute('alt')) || label || 'Illustration';
    return { src: resolvedSrc, alt, caption };
  }
  return null;
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private readonly handledEvents = new WeakSet<Event>();
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private rendered: (() => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private keyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  private current: Location | null = null;
  private spine: { sections: SpineSection[]; indexes: Map<string, number> } | null = null;
  private locationGeneration = 0;
  private userNavigationPending = false;
  private userNavigationStartCfi: string | null = null;
  private userNavigationStartSectionIndex: number | null = null;
  private userNavigationOrigin: ReaderLocationOrigin = 'navigation';
  private pendingLinkReturnTarget: ReaderLinkReturnTarget | null = null;
  private reflowPending = false;
  private appearance: Appearance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewportSize: { width: number; height: number } | null = null;
  private pendingViewportSize: { width: number; height: number } | null = null;
  private displayQueue: Promise<void> = Promise.resolve();
  private displayInFlightCount = 0;
  private lastDisplayTarget: string | undefined = undefined;
  private viewportTarget: HTMLElement | null = null;
  private highlightLayer: HTMLDivElement | null = null;
  private highlightButtons = new Map<string, HTMLButtonElement>();
  private highlightAnnotations = new Map<string, ReaderHighlightAnnotation>();
  private highlightCfis = new Set<string>();
  private inspectors: ReaderInspectorCallbacks = {};
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
    inspectors: ReaderInspectorCallbacks = {},
  ): Promise<void> {
    this.inspectors = inspectors;
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
    this.ensureHighlightLayer(target);
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
    this.rendered = () => {
      this.syncHighlightOverlays();
    };
    this.rendition.on('rendered', this.rendered);
    this.relocated = (location) => {
      const startCfi = this.userNavigationStartCfi ?? this.current?.start.cfi ?? null;
      const matchesPendingInitialSection =
        startCfi === null &&
        this.userNavigationStartSectionIndex !== null &&
        location.start.index === this.userNavigationStartSectionIndex &&
        location.start.displayed.page <= 1;
      const isUserNavigation =
        this.userNavigationPending &&
        (startCfi
          ? startCfi !== location.start.cfi
          : !this.reflowPending && !matchesPendingInitialSection);
      const origin = isUserNavigation ? this.userNavigationOrigin : 'restore';
      const returnTarget = origin === 'link' ? this.pendingLinkReturnTarget : null;
      if (startCfi !== location.start.cfi) onSelection?.(null);
      this.current = location;
      this.lastDisplayTarget = location.start.cfi;
      if (isUserNavigation || this.userNavigationOrigin === 'link') {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
        this.userNavigationStartSectionIndex = null;
        this.userNavigationOrigin = 'navigation';
        this.pendingLinkReturnTarget = null;
      }
      this.reportLocation(location, origin, returnTarget);
      this.syncHighlightOverlays();
      if (this.reflowPending) {
        this.reflowPending = false;
        this.preserveCfi(location.start.cfi, this.locationGeneration);
      }
    };
    this.rendition.on('relocated', this.relocated);
    this.contentClick = (event, contents) => {
      if (event && typeof event === 'object' && this.handledEvents.has(event)) return;
      const eventTarget = event.target as Element | null;
      const selection = contents.window?.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      if (this.routeContentInteraction(event, eventTarget, contents)) return;
      if (
        event.defaultPrevented ||
        eventTarget?.closest?.('button, input, select, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      const frame = contents.window?.frameElement;
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
    await this.runDisplayOperation(async () => {
      await this.rendition!.started;
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
    });
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

  updateHighlights(annotations: ReaderHighlightAnnotation[]): void {
    const rendition = this.rendition;
    if (!rendition) return;

    this.highlightAnnotations.clear();
    for (const annotation of annotations) {
      this.highlightAnnotations.set(annotation.cfi, annotation);
    }

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
        const callback = this.inspectors.onHighlight
          ? () => this.activateHighlight(cfi, this.highlightButtons.get(cfi) ?? null)
          : undefined;
        rendition.annotations.highlight(cfi, {}, callback, 'turnleaf-highlight', {
          fill: '#facc15',
          'fill-opacity': '0.38',
        });
        applied.add(cfi);
      } catch {
        // A saved CFI can stop matching after an EPUB is replaced or changed.
      }
    }
    this.highlightCfis = applied;
    this.syncHighlightOverlays();
  }

  getVisiblePassages(limit = 24): ReaderSelection[] {
    const viewport = this.viewportTarget;
    if (!this.rendition) return [];
    const viewportRect = viewport?.getBoundingClientRect();
    const hasLayout = Boolean(viewportRect && viewportRect.width > 0 && viewportRect.height > 0);
    const passages: ReaderSelection[] = [];

    for (const contents of this.getActiveContents()) {
      const doc = contents.document;
      const root = doc?.body;
      if (!doc || !root || typeof contents.cfiFromRange !== 'function') continue;

      const blocks = Array.from(root.querySelectorAll(PROSE_BLOCK_SELECTOR)).filter(
        (element) =>
          !element.querySelector(PROSE_BLOCK_SELECTOR) &&
          !isElementHidden(element, contents.window),
      );
      for (const block of blocks) {
        const text = normalizeWhitespace(block.textContent);
        if (!text) continue;
        try {
          const walker = doc.createTreeWalker(block, 4);
          let firstText: Text | null = null;
          let lastText: Text | null = null;
          let current = walker.nextNode() as Text | null;
          while (current) {
            if (current.data && current.data.trim().length > 0) {
              if (!firstText) firstText = current;
              lastText = current;
            }
            current = walker.nextNode() as Text | null;
          }
          if (!firstText || !lastText) continue;
          const range = doc.createRange();
          range.setStart(firstText, 0);
          range.setEnd(lastText, lastText.data.length);
          if (hasLayout && viewportRect) {
            const box = this.computeVisibleRangeBox(range, contents, viewportRect);
            if (!box) continue;
          }
          const cfi = contents.cfiFromRange(range);
          if (!cfi) continue;
          passages.push({ cfi, text: text.slice(0, 500) });
          if (passages.length >= limit) return passages;
        } catch {
          // Ignore nodes whose CFI cannot be resolved while reflowing.
        }
      }
    }
    return passages;
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
    const generation = this.beginLocationOperation(false);
    return this.runDisplayOperation(() => this.displayXPath(xpath, generation));
  }

  displayServerPercentage(percentage: number): Promise<boolean> {
    const generation = this.beginLocationOperation(false);
    return this.runDisplayOperation(() => this.displayPercentage(percentage, generation));
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
    const linkColor = this.resolveToken(colors.link);
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
      'img, svg, video, canvas, table, pre, blockquote, figure': {
        'max-width': '100% !important',
      },
      figure: {
        'margin-inline': '0',
      },
      img: {
        height: 'auto !important',
      },
      [`[${FIGURE_ATTR}="true"]`]: {
        cursor: 'zoom-in',
      },
      [`a[href], a[${EXTERNAL_HREF_ATTR}]`]: {
        color: `${linkColor} !important`,
        'text-decoration': 'underline !important',
        cursor: 'pointer',
      },
      [`a:not([href]):not([${EXTERNAL_HREF_ATTR}])`]: {
        color: 'inherit !important',
        'text-decoration': 'none !important',
        cursor: 'inherit',
      },
      ':focus-visible': {
        outline: `3px solid ${linkColor} !important`,
        'outline-offset': '2px !important',
      },
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
    if (this.rendition && this.rendered) this.rendition.off('rendered', this.rendered);
    if (this.rendition && this.relocated) this.rendition.off('relocated', this.relocated);
    if (this.rendition && this.contentClick) this.rendition.off('click', this.contentClick);
    if (this.rendition && this.keyboardNavigation)
      this.rendition.off('keydown', this.keyboardNavigation);
    this.rendition?.destroy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportSize = null;
    this.pendingViewportSize = null;
    this.displayQueue = Promise.resolve();
    this.displayInFlightCount = 0;
    this.lastDisplayTarget = undefined;
    this.viewportTarget = null;
    this.highlightButtons.clear();
    this.highlightAnnotations.clear();
    this.highlightLayer?.remove();
    this.highlightLayer = null;
    this.rendition = null;
    this.rendered = null;
    this.relocated = null;
    this.contentClick = null;
    this.keyboardNavigation = null;
    this.onLocation = null;
    this.inspectors = {};
    this.current = null;
    this.userNavigationStartCfi = null;
    this.userNavigationStartSectionIndex = null;
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

  private async harden(contents: Contents): Promise<void> {
    await sanitizeEpubDocument(contents.document, this.stylesheetCache);
    this.unlockContentsViewport(contents);
    this.installContentInteractionHandlers(contents);
  }

  private unlockContentsViewport(contents: Contents): void {
    if (typeof contents.viewport === 'function') {
      const originalViewport = contents.viewport.bind(contents) as (
        options?: Partial<Parameters<Contents['viewport']>[0]>,
      ) => ReturnType<Contents['viewport']>;
      contents.viewport = ((options?: Parameters<Contents['viewport']>[0]) => {
        if (!options) return originalViewport();
        const patched: Partial<Parameters<Contents['viewport']>[0]> = {
          ...options,
          scalable: 'yes',
        };
        delete patched.maximum;
        const result = originalViewport(patched);
        unlockViewportMeta(contents.document);
        return result;
      }) as Contents['viewport'];
    }
    if (contents.document) unlockViewportMeta(contents.document);
  }

  private installContentInteractionHandlers(contents: Contents): void {
    const doc = contents.document;
    if (!doc) return;
    doc.addEventListener(
      'click',
      (event) => {
        const selection = contents.window?.getSelection?.();
        if (selection && !selection.isCollapsed) return;
        const target = event.target as Element | null;
        if (this.routeContentInteraction(event, target, contents, true)) {
          this.handledEvents.add(event);
        }
      },
      true,
    );
    doc.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as Element | null;
      if (!target) return;
      const externalLink = target.closest?.(`a[${EXTERNAL_HREF_ATTR}]`);
      if (externalLink && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.handledEvents.add(event);
        this.openExternalLinkElement(externalLink);
        return;
      }
      const internalLink = target.closest?.('a[href]');
      if (internalLink && event.key === 'Enter') {
        if (this.tryHandleFootnoteLink(event, internalLink, contents)) {
          this.handledEvents.add(event);
        }
        return;
      }
      const figure = target.closest?.(`[${FIGURE_ATTR}="true"]`);
      if (figure && (event.key === 'Enter' || event.key === ' ')) {
        const preview = resolveFigurePreview(figure, doc);
        if (preview) {
          event.preventDefault();
          event.stopPropagation();
          this.handledEvents.add(event);
          this.inspectors.onFigure?.(preview, figure as HTMLElement);
        }
      }
    });
  }

  private routeContentInteraction(
    event: MouseEvent,
    eventTarget: Element | null,
    contents: Contents,
    fromCapture = false,
  ): boolean {
    const link = eventTarget?.closest?.('a') as HTMLAnchorElement | null;
    if (link) {
      const sanitizedExternal = link.getAttribute(EXTERNAL_HREF_ATTR);
      if (sanitizedExternal) {
        event.preventDefault?.();
        event.stopPropagation?.();
        this.openExternalLinkElement(link);
        return true;
      }
      const href = link.getAttribute('href') ?? '';
      if (!href) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (!isSafeEpubReference(href, 'link')) {
        const rawExternal = parseExternalLink(href);
        if (rawExternal && this.inspectors.onExternalLink) {
          event.preventDefault?.();
          event.stopPropagation?.();
          this.inspectors.onExternalLink(
            {
              href: rawExternal.href,
              scheme: rawExternal.scheme,
              label: normalizeWhitespace(link.textContent),
            },
            link,
          );
        }
        return true;
      }
      if (this.tryHandleFootnoteLink(event, link, contents)) {
        return true;
      }
      if (!fromCapture) this.beginLinkedNavigation();
      return !fromCapture;
    }

    const figure =
      eventTarget?.closest?.(`[${FIGURE_ATTR}="true"]`) ?? eventTarget?.closest?.('img, svg');
    if (figure && contents.document && !figure.closest('button')) {
      const preview = resolveFigurePreview(figure, contents.document);
      if (preview && this.inspectors.onFigure) {
        event.preventDefault?.();
        event.stopPropagation?.();
        this.inspectors.onFigure(preview, figure as HTMLElement);
        return true;
      }
    }

    const hitHighlightCfi = this.findClickedHighlightCfi(event, contents);
    if (hitHighlightCfi) {
      event.preventDefault?.();
      event.stopPropagation?.();
      this.activateHighlight(hitHighlightCfi, this.highlightButtons.get(hitHighlightCfi) ?? null);
      return true;
    }

    return false;
  }

  private openExternalLinkElement(link: Element): void {
    const raw = link.getAttribute(EXTERNAL_HREF_ATTR) ?? '';
    const parsed = parseExternalLink(raw);
    if (!parsed) return;
    this.inspectors.onExternalLink?.(
      {
        href: parsed.href,
        scheme: parsed.scheme,
        label: normalizeWhitespace(link.textContent),
      },
      link as HTMLElement,
    );
  }

  private tryHandleFootnoteLink(event: Event, link: Element, contents: Contents): boolean {
    const href = link.getAttribute('href') ?? '';
    const hashIndex = href.indexOf('#');
    if (hashIndex < 0) return false;
    const rawPath = href.slice(0, hashIndex).trim();
    const rawFragment = href.slice(hashIndex + 1).trim();
    if (!rawFragment) return false;
    let fragmentId: string;
    try {
      fragmentId = decodeURIComponent(rawFragment);
    } catch {
      return false;
    }
    if (!fragmentId) return false;

    const currentSectionHref =
      this.current?.start.href ?? this.getSpine().sections[contents.sectionIndex]?.href ?? '';
    const isSameDocument =
      !rawPath || this.isSameSpinePath(rawPath, currentSectionHref, contents.document);

    if (isSameDocument && contents.document) {
      const target = findFragmentTarget(contents.document, fragmentId);
      if (!target) return false;
      const hidden = isElementHidden(target, contents.window);
      const semantic = isNoteRefElement(link) || isFootnoteTargetElement(target);
      if (!hidden && !semantic) return false;
      const preview = extractFootnotePreview(link, target);
      if (!preview.paragraphs.length) return false;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.inspectors.onFootnote?.(preview, link as HTMLElement);
      return true;
    }

    if (!isSameDocument && isNoteRefElement(link) && this.inspectors.onFootnote) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void this.openCrossSectionFootnote(rawPath, currentSectionHref, fragmentId, link);
      return true;
    }

    return false;
  }

  private async openCrossSectionFootnote(
    rawPath: string,
    currentSectionHref: string,
    fragmentId: string,
    link: Element,
  ): Promise<void> {
    const targetSection = this.resolveTargetSpineSection(rawPath, currentSectionHref);
    if (!targetSection) {
      this.beginLinkedNavigation();
      await this.rendition?.display(`${rawPath}#${encodeURIComponent(fragmentId)}`);
      return;
    }
    const request = (this.book as unknown as { load?: (url: string) => Promise<Document> }).load;
    if (typeof request !== 'function') return;
    const sectionState = targetSection as SpineSection & {
      document?: Document;
      contents?: unknown;
    };
    const wasLoaded = Boolean(sectionState.contents || sectionState.document);
    try {
      const loaded = await targetSection.load(request.bind(this.book));
      const doc =
        sectionState.document ??
        (loaded && typeof loaded === 'object' && 'querySelector' in loaded
          ? (loaded as Document)
          : null);
      const target = doc ? findFragmentTarget(doc, fragmentId) : null;
      if (target) {
        const preview = extractFootnotePreview(link, target);
        if (preview.paragraphs.length) {
          this.inspectors.onFootnote?.(preview, link as HTMLElement);
          return;
        }
      }
      this.beginLinkedNavigation();
      await this.rendition?.display(`${targetSection.href}#${encodeURIComponent(fragmentId)}`);
    } finally {
      if (!wasLoaded) targetSection.unload();
    }
  }

  private isSameSpinePath(rawPath: string, currentHref: string, doc?: Document): boolean {
    const cleanCurrent = currentHref.split('#')[0] ?? '';
    if (!cleanCurrent) return false;
    if (rawPath === cleanCurrent) return true;
    try {
      const base = doc?.baseURI || `https://epub.local/${cleanCurrent}`;
      const resolved = new URL(rawPath, base).pathname.replace(/^\/+/, '');
      const currentResolved = new URL(cleanCurrent, base).pathname.replace(/^\/+/, '');
      return resolved === currentResolved || resolved.endsWith(`/${cleanCurrent}`);
    } catch {
      return false;
    }
  }

  private resolveTargetSpineSection(rawPath: string, currentHref: string): SpineSection | null {
    const { sections } = this.getSpine();
    const cleanRaw = rawPath.split('#')[0] ?? '';
    const direct = sections.find((section) => section.href === cleanRaw);
    if (direct) return direct;
    try {
      const resolved = new URL(cleanRaw, `https://epub.local/${currentHref}`).pathname.replace(
        /^\/+/,
        '',
      );
      return (
        sections.find(
          (section) => section.href === resolved || resolved.endsWith(`/${section.href}`),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private ensureHighlightLayer(target: HTMLElement): void {
    if (this.highlightLayer?.parentElement === target) return;
    this.highlightLayer?.remove();
    const layer = target.ownerDocument.createElement('div');
    layer.className = 'turnleaf-highlight-layer';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '2';
    layer.style.overflow = 'hidden';
    target.append(layer);
    this.highlightLayer = layer;
  }

  private activateHighlight(cfi: string, opener: HTMLElement | null): void {
    this.inspectors.onHighlight?.(cfi, opener);
  }

  private findClickedHighlightCfi(event: MouseEvent, contents: Contents): string | null {
    if (!this.highlightCfis.size || !contents.document) return null;
    for (const cfi of this.highlightCfis) {
      const range = this.resolveCfiRange(cfi, contents);
      if (!range) continue;
      const rects =
        typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
      const matched = rects.some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      );
      if (matched) return cfi;
    }
    return null;
  }

  private getActiveContents(): Contents[] {
    const rendition = this.rendition as
      (Rendition & { getContents?: () => Contents[] | Contents }) | null;
    if (!rendition || typeof rendition.getContents !== 'function') return [];
    const raw = rendition.getContents();
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
  }

  private resolveCfiRange(cfi: string, contents?: Contents): Range | null {
    try {
      if (contents && typeof contents.range === 'function') {
        const range = contents.range(cfi);
        if (range) return range;
      }
      const rendition = this.rendition as
        (Rendition & { getRange?: (value: string) => Range }) | null;
      if (rendition && typeof rendition.getRange === 'function') {
        const range = rendition.getRange(cfi);
        if (
          range &&
          (!contents?.document || range.startContainer.ownerDocument === contents.document)
        ) {
          return range;
        }
      }
    } catch {
      // Ignore invalid or unloaded spine CFIs.
    }
    return null;
  }

  private computeVisibleRangeBox(
    range: Range,
    contents: Contents,
    viewportRect: DOMRect,
  ): { left: number; top: number; width: number; height: number } | null {
    const rawRects = (
      typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
    ).filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rawRects.length) {
      const fallback = range.getBoundingClientRect?.();
      if (fallback && fallback.width > 0 && fallback.height > 0) rawRects.push(fallback);
    }
    if (!rawRects.length) return null;

    const frame = contents.window?.frameElement as Element | null | undefined;
    const frameRect = frame?.getBoundingClientRect() ?? viewportRect;
    for (const rect of rawRects) {
      const left = frameRect.left + rect.left - viewportRect.left;
      const top = frameRect.top + rect.top - viewportRect.top;
      const right = left + rect.width;
      const bottom = top + rect.height;
      if (
        right > 1 &&
        left < viewportRect.width - 1 &&
        bottom > 1 &&
        top < viewportRect.height - 1
      ) {
        const clampedLeft = Math.max(0, left);
        const clampedTop = Math.max(0, top);
        const clampedRight = Math.min(viewportRect.width, right);
        const clampedBottom = Math.min(viewportRect.height, bottom);
        return {
          left: clampedLeft,
          top: clampedTop,
          width: Math.max(1, clampedRight - clampedLeft),
          height: Math.max(1, clampedBottom - clampedTop),
        };
      }
    }
    return null;
  }

  private syncHighlightOverlays(): void {
    const layer = this.highlightLayer;
    const viewport = this.viewportTarget;
    if (!layer || !viewport || !this.rendition) return;

    const viewportRect = viewport.getBoundingClientRect();
    const hasLayout = viewportRect.width > 0 && viewportRect.height > 0;
    const activeContents = this.getActiveContents();
    const visibleBoxes = new Map<
      string,
      { left: number; top: number; width: number; height: number }
    >();

    for (const cfi of this.highlightCfis) {
      if (activeContents.length > 0) {
        for (const contents of activeContents) {
          const range = this.resolveCfiRange(cfi, contents);
          if (!range) continue;
          if (hasLayout) {
            const box = this.computeVisibleRangeBox(range, contents, viewportRect);
            if (box) {
              visibleBoxes.set(cfi, box);
              break;
            }
          } else {
            visibleBoxes.set(cfi, {
              left: 0,
              top: 0,
              width: MIN_TARGET_PX,
              height: MIN_TARGET_PX,
            });
            break;
          }
        }
      } else if (!hasLayout) {
        const range = this.resolveCfiRange(cfi);
        if (range) {
          visibleBoxes.set(cfi, {
            left: 0,
            top: 0,
            width: MIN_TARGET_PX,
            height: MIN_TARGET_PX,
          });
        }
      }
    }

    for (const [cfi, button] of this.highlightButtons) {
      if (!visibleBoxes.has(cfi)) {
        button.remove();
        this.highlightButtons.delete(cfi);
      }
    }

    for (const [cfi, box] of visibleBoxes) {
      const annotation = this.highlightAnnotations.get(cfi) ?? { cfi };
      let button = this.highlightButtons.get(cfi);
      if (!button) {
        button = layer.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'turnleaf-highlight-target';
        button.style.position = 'absolute';
        button.style.pointerEvents = 'auto';
        button.style.background = 'transparent';
        button.style.border = '0';
        button.style.padding = '0';
        button.style.margin = '0';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.setAttribute('aria-controls', 'reader-annotations');
        button.setAttribute('aria-haspopup', 'dialog');
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.activateHighlight(cfi, button!);
        });
        this.highlightButtons.set(cfi, button);
        layer.append(button);
      }

      const targetWidth = Math.max(MIN_TARGET_PX, Math.round(box.width));
      const targetHeight = Math.max(MIN_TARGET_PX, Math.round(box.height));
      const maxLeft = hasLayout ? Math.max(0, Math.floor(viewportRect.width - targetWidth)) : 0;
      const maxTop = hasLayout ? Math.max(0, Math.floor(viewportRect.height - targetHeight)) : 0;
      const centeredLeft = Math.round(box.left - (targetWidth - box.width) / 2);
      const centeredTop = Math.round(box.top - (targetHeight - box.height) / 2);
      const left = Math.min(maxLeft, Math.max(0, centeredLeft));
      const top = Math.min(maxTop, Math.max(0, centeredTop));

      button.dataset.highlightCfi = cfi;
      if (annotation.id) button.dataset.annotationId = annotation.id;
      else delete button.dataset.annotationId;
      button.setAttribute('aria-label', formatHighlightAriaLabel(annotation));
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      button.style.width = `${targetWidth}px`;
      button.style.height = `${targetHeight}px`;
      button.style.minWidth = `${MIN_TARGET_PX}px`;
      button.style.minHeight = `${MIN_TARGET_PX}px`;
    }
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
      if (this.viewportSize?.width === width && this.viewportSize.height === height) {
        this.pendingViewportSize = null;
        return;
      }
      if (this.displayInFlightCount > 0) {
        this.pendingViewportSize = { width, height };
        return;
      }
      void this.runDisplayOperation(() => this.applyViewportResize(width, height));
    });
    this.resizeObserver.observe(target);
  }

  private runDisplayOperation<T>(work: () => Promise<T>): Promise<T> {
    const startImmediately = this.displayInFlightCount === 0;
    this.displayInFlightCount += 1;
    const execute = async (): Promise<T> => {
      try {
        return await work();
      } finally {
        await this.flushPendingViewportResize();
      }
    };
    const run = startImmediately ? execute() : this.displayQueue.then(execute);
    this.displayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.displayInFlightCount = Math.max(0, this.displayInFlightCount - 1);
    });
  }

  private async flushPendingViewportResize(): Promise<void> {
    while (this.pendingViewportSize && this.rendition) {
      const { width, height } = this.pendingViewportSize;
      this.pendingViewportSize = null;
      await this.applyViewportResize(width, height);
    }
  }

  private async applyViewportResize(width: number, height: number): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) return;
    if (this.viewportSize?.width === width && this.viewportSize.height === height) return;
    this.viewportSize = { width, height };
    rendition.resize(width, height);
    const hasManager = Boolean((rendition as unknown as { manager?: unknown }).manager);
    if (hasManager) {
      if (!rendition.location?.start) {
        const target = this.current?.start.cfi ?? this.lastDisplayTarget;
        try {
          if (target === undefined) await rendition.display();
          else await rendition.display(target);
        } catch {
          // Ignore transient resize re-display failure while closing or switching sections.
        }
      }
      await this.settleManagerRelocation(rendition);
    }
    this.syncHighlightOverlays();
  }

  private async settleManagerRelocation(rendition: Rendition): Promise<void> {
    if (!this.rendition || this.rendition !== rendition) return;
    const internal = rendition as unknown as {
      manager?: unknown;
      q?: { enqueue?: <T>(task: () => T) => Promise<T> };
    };
    if (!internal.manager) return;
    if (typeof internal.q?.enqueue === 'function') {
      try {
        await internal.q.enqueue(() => undefined);
      } catch {
        return;
      }
    }
    if (!this.rendition || this.rendition !== rendition) return;
    if (typeof requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 50);
        requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        });
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
    if (target === undefined) await rendition.display();
    else await rendition.display(target);
    this.lastDisplayTarget = target;
    await this.settleManagerRelocation(rendition);
    if (!this.isCurrentLocationOperation(generation)) return false;
    return true;
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
      this.lastDisplayTarget = section.href;
      if (!this.isCurrentLocationOperation(generation)) return false;
      if (target.contentXPath === '/html/body') {
        await this.settleManagerRelocation(rendition);
        return this.isCurrentLocationOperation(generation);
      }
      const contents = (rendition.getContents() as unknown as Contents[]).find(
        (item) => item.sectionIndex === target.spineIndex,
      );
      if (!contents) return false;
      const node = resolveContentXPath(contents.document, target.contentXPath);
      if (!node) return false;
      const cfi = this.cfiFromXPathNode(contents, node);
      if (!(contents.range(cfi) as Range | null)) return false;
      await rendition.display(cfi);
      this.lastDisplayTarget = cfi;
      await this.settleManagerRelocation(rendition);
      if (!this.isCurrentLocationOperation(generation)) return false;
      return true;
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
    await this.runDisplayOperation(async () => {
      const generation = this.beginLocationOperation(true);
      try {
        await display();
        if (this.rendition) {
          await this.settleManagerRelocation(this.rendition);
        }
      } catch (error) {
        if (this.isCurrentLocationOperation(generation)) {
          this.userNavigationPending = false;
          this.userNavigationStartCfi = null;
          this.userNavigationStartSectionIndex = null;
        }
        throw error;
      }
    });
  }

  private beginLocationOperation(userNavigation: boolean): number {
    this.locationGeneration += 1;
    this.userNavigationPending = userNavigation;
    this.userNavigationOrigin = userNavigation ? 'navigation' : 'restore';
    this.pendingLinkReturnTarget = null;
    const startCfi = userNavigation
      ? (this.current?.start.cfi ?? this.rendition?.location?.start.cfi ?? null)
      : null;
    this.userNavigationStartCfi = startCfi;
    if (userNavigation && startCfi === null) {
      const activeSection = this.getActiveContents()[0]?.sectionIndex;
      this.userNavigationStartSectionIndex =
        typeof activeSection === 'number' ? activeSection : null;
    } else {
      this.userNavigationStartSectionIndex = null;
    }
    return this.locationGeneration;
  }

  private beginLinkedNavigation(): void {
    const start = this.current?.start ?? this.rendition?.location?.start;
    if (!start) return;
    this.locationGeneration += 1;
    this.userNavigationPending = true;
    this.userNavigationStartCfi = start.cfi;
    this.userNavigationStartSectionIndex = null;
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
