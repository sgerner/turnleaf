import ePub, {
  type Contents,
  type EpubCFI as EpubCfiInstance,
  type Location,
  type Rendition,
} from 'epubjs';
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
  href?: string;
  prefix?: string;
  suffix?: string;
}

export interface ReaderHighlightInput {
  id?: string;
  cfi: string;
  excerpt?: string;
  href?: string | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

export interface ReaderHighlightResolution {
  repaired: Array<{ id: string; cfi: string; href: string }>;
  missingIds: string[];
}

export type ReaderAnnotationDisplayResult =
  | { status: 'displayed'; cfi: string; href: string }
  | { status: 'repaired'; cfi: string; href: string }
  | { status: 'missing' };

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

interface RuntimeCfiStep {
  type: 'element' | 'text';
  index: number;
  id: string | null;
}

interface RuntimeCfiComponent {
  steps: Array<RuntimeCfiStep | undefined>;
  terminal: {
    offset: number | null;
    assertion: string | null;
  } | null;
}

interface RuntimeParsedCfi {
  spinePos: number;
  range: boolean;
  base: RuntimeCfiComponent;
  path: RuntimeCfiComponent;
  start: RuntimeCfiComponent | null;
  end: RuntimeCfiComponent | null;
}

interface EpubCfiConstructor {
  new (
    cfiFrom?: string | Range | Node,
    base?: string | object,
    ignoreClass?: string,
  ): EpubCfiInstance;
}

interface InternalRenditionQueue {
  enqueue?: <T>(task: () => T | Promise<T>) => Promise<T>;
  running?: boolean;
}

interface InternalRenditionStage {
  resizeFunc?: EventListener;
  orientationChangeFunc?: EventListener;
}

interface InternalRenditionManager {
  stage?: InternalRenditionStage;
  resize?: (width?: number, height?: number, epubcfi?: string) => void;
}

type InternalRendition = Rendition & {
  q?: InternalRenditionQueue;
  displaying?: unknown;
  manager?: InternalRenditionManager;
};

function hasRenditionQueue(rendition: Rendition | null): rendition is InternalRendition & {
  q: Required<Pick<InternalRenditionQueue, 'enqueue'>> & InternalRenditionQueue;
} {
  return Boolean(rendition && typeof (rendition as InternalRendition).q?.enqueue === 'function');
}

interface RenderedViewContents {
  document: Document;
  sectionIndex?: number;
  cfiBase?: string;
  range: (cfi: string, ignoreClass?: string) => Range | null;
  cfiFromRange: (range: Range, ignoreClass?: string) => string;
}

interface RenderedEpubView {
  index: number;
  displayed?: boolean;
  section?: { href: string; index: number; cfiBase?: string };
  contents?: RenderedViewContents;
}

interface TextMapPosition {
  node: Text;
  offset: number;
}

interface DocumentTextMap {
  text: string;
  lowerText: string;
  starts: TextMapPosition[];
  ends: TextMapPosition[];
}

interface ClaimedTextSpan {
  start: number;
  end: number;
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

const SELECTION_CONTEXT_CHARS = 64;
const MAX_STORED_EXCERPT_LENGTH = 500;
const IGNORED_TEXT_CONTAINERS = new Set(['head', 'noscript', 'script', 'style', 'title']);
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSpineHref(href: string): string {
  return href.split('#', 1)[0]?.trim() ?? '';
}

function getEpubCfiConstructor(rendition?: Rendition | null): EpubCfiConstructor | null {
  const fromModule = (ePub as unknown as { CFI?: EpubCfiConstructor }).CFI;
  if (typeof fromModule === 'function') return fromModule;
  const fromRendition = (rendition as unknown as { epubcfi?: { constructor?: EpubCfiConstructor } })
    ?.epubcfi?.constructor;
  return typeof fromRendition === 'function' ? fromRendition : null;
}

function parseRuntimeCfi(
  cfi: string,
  CfiClass: EpubCfiConstructor | null,
): RuntimeParsedCfi | null {
  const trimmed = cfi.trim();
  if (!trimmed || !trimmed.includes('!') || !CfiClass) return null;
  try {
    const checker = new CfiClass();
    if (!checker.isCfiString(trimmed)) return null;
    const parsed = new CfiClass(trimmed) as unknown as RuntimeParsedCfi;
    if (!Number.isInteger(parsed.spinePos) || parsed.spinePos < 0) return null;
    if (!Array.isArray(parsed.base?.steps) || !Array.isArray(parsed.path?.steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface ResolvedCfiEndpoint {
  node: Node;
  offset: number;
  clamped: boolean;
  elementOnly: boolean;
}

function resolveCfiStepsInDocument(
  doc: Document,
  steps: Array<RuntimeCfiStep | undefined>,
  terminalOffset: number | null,
): ResolvedCfiEndpoint | null {
  const root = doc.documentElement;
  if (!root || steps.length === 0) return null;
  let current: Node | null = root;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || !Number.isInteger(step.index) || step.index < 0) return null;

    if (step.type === 'element') {
      if (current.nodeType !== Node.ELEMENT_NODE) return null;
      const element = current as Element;
      if (step.id) {
        const indexedChild = element.children[step.index];
        if (indexedChild && indexedChild.getAttribute('id') === step.id) {
          current = indexedChild;
        } else {
          const byId = doc.getElementById(step.id);
          if (!byId || !root.contains(byId)) return null;
          current = byId;
        }
      } else {
        current = element.children[step.index] ?? null;
        if (!current) return null;
      }
      continue;
    }

    if (index !== steps.length - 1 || current.nodeType !== Node.ELEMENT_NODE) return null;
    const textNodes = [...current.childNodes].filter(
      (node): node is Text => node.nodeType === Node.TEXT_NODE,
    );
    const textNode = textNodes[step.index];
    if (!textNode) return null;
    const rawOffset = terminalOffset ?? 0;
    const clampedOffset = Math.max(0, Math.min(rawOffset, textNode.data.length));
    return {
      node: textNode,
      offset: clampedOffset,
      clamped: clampedOffset !== rawOffset,
      elementOnly: false,
    };
  }

  if (terminalOffset === null) {
    return { node: current, offset: 0, clamped: false, elementOnly: true };
  }
  const maxOffset = current.childNodes.length;
  const clampedOffset = Math.max(0, Math.min(terminalOffset, maxOffset));
  return {
    node: current,
    offset: clampedOffset,
    clamped: clampedOffset !== terminalOffset,
    elementOnly: false,
  };
}

function cfiFromEndpoint(
  doc: Document,
  endpoint: ResolvedCfiEndpoint,
  cfiBase: string,
  CfiClass: EpubCfiConstructor,
): string | null {
  try {
    if (endpoint.elementOnly || endpoint.node.nodeType === Node.ELEMENT_NODE) {
      const targetNode =
        !endpoint.elementOnly && endpoint.node.childNodes.length > 0
          ? (endpoint.node.childNodes[
              Math.min(endpoint.offset, endpoint.node.childNodes.length - 1)
            ] ?? endpoint.node)
          : endpoint.node;
      if (targetNode.nodeType === Node.TEXT_NODE) {
        const range = doc.createRange();
        range.setStart(targetNode, 0);
        range.collapse(true);
        return new CfiClass(range, cfiBase).toString();
      }
      return new CfiClass(targetNode, cfiBase).toString();
    }
    const range = doc.createRange();
    range.setStart(endpoint.node, endpoint.offset);
    range.collapse(true);
    return new CfiClass(range, cfiBase).toString();
  } catch {
    return null;
  }
}

function validateAndClampReadingCfi(
  doc: Document,
  parsed: RuntimeParsedCfi,
  originalCfi: string,
  cfiBase: string | undefined,
  CfiClass: EpubCfiConstructor,
): string | null {
  if (!parsed.range) {
    const endpoint = resolveCfiStepsInDocument(
      doc,
      parsed.path.steps,
      parsed.path.terminal?.offset ?? null,
    );
    if (!endpoint) return null;
    if (!cfiBase) return endpoint.clamped ? null : originalCfi;
    return cfiFromEndpoint(doc, endpoint, cfiBase, CfiClass);
  }

  const startSteps = [...parsed.path.steps, ...(parsed.start?.steps ?? [])];
  const endSteps = [...parsed.path.steps, ...(parsed.end?.steps ?? [])];
  const start = resolveCfiStepsInDocument(doc, startSteps, parsed.start?.terminal?.offset ?? null);
  if (!start) return null;
  const end = resolveCfiStepsInDocument(doc, endSteps, parsed.end?.terminal?.offset ?? null);
  if (!cfiBase) return start.clamped || end?.clamped ? null : originalCfi;

  if (end && start.node.nodeType === Node.TEXT_NODE && end.node.nodeType === Node.TEXT_NODE) {
    try {
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (!range.collapsed) return new CfiClass(range, cfiBase).toString();
    } catch {
      // Fall back to the validated start position when the end offset collapsed.
    }
  }
  return cfiFromEndpoint(doc, start, cfiBase, CfiClass);
}

function rangeMatchesExcerpt(
  rangeText: string,
  expectedExcerpt: string,
  excerptWasTruncated: boolean,
): boolean {
  const normalizedRange = normalizeWhitespace(rangeText);
  const normalizedExcerpt = normalizeWhitespace(expectedExcerpt);
  if (!normalizedRange || !normalizedExcerpt) return false;
  if (normalizedRange === normalizedExcerpt) return true;
  if (excerptWasTruncated && normalizedRange.startsWith(normalizedExcerpt)) return true;
  const compactRange = normalizedRange.replace(/\s+/g, '');
  const compactExcerpt = normalizedExcerpt.replace(/\s+/g, '');
  if (compactRange === compactExcerpt) return true;
  return excerptWasTruncated && compactRange.startsWith(compactExcerpt);
}

function isIgnoredTextNode(node: Text): boolean {
  let parent = node.parentElement;
  while (parent) {
    if (IGNORED_TEXT_CONTAINERS.has(parent.localName.toLowerCase())) return true;
    parent = parent.parentElement;
  }
  return false;
}

function closestBlockElement(node: Node): Element | null {
  let current = node.parentElement;
  while (current) {
    if (BLOCK_ELEMENTS.has(current.localName.toLowerCase())) return current;
    current = current.parentElement;
  }
  return null;
}

function buildDocumentTextMap(doc: Document): DocumentTextMap {
  const root = doc.body ?? doc.documentElement;
  if (!root) return { text: '', lowerText: '', starts: [], ends: [] };
  const chars: string[] = [];
  const starts: TextMapPosition[] = [];
  const ends: TextMapPosition[] = [];
  let lastBlock: Element | null = null;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    currentNode = walker.nextNode();
    if (!textNode.data || isIgnoredTextNode(textNode)) continue;
    const block = closestBlockElement(textNode);
    if (chars.length > 0 && block !== lastBlock && chars[chars.length - 1] !== ' ') {
      const previousEnd = ends[ends.length - 1]!;
      chars.push(' ');
      starts.push(previousEnd);
      ends.push({ node: textNode, offset: 0 });
    }
    if (block) lastBlock = block;

    const data = textNode.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const character = data[offset]!;
      if (/\s/.test(character)) {
        if (chars.length === 0 || chars[chars.length - 1] === ' ') continue;
        chars.push(' ');
        starts.push({ node: textNode, offset });
        ends.push({ node: textNode, offset: offset + 1 });
      } else {
        chars.push(character);
        starts.push({ node: textNode, offset });
        ends.push({ node: textNode, offset: offset + 1 });
      }
    }
  }

  if (chars[chars.length - 1] === ' ') {
    chars.pop();
    starts.pop();
    ends.pop();
  }
  const text = chars.join('');
  return { text, lowerText: text.toLowerCase(), starts, ends };
}

function scoreContextAffix(actual: string, expected: string, fromEnd: boolean): number {
  if (!actual || !expected) return 0;
  const actualLower = actual.toLowerCase();
  const expectedLower = expected.toLowerCase();
  const limit = Math.min(actualLower.length, expectedLower.length);
  let matched = 0;
  for (let index = 0; index < limit; index += 1) {
    const actualChar = fromEnd ? actualLower[actualLower.length - 1 - index] : actualLower[index];
    const expectedChar = fromEnd
      ? expectedLower[expectedLower.length - 1 - index]
      : expectedLower[index];
    if (actualChar !== expectedChar) break;
    matched += 1;
  }
  return matched;
}

function recordRangeInTextMap(
  map: DocumentTextMap,
  range: Range,
  claimedSpans: ClaimedTextSpan[],
): void {
  const startIndex = map.starts.findIndex(
    (entry) => entry.node === range.startContainer && entry.offset >= range.startOffset,
  );
  if (startIndex < 0) return;
  for (let index = startIndex; index < map.ends.length; index += 1) {
    const entry = map.ends[index]!;
    if (entry.node === range.endContainer && entry.offset >= range.endOffset) {
      claimedSpans.push({ start: startIndex, end: index + 1 });
      return;
    }
  }
}

interface ExcerptMatchResult {
  range: Range;
  score: number;
  candidateCount: number;
  unambiguous: boolean;
}

function findExcerptMatchInDocument(
  doc: Document,
  excerpt: string,
  options?: {
    prefix?: string | undefined;
    suffix?: string | undefined;
    textMap?: DocumentTextMap | undefined;
    claimedSpans?: ClaimedTextSpan[] | undefined;
    requireUnambiguous?: boolean | undefined;
  },
): ExcerptMatchResult | null {
  const query = normalizeWhitespace(excerpt);
  if (!query) return null;
  const map = options?.textMap ?? buildDocumentTextMap(doc);
  if (!map.text) return null;

  const candidates: ClaimedTextSpan[] = [];
  let searchFrom = 0;
  while (searchFrom <= map.text.length - query.length) {
    const found = map.text.indexOf(query, searchFrom);
    if (found < 0) break;
    candidates.push({ start: found, end: found + query.length });
    searchFrom = found + 1;
  }

  if (candidates.length === 0) {
    const lowerQuery = query.toLowerCase();
    searchFrom = 0;
    while (searchFrom <= map.lowerText.length - lowerQuery.length) {
      const found = map.lowerText.indexOf(lowerQuery, searchFrom);
      if (found < 0) break;
      candidates.push({ start: found, end: found + lowerQuery.length });
      searchFrom = found + 1;
    }
  }

  if (candidates.length === 0) return null;

  const prefix = options?.prefix ? normalizeWhitespace(options.prefix) : '';
  const suffix = options?.suffix ? normalizeWhitespace(options.suffix) : '';
  const claimed = options?.claimedSpans ?? [];

  let chosen = candidates[0]!;
  let bestScore: number;
  let tiedBestCount = 1;

  if (candidates.length === 1) {
    const before = prefix
      ? map.text.slice(Math.max(0, chosen.start - prefix.length - 8), chosen.start).trimEnd()
      : '';
    const after = suffix
      ? map.text
          .slice(chosen.end, Math.min(map.text.length, chosen.end + suffix.length + 8))
          .trimStart()
      : '';
    bestScore = scoreContextAffix(before, prefix, true) + scoreContextAffix(after, suffix, false);
  } else {
    bestScore = -1;
    tiedBestCount = 0;
    let bestUnclaimed = false;
    for (const candidate of candidates) {
      const before = prefix
        ? map.text
            .slice(Math.max(0, candidate.start - prefix.length - 8), candidate.start)
            .trimEnd()
        : '';
      const after = suffix
        ? map.text
            .slice(candidate.end, Math.min(map.text.length, candidate.end + suffix.length + 8))
            .trimStart()
        : '';
      const score =
        scoreContextAffix(before, prefix, true) + scoreContextAffix(after, suffix, false);
      const isUnclaimed = !claimed.some(
        (span) => candidate.start < span.end && candidate.end > span.start,
      );
      if (score > bestScore) {
        bestScore = score;
        tiedBestCount = 1;
        bestUnclaimed = isUnclaimed;
        chosen = candidate;
      } else if (score === bestScore) {
        tiedBestCount += 1;
        if (isUnclaimed && !bestUnclaimed) {
          bestUnclaimed = isUnclaimed;
          chosen = candidate;
        }
      }
    }
  }

  const unambiguous = candidates.length === 1 || (bestScore > 0 && tiedBestCount === 1);
  if (options?.requireUnambiguous && !unambiguous) {
    return null;
  }

  const startPos = map.starts[chosen.start];
  const endPos = map.ends[chosen.end - 1];
  if (!startPos || !endPos) return null;
  try {
    const range = doc.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    if (range.collapsed) return null;
    options?.claimedSpans?.push(chosen);
    return { range, score: Math.max(0, bestScore), candidateCount: candidates.length, unambiguous };
  } catch {
    return null;
  }
}

export function findExcerptRangeInDocument(
  doc: Document,
  excerpt: string,
  options?: {
    prefix?: string | undefined;
    suffix?: string | undefined;
    textMap?: DocumentTextMap | undefined;
    claimedSpans?: ClaimedTextSpan[] | undefined;
    requireUnambiguous?: boolean | undefined;
  },
): Range | null {
  return findExcerptMatchInDocument(doc, excerpt, options)?.range ?? null;
}

function extractSelectionContext(
  doc: Document,
  range: Range,
): { prefix?: string; suffix?: string } {
  const root = doc.body ?? doc.documentElement;
  if (!root) return {};
  try {
    const beforeRange = doc.createRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const prefix = normalizeWhitespace(beforeRange.toString()).slice(-SELECTION_CONTEXT_CHARS);

    const afterRange = doc.createRange();
    afterRange.selectNodeContents(root);
    afterRange.setStart(range.endContainer, range.endOffset);
    const suffix = normalizeWhitespace(afterRange.toString()).slice(0, SELECTION_CONTEXT_CHARS);

    return {
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    };
  } catch {
    return {};
  }
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
  private viewportTarget: HTMLElement | null = null;
  private epubContainer: HTMLElement | null = null;
  private lockedScrollLeft = 0;
  private displayOperationCount = 0;
  private aligningFocusTarget: Element | null = null;
  private displayedListener: (() => void) | null = null;
  private renderedListener: (() => void) | null = null;
  private resizedListener: (() => void) | null = null;
  private unloadedHookRegistered = false;
  private readonly trackedContents = new Set<Contents>();
  private readonly contentCleanups = new Map<Contents, Array<() => void>>();
  private renditionReady = false;
  private initialRelocationCompleted = false;
  private activeDisplayDepth = 0;
  private pendingRelocationFrames = 0;
  private relocationFrameSeq = 0;
  private relocationResolvers = new Set<() => void>();
  private pendingViewportResize: { width: number; height: number } | null = null;
  private resizeFlushScheduled = false;
  private applyingViewportResize = false;
  private restoreManagerResize: (() => void) | null = null;
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
    this.renditionReady = false;
    this.initialRelocationCompleted = false;
    this.pendingViewportResize = null;
    this.resizeFlushScheduled = false;
    this.rendition = this.book.renderTo(target, {
      width: '100%',
      height: '100%',
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      resizeOnOrientationChange: false,
      allowScriptedContent: false,
    });
    this.activeDisplayDepth += 1;
    try {
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
              const context = extractSelectionContext(contents.document, range);
              onSelection({
                cfi: contents.cfiFromRange(range),
                text,
                ...(href ? { href } : {}),
                ...context,
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
        const hadInitialLocation = this.initialRelocationCompleted;
        this.initialRelocationCompleted = true;
        const isQueuedRendition = hasRenditionQueue(this.rendition);
        const startCfi = this.userNavigationStartCfi ?? this.current?.start.cfi ?? null;
        const isUserNavigation =
          this.userNavigationPending &&
          (startCfi
            ? startCfi !== location.start.cfi
            : (!isQueuedRendition || hadInitialLocation) && !this.reflowPending);
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
      this.installViewportResizeGuard(target);
      if (cfi) {
        if (await this.displaySavedCfi(cfi, restoreGeneration)) return;
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
    } finally {
      this.activeDisplayDepth = Math.max(0, this.activeDisplayDepth - 1);
      if (this.canApplyViewportResizeNow()) {
        this.flushPendingViewportResize();
      } else {
        this.scheduleViewportResizeFlush();
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
  ): Promise<ReaderAnnotationDisplayResult> {
    if (!this.rendition) return { status: 'missing' };
    const CfiClass = getEpubCfiConstructor(this.rendition);
    if (!CfiClass) return { status: 'missing' };

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
      );
      if (outcome) {
        try {
          await this.navigate(() => this.awaitRenditionDisplay(outcome.cfi));
          if (outcome.repaired) {
            this.recordRepairedHighlight(annotation.id, outcome.cfi, primarySection.href);
          }
          return {
            status: outcome.repaired ? 'repaired' : 'displayed',
            cfi: outcome.cfi,
            href: primarySection.href,
          };
        } catch {
          return { status: 'missing' };
        }
      }
    }

    if (annotation.excerpt && normalizeWhitespace(annotation.excerpt)) {
      const { sections } = this.getSpine();
      const crossChapterCandidates: Array<{
        section: SpineSection;
        cfi: string;
        score: number;
        candidateCount: number;
        unambiguousInSection: boolean;
        unloadAfterFailure: () => void;
      }> = [];
      let totalOccurrences = 0;

      for (const section of sections) {
        if (primarySection && section.index === primarySection.index) continue;
        const loaded = await this.loadSectionDocument(section);
        if (!loaded) continue;
        const matched = findExcerptMatchInDocument(loaded.document, annotation.excerpt, {
          prefix: annotation.prefix,
          suffix: annotation.suffix,
        });
        if (!matched || !loaded.cfiBase) {
          loaded.unloadAfterFailure();
          continue;
        }
        totalOccurrences += matched.candidateCount;
        try {
          const freshCfi = new CfiClass(matched.range, loaded.cfiBase).toString();
          crossChapterCandidates.push({
            section,
            cfi: freshCfi,
            score: matched.score,
            candidateCount: matched.candidateCount,
            unambiguousInSection: matched.unambiguous,
            unloadAfterFailure: loaded.unloadAfterFailure,
          });
        } catch {
          loaded.unloadAfterFailure();
        }
      }

      if (crossChapterCandidates.length > 0) {
        let winner = crossChapterCandidates[0]!;
        let bestScore = winner.score;
        let tiedBestCount = 1;
        for (let index = 1; index < crossChapterCandidates.length; index += 1) {
          const candidate = crossChapterCandidates[index]!;
          if (candidate.score > bestScore) {
            bestScore = candidate.score;
            tiedBestCount = 1;
            winner = candidate;
          } else if (candidate.score === bestScore) {
            tiedBestCount += 1;
          }
        }

        const globallyUnambiguous =
          totalOccurrences === 1 ||
          (bestScore > 0 && tiedBestCount === 1 && winner.unambiguousInSection);

        for (const candidate of crossChapterCandidates) {
          if (candidate !== winner || !globallyUnambiguous) {
            candidate.unloadAfterFailure();
          }
        }

        if (globallyUnambiguous) {
          const canPersistRepair = annotation.excerpt.length < MAX_STORED_EXCERPT_LENGTH;
          try {
            await this.navigate(() => this.awaitRenditionDisplay(winner.cfi));
            if (canPersistRepair) {
              this.recordRepairedHighlight(annotation.id, winner.cfi, winner.section.href);
            }
            return {
              status: canPersistRepair ? 'repaired' : 'displayed',
              cfi: winner.cfi,
              href: winner.section.href,
            };
          } catch {
            winner.unloadAfterFailure();
            return { status: 'missing' };
          }
        }
      }
    }

    return { status: 'missing' };
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
    await this.navigate(() => this.awaitRenditionDisplay(target));
  }

  async displayHref(href: string): Promise<boolean> {
    if (!this.rendition) return false;
    const section = this.findSpineSectionByHref(href);
    if (!section) return false;
    let target = section.href;
    const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1).trim() : '';
    if (fragment) {
      const loaded = await this.loadSectionDocument(section);
      if (loaded?.document.getElementById(fragment)) {
        target = `${section.href}#${fragment}`;
      }
    }
    try {
      await this.navigate(() => this.awaitRenditionDisplay(target));
      return true;
    } catch {
      return false;
    }
  }

  async displayCfi(cfi: string, fallbackHref?: string): Promise<boolean> {
    if (!this.rendition) return false;
    const resolvedCfi = await this.resolveValidCfi(cfi, fallbackHref);
    if (!resolvedCfi || !this.rendition) return false;
    try {
      await this.navigate(() => this.awaitRenditionDisplay(resolvedCfi));
      return true;
    } catch {
      return false;
    }
  }

  async displayPercentageLocation(percentage: number): Promise<boolean> {
    if (!this.rendition || !Number.isFinite(percentage) || percentage < 0) return false;
    const { sections } = this.getSpine();
    if (!sections.length) return false;
    const position = Math.max(0, Math.min(0.999, percentage));
    const section = sections[Math.floor(position * sections.length)];
    if (!section) return false;
    try {
      await this.navigate(() => this.awaitRenditionDisplay(section.href));
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
    this.locationGeneration += 1;
    this.restoreManagerResize?.();
    this.restoreManagerResize = null;
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
    this.viewportTarget = null;
    this.lockedScrollLeft = 0;
    this.displayOperationCount = 0;
    this.aligningFocusTarget = null;
    this.unloadedHookRegistered = false;
    this.renditionReady = false;
    this.initialRelocationCompleted = false;
    this.activeDisplayDepth = 0;
    this.pendingRelocationFrames = 0;
    this.pendingViewportResize = null;
    this.resizeFlushScheduled = false;
    this.applyingViewportResize = false;
    this.resolveRelocationWaiters();
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
    return (
      this.displayOperationCount > 0 ||
      this.activeDisplayDepth > 0 ||
      this.applyingViewportResize ||
      this.userNavigationPending
    );
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
      this.requestViewportResize(width, height);
    });
    this.resizeObserver.observe(target);
  }

  private invokeRenditionResize(width: number, height: number, targetCfi?: string): void {
    const rendition = this.rendition;
    if (!rendition) return;
    this.displayOperationCount += 1;
    try {
      const resizeWithCfi = rendition.resize as (
        nextWidth: number,
        nextHeight: number,
        epubcfi?: string,
      ) => void;
      if (targetCfi) {
        resizeWithCfi.call(rendition, width, height, targetCfi);
      } else {
        rendition.resize(width, height);
      }
    } finally {
      const container = this.bindEpubContainer();
      if (container) this.lockedScrollLeft = container.scrollLeft;
      this.displayOperationCount = Math.max(0, this.displayOperationCount - 1);
      this.syncVisibleColumnLinks();
    }
  }

  private installViewportResizeGuard(target: HTMLElement): void {
    const rendition = this.rendition as InternalRendition | null;
    if (!rendition) return;
    const manager = rendition.manager;
    const stage = manager?.stage;
    if (typeof ResizeObserver !== 'undefined' && typeof window !== 'undefined' && stage) {
      if (stage.resizeFunc) {
        window.removeEventListener('resize', stage.resizeFunc, false);
      }
      if (stage.orientationChangeFunc) {
        window.removeEventListener('orientationchange', stage.orientationChangeFunc, false);
      }
    }
    if (manager && typeof manager.resize === 'function') {
      const originalResize = manager.resize.bind(manager);
      manager.resize = (width?: number, height?: number, epubcfi?: string) => {
        if (this.applyingViewportResize) {
          originalResize(width, height, epubcfi);
          return;
        }
        const rect = target.getBoundingClientRect();
        const nextWidth = Math.floor(width ?? rect.width);
        const nextHeight = Math.floor(height ?? rect.height);
        if (!nextWidth || !nextHeight) return;
        this.viewportSize = { width: nextWidth, height: nextHeight };
        this.requestViewportResize(nextWidth, nextHeight);
      };
      this.restoreManagerResize = () => {
        manager.resize = originalResize;
      };
    }
    this.renditionReady = true;
  }

  private canApplyViewportResizeNow(): boolean {
    const rendition = this.rendition as InternalRendition | null;
    if (!rendition || this.applyingViewportResize) return false;
    if (!hasRenditionQueue(rendition)) {
      return this.activeDisplayDepth === 0;
    }
    if (!this.renditionReady || !rendition.manager?.stage) return false;
    if (this.activeDisplayDepth > 0 || this.pendingRelocationFrames > 0) return false;
    if (this.userNavigationPending) return false;
    if (rendition.q.running || rendition.displaying !== undefined) return false;
    return Boolean(this.current?.start.cfi ?? rendition.location?.start?.cfi);
  }

  private requestViewportResize(width: number, height: number): void {
    if (!this.rendition) return;
    if (!hasRenditionQueue(this.rendition) && !(this.rendition as InternalRendition).manager) {
      if (this.activeDisplayDepth === 0) {
        this.invokeRenditionResize(width, height);
      } else {
        this.pendingViewportResize = { width, height };
      }
      return;
    }
    this.pendingViewportResize = { width, height };
    if (this.canApplyViewportResizeNow()) {
      this.flushPendingViewportResize();
      return;
    }
    this.scheduleViewportResizeFlush();
  }

  private scheduleViewportResizeFlush(): void {
    if (!this.pendingViewportResize || !this.rendition) return;
    if (!hasRenditionQueue(this.rendition) && !(this.rendition as InternalRendition).manager) {
      if (this.activeDisplayDepth === 0) {
        const pending = this.pendingViewportResize;
        this.pendingViewportResize = null;
        this.invokeRenditionResize(pending.width, pending.height);
      }
      return;
    }
    if (this.resizeFlushScheduled) return;
    this.resizeFlushScheduled = true;
    const run = () => {
      this.resizeFlushScheduled = false;
      this.flushPendingViewportResize();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  private flushPendingViewportResize(): void {
    const rendition = this.rendition;
    const pending = this.pendingViewportResize;
    if (!rendition || !pending) return;
    if (!this.canApplyViewportResizeNow()) return;

    this.pendingViewportResize = null;
    const targetCfi = this.current?.start.cfi ?? rendition.location?.start?.cfi;
    const canListen = typeof rendition.on === 'function' && typeof rendition.off === 'function';
    let didEmitResized = false;
    const onResized = () => {
      didEmitResized = true;
    };
    if (canListen) rendition.on('resized', onResized);
    this.applyingViewportResize = true;
    try {
      this.invokeRenditionResize(pending.width, pending.height, targetCfi);
    } finally {
      this.applyingViewportResize = false;
      if (canListen) rendition.off('resized', onResized);
    }

    if (didEmitResized && Boolean(rendition.location?.start)) {
      this.trackPendingRelocationFrame(rendition);
    }
    if (this.pendingViewportResize) {
      this.scheduleViewportResizeFlush();
    }
  }

  private trackPendingRelocationFrame(rendition: Rendition): void {
    if (!hasRenditionQueue(rendition)) return;
    this.relocationFrameSeq += 1;
    this.pendingRelocationFrames += 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (this.rendition !== rendition) return;
      this.pendingRelocationFrames = Math.max(0, this.pendingRelocationFrames - 1);
      if (this.pendingRelocationFrames === 0) {
        this.resolveRelocationWaiters();
        if (this.canApplyViewportResizeNow()) {
          this.flushPendingViewportResize();
        } else {
          this.scheduleViewportResizeFlush();
        }
      }
    };
    const scheduleAfterPaint = () => {
      const afterFrame = () => {
        void Promise.resolve().then(finish);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(afterFrame);
      } else {
        setTimeout(afterFrame, 0);
      }
    };
    void rendition.q
      .enqueue(() => {
        scheduleAfterPaint();
      })
      .catch(() => {
        finish();
      });
  }

  private waitForPendingRelocations(): Promise<void> {
    if (!hasRenditionQueue(this.rendition) || this.pendingRelocationFrames === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.relocationResolvers.add(resolve);
    });
  }

  private resolveRelocationWaiters(): void {
    if (this.relocationResolvers.size === 0) return;
    const waiters = [...this.relocationResolvers];
    this.relocationResolvers.clear();
    for (const resolve of waiters) {
      resolve();
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
    await this.awaitRenditionDisplay(target);
    return this.isCurrentLocationOperation(generation);
  }

  private async displaySavedCfi(
    cfi: string,
    generation: number,
    fallbackHref?: string,
  ): Promise<boolean> {
    if (!this.rendition || !this.isCurrentLocationOperation(generation)) return false;
    const resolvedCfi = await this.resolveValidCfi(cfi, fallbackHref);
    if (!resolvedCfi || !this.isCurrentLocationOperation(generation)) return false;
    try {
      return await this.displayAtGeneration(resolvedCfi, generation);
    } catch {
      return false;
    }
  }

  private async awaitRenditionDisplay(target?: string): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) throw new Error('Reader is not open.');
    const canListenForError =
      typeof rendition.on === 'function' && typeof rendition.off === 'function';
    this.activeDisplayDepth += 1;
    let onError: ((error: unknown) => void) | null = null;
    try {
      await this.runDisplayOperation(async () => {
        if (!canListenForError) {
          if (target === undefined) await rendition.display();
          else await rendition.display(target);
          return;
        }
        const errorPromise = new Promise<never>((_, reject) => {
          onError = (error: unknown) => {
            reject(error instanceof Error ? error : new Error('Failed to display EPUB section.'));
          };
          rendition.on('displayError', onError);
        });
        const displayPromise =
          target === undefined ? rendition.display() : rendition.display(target);
        await Promise.race([displayPromise, errorPromise]);
      });
      this.trackPendingRelocationFrame(rendition);
    } finally {
      if (onError && canListenForError) rendition.off('displayError', onError);
      this.activeDisplayDepth = Math.max(0, this.activeDisplayDepth - 1);
      if (this.canApplyViewportResizeNow()) {
        this.flushPendingViewportResize();
      } else {
        this.scheduleViewportResizeFlush();
      }
    }
  }

  private async displayXPath(xpath: string, generation: number): Promise<boolean> {
    const rendition = this.rendition;
    if (!rendition || !this.isCurrentLocationOperation(generation)) return false;
    const target = parseKavitaXPath(xpath);
    if (!target) return false;
    const section = this.getSpine().sections[target.spineIndex];
    if (!section) return false;
    try {
      await this.awaitRenditionDisplay(section.href);
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
      await this.awaitRenditionDisplay(cfi);
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
    await this.waitForPendingRelocations();
    const rendition = this.rendition;
    if (!rendition) throw new Error('Reader is not open.');
    const generation = this.beginLocationOperation(true);
    const framesBefore = this.relocationFrameSeq;
    this.activeDisplayDepth += 1;
    try {
      await this.runDisplayOperation(display);
      if (this.relocationFrameSeq === framesBefore) {
        this.trackPendingRelocationFrame(rendition);
      }
    } catch (error) {
      if (this.isCurrentLocationOperation(generation)) {
        this.userNavigationPending = false;
        this.userNavigationStartCfi = null;
      }
      throw error;
    } finally {
      this.activeDisplayDepth = Math.max(0, this.activeDisplayDepth - 1);
      if (this.canApplyViewportResizeNow()) {
        this.flushPendingViewportResize();
      } else {
        this.scheduleViewportResizeFlush();
      }
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
    if (!getEpubCfiConstructor(rendition)) {
      void this.awaitRenditionDisplay(cfi).catch(() => {
        // The current passage may disappear while a reflow is being applied.
      });
      return;
    }
    void this.resolveValidCfi(cfi)
      .then((resolvedCfi) => {
        if (
          !resolvedCfi ||
          !this.isCurrentLocationOperation(generation) ||
          this.userNavigationPending
        ) {
          return;
        }
        return this.awaitRenditionDisplay(resolvedCfi);
      })
      .catch(() => {
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
      const hasBodyUnsafeNodes = Boolean(
        rawDoc.querySelector(
          'body script, body iframe, body object, body embed, body form, body meta[http-equiv]',
        ),
      );
      let document = rawDoc;
      if (hasBodyUnsafeNodes) {
        document = rawDoc.cloneNode(true) as Document;
        document
          .querySelectorAll('script, iframe, object, embed, form, meta[http-equiv]')
          .forEach((node) => node.remove());
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

  private async resolveValidCfi(cfi: string, fallbackHref?: string): Promise<string | null> {
    const CfiClass = getEpubCfiConstructor(this.rendition);
    if (!CfiClass) return cfi.trim() || null;
    const parsed = parseRuntimeCfi(cfi, CfiClass);
    if (!parsed) return null;
    const section = this.resolveSpineSectionForCfi(parsed, fallbackHref);
    if (!section) return null;
    const loaded = await this.loadSectionDocument(section);
    if (!loaded) return null;
    const validated = validateAndClampReadingCfi(
      loaded.document,
      parsed,
      cfi,
      loaded.cfiBase,
      CfiClass,
    );
    if (!validated) {
      loaded.unloadAfterFailure();
      return null;
    }
    return validated;
  }

  private async resolveAnnotationInSection(
    annotation: ReaderHighlightInput,
    parsed: RuntimeParsedCfi | null,
    section: SpineSection,
    CfiClass: EpubCfiConstructor,
  ): Promise<{ cfi: string; repaired: boolean } | null> {
    const loaded = await this.loadSectionDocument(section);
    if (!loaded) return null;
    const direct =
      parsed && parsed.spinePos === section.index
        ? this.validateHighlightRangeInDocument(
            loaded.document,
            parsed,
            annotation,
            loaded.cfiBase,
            CfiClass,
          )
        : null;
    if (direct) {
      return { cfi: direct.cfi, repaired: direct.repaired };
    }
    if (annotation.excerpt && normalizeWhitespace(annotation.excerpt)) {
      const matched = findExcerptMatchInDocument(loaded.document, annotation.excerpt, {
        prefix: annotation.prefix,
        suffix: annotation.suffix,
        requireUnambiguous: true,
      });
      if (matched && loaded.cfiBase) {
        try {
          const freshCfi = new CfiClass(matched.range, loaded.cfiBase).toString();
          const canPersistRepair =
            freshCfi !== annotation.cfi && annotation.excerpt.length < MAX_STORED_EXCERPT_LENGTH;
          return { cfi: freshCfi, repaired: canPersistRepair };
        } catch {
          // Fall through and unload temporary section.
        }
      }
    }
    loaded.unloadAfterFailure();
    return null;
  }

  private validateHighlightRangeInDocument(
    doc: Document,
    parsed: RuntimeParsedCfi,
    annotation: ReaderHighlightInput,
    cfiBase: string | undefined,
    CfiClass: EpubCfiConstructor,
  ): { cfi: string; range: Range; repaired: boolean } | null {
    const range = doc.createRange();
    let clamped: boolean;
    if (parsed.range) {
      const startSteps = [...parsed.path.steps, ...(parsed.start?.steps ?? [])];
      const endSteps = [...parsed.path.steps, ...(parsed.end?.steps ?? [])];
      const start = resolveCfiStepsInDocument(
        doc,
        startSteps,
        parsed.start?.terminal?.offset ?? null,
      );
      const end = resolveCfiStepsInDocument(doc, endSteps, parsed.end?.terminal?.offset ?? null);
      if (!start || !end) return null;
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        return null;
      }
      clamped = start.clamped || end.clamped;
    } else {
      const endpoint = resolveCfiStepsInDocument(
        doc,
        parsed.path.steps,
        parsed.path.terminal?.offset ?? null,
      );
      if (!endpoint) return null;
      try {
        range.selectNodeContents(endpoint.node);
      } catch {
        return null;
      }
      clamped = endpoint.clamped;
    }

    if (range.collapsed) return null;
    const rangeText = range.toString();
    if (!normalizeWhitespace(rangeText)) return null;
    if (
      annotation.excerpt !== undefined &&
      !rangeMatchesExcerpt(rangeText, annotation.excerpt, annotation.excerpt.length >= 500)
    ) {
      return null;
    }

    if (!clamped) {
      return { cfi: annotation.cfi, range, repaired: false };
    }
    if (!cfiBase) return null;
    try {
      const freshCfi = new CfiClass(range, cfiBase).toString();
      return { cfi: freshCfi, range, repaired: freshCfi !== annotation.cfi };
    } catch {
      return null;
    }
  }

  private isHighlightCandidateForView(
    annotation: ReaderHighlightInput,
    parsed: RuntimeParsedCfi | null,
    viewIndex: number,
    viewHref: string,
  ): { matches: boolean; authoritative: boolean } {
    if (annotation.href) {
      const byHref = this.findSpineSectionByHref(annotation.href);
      if (!byHref) {
        return { matches: false, authoritative: false };
      }
      const same = byHref.index === viewIndex || normalizeSpineHref(viewHref) === byHref.href;
      return { matches: same, authoritative: same };
    }
    if (!parsed) {
      return { matches: false, authoritative: false };
    }
    const targetSection = this.resolveSpineSectionForCfi(parsed);
    if (!targetSection) {
      return { matches: false, authoritative: false };
    }
    const same = targetSection.index === viewIndex;
    return { matches: same, authoritative: same };
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

  private recordRepairedHighlight(id: string | undefined, cfi: string, href: string): void {
    if (!id) return;
    this.reportedMissingHighlightIds.delete(id);
    this.storedHighlights = this.storedHighlights.map((item) =>
      item.id === id ? { ...item, cfi, href } : item,
    );
  }

  private syncRenderedHighlights(): void {
    const rendition = this.rendition;
    if (!rendition) return;

    const hasViewsMethod =
      typeof (rendition as unknown as { views?: unknown }).views === 'function';
    if (!hasViewsMethod) {
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

      for (const annotation of this.storedHighlights) {
        const parsed = CfiClass ? parseRuntimeCfi(annotation.cfi, CfiClass) : null;
        const candidate = this.isHighlightCandidateForView(
          annotation,
          parsed,
          view.index,
          viewHref,
        );
        if (!candidate.matches) continue;

        let resolvedCfi: string | null = null;
        let wasRepaired = false;

        if (parsed && CfiClass && parsed.spinePos === view.index) {
          const validated = this.validateHighlightRangeInDocument(
            contents.document,
            parsed,
            annotation,
            cfiBase,
            CfiClass,
          );
          if (validated) {
            if (this.isRangeUsableOnView(view, validated.cfi)) {
              resolvedCfi = validated.cfi;
              wasRepaired = validated.repaired;
              if (annotation.excerpt) {
                recordRangeInTextMap(getTextMap(), validated.range, claimedSpans);
              }
            } else if (typeof contents.cfiFromRange === 'function') {
              try {
                const regenerated = contents.cfiFromRange(validated.range);
                if (this.isRangeUsableOnView(view, regenerated)) {
                  resolvedCfi = regenerated;
                  wasRepaired = regenerated !== annotation.cfi;
                  if (annotation.excerpt) {
                    recordRangeInTextMap(getTextMap(), validated.range, claimedSpans);
                  }
                }
              } catch {
                // Fall back to excerpt search below.
              }
            }
          }
        }

        if (!resolvedCfi && annotation.excerpt && typeof contents.cfiFromRange === 'function') {
          const matched = findExcerptMatchInDocument(contents.document, annotation.excerpt, {
            prefix: annotation.prefix,
            suffix: annotation.suffix,
            textMap: getTextMap(),
            claimedSpans,
            requireUnambiguous: true,
          });
          if (matched) {
            try {
              const freshCfi = contents.cfiFromRange(matched.range);
              if (this.isRangeUsableOnView(view, freshCfi)) {
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
          candidate.authoritative &&
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

    if (repaired.length > 0) {
      const repairById = new Map(repaired.map((entry) => [entry.id, entry]));
      this.storedHighlights = this.storedHighlights.map((item) => {
        const repair = item.id ? repairById.get(item.id) : undefined;
        return repair ? { ...item, cfi: repair.cfi, href: repair.href } : item;
      });
    }

    if ((repaired.length > 0 || newlyMissingIds.length > 0) && this.onHighlightResolution) {
      this.onHighlightResolution({ repaired, missingIds: newlyMissingIds });
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
