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
  url?: string | undefined;
  document?: Document | undefined;
  hooks?: EpubSpineHooks | undefined;
  load: (request: (url: string) => Promise<Document>) => Promise<unknown>;
  unload: () => void;
}

interface EpubSpineContentHook {
  context?: unknown;
  register?:
    | ((callback: (document: Document, section: SpineSection) => Promise<void> | void) => void)
    | undefined;
  deregister?: ((callback: (...args: unknown[]) => unknown) => void) | undefined;
  list?: (() => unknown) | undefined;
  trigger?: ((...args: unknown[]) => Promise<unknown> | unknown) | undefined;
}

interface EpubSpineHooks {
  content?: EpubSpineContentHook | undefined;
}

interface EpubArchiveLike {
  urlCache?: Record<string, string> | undefined;
  getText?: ((url: string) => Promise<string> | undefined) | undefined;
  createUrl?:
    ((url: string, options?: { base64?: boolean | undefined }) => Promise<string>) | undefined;
}

interface EpubResourcesLike {
  urls?: unknown;
  cssUrls?: unknown;
  replacementUrls?: unknown;
  settings?:
    | {
        replacements?: string | undefined;
        archive?: EpubArchiveLike | undefined;
        resolver?: ((href: string) => string) | undefined;
        request?: ((path: string, type: string) => Promise<string> | undefined) | undefined;
      }
    | undefined;
  substitute?: ((content: string, url?: string) => string) | undefined;
  createUrl?: ((url: string) => Promise<string>) | undefined;
  replaceCss?: ((archive?: unknown, resolver?: unknown) => Promise<unknown>) | undefined;
  createCssFile?:
    | ((href: string, archive?: unknown, resolver?: unknown) => Promise<string | undefined>)
    | undefined;
}

export interface EpubBookLike {
  archived?: boolean | undefined;
  archive?: EpubArchiveLike | undefined;
  loaded?:
    | {
        resources?: Promise<unknown> | undefined;
        spine?: Promise<unknown> | undefined;
      }
    | undefined;
  resources?: EpubResourcesLike | undefined;
  spine?:
    | {
        hooks?: EpubSpineHooks | undefined;
        spineItems?: SpineSection[] | undefined;
        each?: ((visit: (section: SpineSection) => void) => void) | undefined;
      }
    | undefined;
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
const EPUB_ARCHIVE_ORIGIN = 'https://epub.turnleaf.invalid';
const EPUBJS_THEME_STYLE_PREFIX = 'epubjs-inserted-css-';

/**
 * Local-only Content Security Policy prepended into every sanitized EPUB chapter `<head>`
 * before `Section.render()` serializes `iframe.srcdoc` (intersecting with parent `index.html`):
 * - Restrictive defaults retained: `default-src 'none'`, `script-src 'none'` (alongside iframe
 *   `sandbox="allow-same-origin"` without `allow-scripts`), `connect-src 'none'`, `frame-src 'none'`,
 *   `object-src 'none'`, `form-action 'none'`, `manifest-src 'none'`, and `worker-src 'none'`.
 * - `base-uri 'self'`: required for `epub.js` `replaceBase` (`<base href="${origin}${section.url}">`)
 *   on Android (`https://localhost`) and iOS (`capacitor://localhost`), blocking external `<base>`.
 * - `style-src 'self' 'unsafe-inline' data: blob:`: required for sanitized `<style>` blocks, author
 *   inline `style` attributes when `publisherStyles` is enabled, `epub.js` theme & column pagination
 *   styles, and sanitized `blob:`/`data:` manifest stylesheets.
 * - `font-src`, `img-src`, and `media-src` `'self' data: blob:`: required for packaged EPUB fonts,
 *   raster/SVG images, and `<audio>`/`<video>` media unpacked into same-origin `blob:` or allowlisted
 *   base64 `data:` URLs while blocking all remote `http:`/`https:` targets.
 */
export const EPUB_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'self'",
  "connect-src 'none'",
  "font-src 'self' data: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'none'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "worker-src 'none'",
].join('; ');
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

function isSafeEpubReference(
  value: string,
  kind: EpubReferenceKind,
  baseURI?: string | undefined,
): boolean {
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

function sanitizeSrcset(value: string, baseURI?: string | undefined): string | null {
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

type CssTokenType =
  | 'at-keyword'
  | 'bad-string'
  | 'bad-url'
  | 'brace-close'
  | 'brace-open'
  | 'cdc'
  | 'cdo'
  | 'comma'
  | 'comment'
  | 'function'
  | 'ident'
  | 'other'
  | 'paren-close'
  | 'paren-open'
  | 'semicolon'
  | 'string'
  | 'url'
  | 'whitespace';

interface CssToken {
  type: CssTokenType;
  value: string;
  raw: string;
}

function preprocessCssInput(raw: string): string {
  return raw.replace(/\r\n|\r|\f/g, '\n').replaceAll('\0', '\uFFFD');
}

function isCssWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n';
}

function isHexDigitCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isIdentStartCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isIdentCode(code: number): boolean {
  return isIdentStartCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d;
}

function isNonPrintableCssCode(code: number): boolean {
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
}

function isValidCssEscape(input: string, index: number): boolean {
  return input[index] === '\\' && input[index + 1] !== '\n';
}

function wouldStartCssIdent(input: string, index: number): boolean {
  if (index >= input.length) return false;
  const first = input.charCodeAt(index);
  if (first === 0x2d) {
    if (index + 1 >= input.length) return false;
    const second = input.charCodeAt(index + 1);
    return isIdentStartCode(second) || second === 0x2d || isValidCssEscape(input, index + 1);
  }
  if (isIdentStartCode(first)) return true;
  if (first === 0x5c) return isValidCssEscape(input, index);
  return false;
}

function consumeCssEscapedCodePoint(
  input: string,
  slashIndex: number,
): { value: string; next: number } {
  let cursor = slashIndex + 1;
  if (cursor >= input.length) return { value: '\uFFFD', next: cursor };
  const firstCode = input.charCodeAt(cursor);
  if (isHexDigitCode(firstCode)) {
    let hexEnd = cursor + 1;
    while (
      hexEnd < input.length &&
      hexEnd - cursor < 6 &&
      isHexDigitCode(input.charCodeAt(hexEnd))
    ) {
      hexEnd += 1;
    }
    const codePoint = Number.parseInt(input.slice(cursor, hexEnd), 16);
    cursor = hexEnd;
    if (isCssWhitespace(input[cursor])) cursor += 1;
    if (
      !Number.isFinite(codePoint) ||
      codePoint === 0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
    ) {
      return { value: '\uFFFD', next: cursor };
    }
    return { value: String.fromCodePoint(codePoint), next: cursor };
  }
  const codePoint = input.codePointAt(cursor)!;
  const step = codePoint > 0xffff ? 2 : 1;
  return { value: String.fromCodePoint(codePoint), next: cursor + step };
}

function consumeCssIdentSequence(
  input: string,
  startIndex: number,
): { value: string; next: number } {
  let cursor = startIndex;
  let value = '';
  while (cursor < input.length) {
    if (isValidCssEscape(input, cursor)) {
      const escaped = consumeCssEscapedCodePoint(input, cursor);
      value += escaped.value;
      cursor = escaped.next;
      continue;
    }
    const codePoint = input.codePointAt(cursor)!;
    if (!isIdentCode(codePoint)) break;
    value += String.fromCodePoint(codePoint);
    cursor += codePoint > 0xffff ? 2 : 1;
  }
  return { value, next: cursor };
}

function consumeCssStringToken(
  input: string,
  quoteIndex: number,
): { token: CssToken; next: number } {
  const quote = input[quoteIndex]!;
  let cursor = quoteIndex + 1;
  let value = '';
  while (cursor < input.length) {
    const ch = input[cursor]!;
    if (ch === quote) {
      cursor += 1;
      return {
        token: { type: 'string', value, raw: input.slice(quoteIndex, cursor) },
        next: cursor,
      };
    }
    if (ch === '\n') {
      return {
        token: { type: 'bad-string', value: '', raw: input.slice(quoteIndex, cursor) },
        next: cursor,
      };
    }
    if (ch === '\\') {
      if (cursor + 1 >= input.length) {
        cursor += 1;
        break;
      }
      if (input[cursor + 1] === '\n') {
        cursor += 2;
        continue;
      }
      const escaped = consumeCssEscapedCodePoint(input, cursor);
      value += escaped.value;
      cursor = escaped.next;
      continue;
    }
    value += ch;
    cursor += 1;
  }
  return {
    token: { type: 'string', value, raw: input.slice(quoteIndex, cursor) },
    next: cursor,
  };
}

function consumeBadCssUrlRemnants(input: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < input.length) {
    if (isValidCssEscape(input, cursor)) {
      cursor = consumeCssEscapedCodePoint(input, cursor).next;
    } else if (input[cursor] === ')') {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

function consumeCssUrlToken(
  input: string,
  afterOpenParenIndex: number,
  tokenStartIndex: number,
): { token: CssToken; next: number } {
  let cursor = afterOpenParenIndex;
  while (cursor < input.length && isCssWhitespace(input[cursor])) cursor += 1;
  let value = '';
  while (cursor < input.length) {
    const ch = input[cursor]!;
    const code = input.charCodeAt(cursor);
    if (ch === ')') {
      cursor += 1;
      return {
        token: { type: 'url', value, raw: input.slice(tokenStartIndex, cursor) },
        next: cursor,
      };
    }
    if (isCssWhitespace(ch)) {
      while (cursor < input.length && isCssWhitespace(input[cursor])) cursor += 1;
      if (cursor >= input.length) {
        return {
          token: { type: 'url', value, raw: input.slice(tokenStartIndex, cursor) },
          next: cursor,
        };
      }
      if (input[cursor] === ')') {
        cursor += 1;
        return {
          token: { type: 'url', value, raw: input.slice(tokenStartIndex, cursor) },
          next: cursor,
        };
      }
      cursor = consumeBadCssUrlRemnants(input, cursor);
      return {
        token: { type: 'bad-url', value: '', raw: input.slice(tokenStartIndex, cursor) },
        next: cursor,
      };
    }
    if (ch === '"' || ch === "'" || ch === '(' || isNonPrintableCssCode(code)) {
      cursor = consumeBadCssUrlRemnants(input, cursor + 1);
      return {
        token: { type: 'bad-url', value: '', raw: input.slice(tokenStartIndex, cursor) },
        next: cursor,
      };
    }
    if (ch === '\\') {
      if (isValidCssEscape(input, cursor)) {
        const escaped = consumeCssEscapedCodePoint(input, cursor);
        value += escaped.value;
        cursor = escaped.next;
        continue;
      }
      cursor = consumeBadCssUrlRemnants(input, cursor + 1);
      return {
        token: { type: 'bad-url', value: '', raw: input.slice(tokenStartIndex, cursor) },
        next: cursor,
      };
    }
    value += ch;
    cursor += 1;
  }
  return {
    token: { type: 'url', value, raw: input.slice(tokenStartIndex, cursor) },
    next: cursor,
  };
}

/**
 * Tokenizes CSS per W3C CSS Syntax Module Level 3 (§3.3 + §4) so escaped function names
 * (`\75 rl`), escaped at-keywords (`@\69 mport`), escaped URL schemes (`ht\74ps\3a //`),
 * string line continuations, and string vs. comment boundaries are normalized before
 * applying the EPUB resource allowlist.
 */
function tokenizeCss(rawInput: string): CssToken[] {
  const input = preprocessCssInput(rawInput);
  const tokens: CssToken[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const ch = input[cursor]!;
    if (ch === '/' && input[cursor + 1] === '*') {
      const closeIndex = input.indexOf('*/', cursor + 2);
      const next = closeIndex === -1 ? input.length : closeIndex + 2;
      tokens.push({ type: 'comment', value: '', raw: input.slice(cursor, next) });
      cursor = next;
      continue;
    }
    if (isCssWhitespace(ch)) {
      let next = cursor + 1;
      while (next < input.length && isCssWhitespace(input[next])) next += 1;
      const raw = input.slice(cursor, next);
      tokens.push({ type: 'whitespace', value: raw, raw });
      cursor = next;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const parsed = consumeCssStringToken(input, cursor);
      tokens.push(parsed.token);
      cursor = parsed.next;
      continue;
    }
    if (ch === '<' && input.startsWith('<!--', cursor)) {
      tokens.push({ type: 'cdo', value: '<!--', raw: '<!--' });
      cursor += 4;
      continue;
    }
    if (ch === '-' && input.startsWith('-->', cursor)) {
      tokens.push({ type: 'cdc', value: '-->', raw: '-->' });
      cursor += 3;
      continue;
    }
    if (ch === '@' && wouldStartCssIdent(input, cursor + 1)) {
      const ident = consumeCssIdentSequence(input, cursor + 1);
      tokens.push({
        type: 'at-keyword',
        value: ident.value,
        raw: input.slice(cursor, ident.next),
      });
      cursor = ident.next;
      continue;
    }
    if (wouldStartCssIdent(input, cursor)) {
      const ident = consumeCssIdentSequence(input, cursor);
      if (input[ident.next] === '(') {
        const afterParen = ident.next + 1;
        if (ident.value.toLowerCase() === 'url') {
          let peek = afterParen;
          while (peek < input.length && isCssWhitespace(input[peek])) peek += 1;
          const nextChar = input[peek];
          if (nextChar !== '"' && nextChar !== "'") {
            const urlResult = consumeCssUrlToken(input, afterParen, cursor);
            tokens.push(urlResult.token);
            cursor = urlResult.next;
            continue;
          }
        }
        tokens.push({
          type: 'function',
          value: ident.value,
          raw: input.slice(cursor, afterParen),
        });
        cursor = afterParen;
        continue;
      }
      tokens.push({ type: 'ident', value: ident.value, raw: input.slice(cursor, ident.next) });
      cursor = ident.next;
      continue;
    }
    if (ch === '#') {
      let next = cursor + 1;
      while (next < input.length) {
        if (isValidCssEscape(input, next)) {
          next = consumeCssEscapedCodePoint(input, next).next;
        } else if (isIdentCode(input.codePointAt(next)!)) {
          next += input.codePointAt(next)! > 0xffff ? 2 : 1;
        } else {
          break;
        }
      }
      const raw = input.slice(cursor, next);
      tokens.push({ type: 'other', value: raw, raw });
      cursor = next;
      continue;
    }
    const singleType: CssTokenType =
      ch === '('
        ? 'paren-open'
        : ch === ')'
          ? 'paren-close'
          : ch === '{'
            ? 'brace-open'
            : ch === '}'
              ? 'brace-close'
              : ch === ';'
                ? 'semicolon'
                : ch === ','
                  ? 'comma'
                  : 'other';
    tokens.push({ type: singleType, value: ch, raw: ch });
    cursor += 1;
  }

  return tokens;
}

function escapeCssString(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '\\' || character === '"') {
      escaped += `\\${character}`;
    } else if (code <= 0x1f || code === 0x7f) {
      escaped += `\\${code.toString(16)} `;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function isCssTrivia(token: CssToken | undefined): boolean {
  return token?.type === 'whitespace' || token?.type === 'comment';
}

function consumeBalancedParenTokens(
  tokens: readonly CssToken[],
  startIndex: number,
): { inner: CssToken[]; next: number } {
  let depth = 1;
  let cursor = startIndex;
  while (cursor < tokens.length) {
    const current = tokens[cursor]!;
    if (current.type === 'function' || current.type === 'paren-open') {
      depth += 1;
    } else if (current.type === 'paren-close') {
      depth -= 1;
      if (depth === 0) {
        return { inner: tokens.slice(startIndex, cursor), next: cursor + 1 };
      }
    }
    cursor += 1;
  }
  return { inner: tokens.slice(startIndex, cursor), next: cursor };
}

interface ParsedCssImport {
  target: string | null;
  mediaTokens: CssToken[];
  hasBlock: boolean;
  next: number;
}

function consumeCssImportStatement(tokens: readonly CssToken[], atIndex: number): ParsedCssImport {
  const prelude: CssToken[] = [];
  let cursor = atIndex + 1;
  let parenDepth = 0;
  let hasBlock = false;

  while (cursor < tokens.length) {
    const current = tokens[cursor]!;
    if (parenDepth === 0) {
      if (current.type === 'semicolon') {
        cursor += 1;
        break;
      }
      if (current.type === 'brace-close') {
        break;
      }
      if (current.type === 'brace-open') {
        hasBlock = true;
        let braceDepth = 1;
        cursor += 1;
        while (cursor < tokens.length && braceDepth > 0) {
          if (tokens[cursor]!.type === 'brace-open') braceDepth += 1;
          else if (tokens[cursor]!.type === 'brace-close') braceDepth -= 1;
          cursor += 1;
        }
        break;
      }
    }
    if (current.type === 'function' || current.type === 'paren-open') parenDepth += 1;
    else if (current.type === 'paren-close' && parenDepth > 0) parenDepth -= 1;
    prelude.push(current);
    cursor += 1;
  }

  if (hasBlock) {
    return { target: null, mediaTokens: [], hasBlock: true, next: cursor };
  }

  let p = 0;
  while (p < prelude.length && isCssTrivia(prelude[p])) p += 1;
  const first = prelude[p];
  let target: string;
  if (first?.type === 'string' || first?.type === 'url') {
    target = first.value;
    p += 1;
  } else if (first?.type === 'function' && first.value.toLowerCase() === 'url') {
    const balanced = consumeBalancedParenTokens(prelude, p + 1);
    const significant = balanced.inner.filter((token) => !isCssTrivia(token));
    if (significant.length === 1 && significant[0]?.type === 'string') {
      target = significant[0].value;
      p = balanced.next;
    } else {
      return { target: null, mediaTokens: [], hasBlock: false, next: cursor };
    }
  } else {
    return { target: null, mediaTokens: [], hasBlock: false, next: cursor };
  }

  while (p < prelude.length && isCssTrivia(prelude[p])) p += 1;
  const mediaTokens = prelude.slice(p);
  if (
    mediaTokens.some(
      (token) =>
        token.type === 'bad-string' || token.type === 'bad-url' || token.type === 'at-keyword',
    )
  ) {
    return { target: null, mediaTokens: [], hasBlock: false, next: cursor };
  }

  return { target, mediaTokens, hasBlock: false, next: cursor };
}

type CssResourceResolver = (reference: string) => string | null;

function defaultCssResourceResolver(
  reference: string,
  baseURI?: string | undefined,
): string | null {
  if (!isSafeEpubReference(reference, 'resource', baseURI)) return null;
  return decodedReference(reference);
}

function sanitizeImageSetTokens(
  fnName: string,
  innerTokens: readonly CssToken[],
  baseURI: string | undefined,
  resolveResource: CssResourceResolver,
): string {
  const groups: CssToken[][] = [];
  let current: CssToken[] = [];
  let depth = 0;
  for (const token of innerTokens) {
    if (depth === 0 && token.type === 'comma') {
      groups.push(current);
      current = [];
      continue;
    }
    if (token.type === 'function' || token.type === 'paren-open') depth += 1;
    else if (token.type === 'paren-close' && depth > 0) depth -= 1;
    current.push(token);
  }
  groups.push(current);

  const safeCandidates: string[] = [];
  for (const group of groups) {
    let idx = 0;
    while (idx < group.length && isCssTrivia(group[idx])) idx += 1;
    const head = group[idx];
    if (!head) continue;
    if (head.type === 'string') {
      const resolved = resolveResource(head.value);
      if (!resolved) continue;
      const rest = sanitizeCssTokens(group.slice(idx + 1), baseURI, resolveResource).trim();
      const normalizedUrl = `url("${escapeCssString(resolved)}")`;
      safeCandidates.push(rest ? `${normalizedUrl} ${rest}` : normalizedUrl);
      continue;
    }
    const sanitizedGroup = sanitizeCssTokens(group.slice(idx), baseURI, resolveResource).trim();
    if (!sanitizedGroup || /^none(?:\s|$)/i.test(sanitizedGroup)) continue;
    safeCandidates.push(sanitizedGroup);
  }

  return safeCandidates.length > 0 ? `${fnName}(${safeCandidates.join(', ')})` : 'none';
}

function sanitizeCssTokens(
  tokens: readonly CssToken[],
  baseURI: string | undefined,
  resolveResource: CssResourceResolver,
): string {
  let output = '';
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === 'comment' || token.type === 'cdo' || token.type === 'cdc') {
      output += ' ';
      index += 1;
      continue;
    }
    if (token.type === 'bad-url') {
      output += 'none';
      index += 1;
      continue;
    }
    if (token.type === 'bad-string') {
      output += '""';
      index += 1;
      continue;
    }
    if (token.type === 'string') {
      output += `"${escapeCssString(token.value)}"`;
      index += 1;
      continue;
    }
    if (token.type === 'url') {
      const resolved = resolveResource(token.value);
      output += resolved ? `url("${escapeCssString(resolved)}")` : 'none';
      index += 1;
      continue;
    }
    if (token.type === 'at-keyword' && token.value.toLowerCase() === 'import') {
      const parsed = consumeCssImportStatement(tokens, index);
      index = parsed.next;
      const safeImport =
        parsed.target !== null && isSafeEpubReference(parsed.target, 'stylesheet', baseURI)
          ? decodedReference(parsed.target)
          : null;
      if (safeImport) {
        const media = sanitizeCssTokens(parsed.mediaTokens, baseURI, resolveResource).trim();
        output += `@import "${escapeCssString(safeImport)}"${media ? ` ${media}` : ''};`;
      }
      continue;
    }
    if (token.type === 'function') {
      const fnName = token.value.toLowerCase();
      const balanced = consumeBalancedParenTokens(tokens, index + 1);
      index = balanced.next;
      if (fnName === 'url' || fnName === 'src') {
        const significant = balanced.inner.filter((entry) => !isCssTrivia(entry));
        if (significant.length === 1 && significant[0]?.type === 'string') {
          const resolved = resolveResource(significant[0].value);
          output += resolved ? `url("${escapeCssString(resolved)}")` : 'none';
        } else {
          output += 'none';
        }
        continue;
      }
      if (fnName === 'image-set' || fnName === '-webkit-image-set') {
        output += sanitizeImageSetTokens(fnName, balanced.inner, baseURI, resolveResource);
        continue;
      }
      if (fnName === 'expression') {
        output += 'none';
        continue;
      }
      const sanitizedInner = sanitizeCssTokens(balanced.inner, baseURI, resolveResource);
      output += `${token.raw}${sanitizedInner})`;
      continue;
    }
    output += token.raw;
    index += 1;
  }

  return output;
}

export function sanitizeCss(value: string, baseURI?: string | undefined): string {
  return sanitizeCssTokens(tokenizeCss(value), baseURI, (reference) =>
    defaultCssResourceResolver(reference, baseURI),
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

export type StylesheetCache = Map<string, Promise<string | null>>;
type StylesheetResolver = (href: string, document: Document) => Promise<string | null>;

const MAX_STYLESHEET_IMPORT_DEPTH = 4;
const MAX_STYLESHEET_IMPORT_COUNT = 16;

function rememberCachedStylesheet(
  key: string,
  loader: () => Promise<string | null>,
  cache: StylesheetCache,
): Promise<string | null> {
  const existing = cache.get(key);
  if (existing) return existing;
  const request = loader().catch(() => null);
  if (cache.size >= 32) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, request);
  return request.then((stylesheet) => {
    if (stylesheet === null && cache.get(key) === request) cache.delete(key);
    return stylesheet;
  });
}

async function loadLocalStylesheet(url: URL, cache: StylesheetCache): Promise<string | null> {
  const key = url.href;
  return rememberCachedStylesheet(
    key,
    () =>
      fetch(url).then(async (response) =>
        response.ok ? sanitizeCss(await response.text(), key) : null,
      ),
    cache,
  );
}

function relativeArchivePath(fromPath: string, toPath: string): string {
  const fromSegments = fromPath.split('/').slice(1, -1);
  const toSegments = toPath.split('/').slice(1);
  const toDirectories = toSegments.slice(0, -1);
  const filename = toSegments.at(-1) ?? '';
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toDirectories.length &&
    fromSegments[shared] === toDirectories[shared]
  ) {
    shared += 1;
  }
  const upward = Array.from({ length: fromSegments.length - shared }, () => '..');
  return [...upward, ...toDirectories.slice(shared), filename].filter(Boolean).join('/');
}

function resolveArchiveUrl(reference: string, basePath: string): URL | null {
  try {
    const base = new URL(basePath.startsWith('/') ? basePath : `/${basePath}`, EPUB_ARCHIVE_ORIGIN);
    const resolved = new URL(reference, base);
    return resolved.origin === EPUB_ARCHIVE_ORIGIN ? resolved : null;
  } catch {
    return null;
  }
}

interface ArchivedStylesheetOptions {
  baseURI?: string | undefined;
  lookupAssetUrl?: ((archivePathname: string) => string | undefined) | undefined;
  isAborted?: (() => boolean) | undefined;
}

function rewriteArchivedCssResource(
  reference: string,
  archive: EpubArchiveLike,
  stylesheetPath: string,
  sectionPath: string | null,
  options?: ArchivedStylesheetOptions | undefined,
): string | null {
  const baseURI = options?.baseURI;
  if (!isSafeEpubReference(reference, 'resource', baseURI)) return null;
  const decoded = decodedReference(reference);
  if (!decoded) return null;
  if (decoded.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return decoded;
  const assetUrl = resolveArchiveUrl(decoded, stylesheetPath);
  if (!assetUrl) return null;
  const cachedUrl =
    options?.lookupAssetUrl?.(assetUrl.pathname) ??
    archive.urlCache?.[assetUrl.pathname] ??
    archive.urlCache?.[assetUrl.pathname.slice(1)];
  if (cachedUrl !== undefined) {
    return isSafeEpubReference(cachedUrl, 'resource', baseURI) ? cachedUrl : null;
  }
  return sectionPath !== null ? relativeArchivePath(sectionPath, assetUrl.pathname) : null;
}

async function resolveArchivedStylesheet(
  archive: EpubArchiveLike,
  stylesheetPath: string,
  sectionPath: string | null,
  visited: ReadonlySet<string>,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_STYLESHEET_IMPORT_COUNT },
  options?: ArchivedStylesheetOptions | undefined,
): Promise<string | null> {
  if (depth > MAX_STYLESHEET_IMPORT_DEPTH || !archive.getText || options?.isAborted?.()) {
    return null;
  }
  let raw: string | undefined;
  try {
    raw = await archive.getText(stylesheetPath);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || options?.isAborted?.()) return null;

  const baseURI = options?.baseURI;
  const resolveResource: CssResourceResolver = (reference) =>
    rewriteArchivedCssResource(reference, archive, stylesheetPath, sectionPath, options);
  const tokens = tokenizeCss(raw);
  let output = '';
  let chunkStart = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === 'at-keyword' && token.value.toLowerCase() === 'import') {
      if (index > chunkStart) {
        output += sanitizeCssTokens(tokens.slice(chunkStart, index), baseURI, resolveResource);
      }
      const parsed = consumeCssImportStatement(tokens, index);
      index = parsed.next;
      chunkStart = index;

      const safeTarget =
        parsed.target !== null && isSafeEpubReference(parsed.target, 'stylesheet', baseURI)
          ? decodedReference(parsed.target)
          : null;
      const importedUrl = safeTarget ? resolveArchiveUrl(safeTarget, stylesheetPath) : null;
      if (
        importedUrl &&
        !visited.has(importedUrl.pathname) &&
        budget.remaining > 0 &&
        !options?.isAborted?.()
      ) {
        budget.remaining -= 1;
        const importedCss = await resolveArchivedStylesheet(
          archive,
          importedUrl.pathname,
          sectionPath,
          new Set([...visited, importedUrl.pathname]),
          depth + 1,
          budget,
          options,
        );
        if (options?.isAborted?.()) return null;
        if (importedCss) {
          const media = sanitizeCssTokens(parsed.mediaTokens, baseURI, resolveResource).trim();
          output += media ? `@media ${media} {\n${importedCss}\n}` : importedCss;
        }
      }
      continue;
    }
    index += 1;
  }

  if (chunkStart < tokens.length) {
    output += sanitizeCssTokens(tokens.slice(chunkStart), baseURI, resolveResource);
  }
  return output;
}

async function loadArchivedStylesheet(
  archive: EpubArchiveLike,
  stylesheetPath: string,
  sectionPath: string | null,
  cache: StylesheetCache,
  options?: ArchivedStylesheetOptions | undefined,
): Promise<string | null> {
  if (!archive.getText || options?.isAborted?.()) return null;
  const hasCachedUrls = Boolean(archive.urlCache && Object.keys(archive.urlCache).length > 0);
  const key = `archive:${hasCachedUrls ? 'cached' : 'rel'}:${sectionPath ?? 'blob'}->${stylesheetPath}`;
  return rememberCachedStylesheet(
    key,
    () =>
      resolveArchivedStylesheet(
        archive,
        stylesheetPath,
        sectionPath,
        new Set([stylesheetPath]),
        0,
        { remaining: MAX_STYLESHEET_IMPORT_COUNT },
        options,
      ),
    cache,
  );
}

function isStylesheetLink(element: Element): element is HTMLLinkElement {
  return (
    element.localName === 'link' &&
    (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')
  );
}

async function sanitizeStylesheets(
  document: Document,
  cache: StylesheetCache,
  resolveStylesheet?: StylesheetResolver | undefined,
): Promise<void> {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link')].filter(isStylesheetLink);
  await Promise.all(
    links.map(async (link) => {
      const href = link.getAttribute('href') ?? '';
      if (!href) {
        link.remove();
        return;
      }
      const placeholder = document.createComment('');
      link.replaceWith(placeholder);
      const embedded = decodeDataStylesheet(href);
      const stylesheet = embedded
        ? sanitizeCss(embedded, document.baseURI)
        : resolveStylesheet
          ? await resolveStylesheet(href, document)
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
  const existing = [...head.children].find(
    (element) =>
      element.localName === 'meta' &&
      element.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy' &&
      element.getAttribute('content') === EPUB_CONTENT_SECURITY_POLICY,
  );
  if (existing) {
    if (head.firstElementChild !== existing) head.prepend(existing);
    return;
  }
  const policy = createEpubElement(document, 'meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', EPUB_CONTENT_SECURITY_POLICY);
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

function stripReservedEpubStyleIds(document: Document): void {
  document.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
    if (element.id.startsWith(EPUBJS_THEME_STYLE_PREFIX)) {
      element.removeAttribute('id');
    }
  });
}

async function sanitizeStyleBlockCss(
  value: string,
  document: Document,
  resolveStylesheet?: StylesheetResolver | undefined,
): Promise<string> {
  if (!resolveStylesheet) {
    return sanitizeCss(value, document.baseURI);
  }
  const tokens = tokenizeCss(value);
  const resolveResource: CssResourceResolver = (reference) =>
    defaultCssResourceResolver(reference, document.baseURI);
  if (
    !tokens.some((token) => token.type === 'at-keyword' && token.value.toLowerCase() === 'import')
  ) {
    return sanitizeCssTokens(tokens, document.baseURI, resolveResource);
  }
  let output = '';
  let chunkStart = 0;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === 'at-keyword' && token.value.toLowerCase() === 'import') {
      if (index > chunkStart) {
        output += sanitizeCssTokens(
          tokens.slice(chunkStart, index),
          document.baseURI,
          resolveResource,
        );
      }
      const parsed = consumeCssImportStatement(tokens, index);
      index = parsed.next;
      chunkStart = index;
      const safeTarget =
        parsed.target !== null && isSafeEpubReference(parsed.target, 'stylesheet', document.baseURI)
          ? decodedReference(parsed.target)
          : null;
      if (safeTarget) {
        const embedded = decodeDataStylesheet(safeTarget);
        const importedCss = embedded
          ? sanitizeCss(embedded, document.baseURI)
          : await resolveStylesheet(safeTarget, document);
        if (importedCss) {
          const media = sanitizeCssTokens(
            parsed.mediaTokens,
            document.baseURI,
            resolveResource,
          ).trim();
          output += media ? `@media ${media} {\n${importedCss}\n}` : importedCss;
        }
      }
      continue;
    }
    index += 1;
  }
  if (chunkStart < tokens.length) {
    output += sanitizeCssTokens(tokens.slice(chunkStart), document.baseURI, resolveResource);
  }
  return output;
}

export async function sanitizeEpubDocument(
  document: Document,
  stylesheetCache: StylesheetCache = new Map(),
  resolveStylesheet?: StylesheetResolver | undefined,
): Promise<void> {
  let seenSafeBase = false;
  document.querySelectorAll('base').forEach((base) => {
    const href = base.getAttribute('href') ?? '';
    if (seenSafeBase || !isSafeBaseReference(href, document)) {
      base.remove();
      return;
    }
    seenSafeBase = true;
  });
  let seenPolicy = false;
  document
    .querySelectorAll('script, iframe, object, embed, form, meta[http-equiv]')
    .forEach((node) => {
      if (
        !seenPolicy &&
        node.localName === 'meta' &&
        node.parentElement?.localName === 'head' &&
        node.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy' &&
        node.getAttribute('content') === EPUB_CONTENT_SECURITY_POLICY
      ) {
        seenPolicy = true;
        return;
      }
      node.remove();
    });

  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      if (
        name.startsWith('on') ||
        localName.startsWith('on') ||
        name === 'ping' ||
        localName === 'ping'
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        name === 'srcset' ||
        localName === 'srcset' ||
        name === 'imagesrcset' ||
        localName === 'imagesrcset'
      ) {
        const safeSrcset = sanitizeSrcset(attribute.value, document.baseURI);
        if (safeSrcset) element.setAttribute(attribute.name, safeSrcset);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style' || localName === 'style') {
        const safeStyle = sanitizeCss(attribute.value, document.baseURI);
        if (safeStyle) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (element.localName === 'base' && (name === 'href' || localName === 'href')) continue;
      if (!RESOURCE_ATTRIBUTES.has(name) && !RESOURCE_ATTRIBUTES.has(localName)) continue;
      const isHref = name === 'href' || localName === 'href';
      const isStylesheet = isHref && isStylesheetLink(element);
      const kind =
        isHref && ['a', 'area'].includes(element.localName)
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

  const inlineStyles = [...document.querySelectorAll('style')];
  await Promise.all(
    inlineStyles.map(async (style) => {
      const currentStyle = style.textContent ?? '';
      if (style.id.startsWith(EPUBJS_THEME_STYLE_PREFIX) && !currentStyle.trim()) {
        return;
      }
      const safeStyle = await sanitizeStyleBlockCss(currentStyle, document, resolveStylesheet);
      if (safeStyle !== currentStyle) {
        style.textContent = safeStyle;
      }
    }),
  );
  await sanitizeStylesheets(document, stylesheetCache, resolveStylesheet);
  installEpubContentPolicy(document);
}

type AnySpineHookFn = (...hookArgs: unknown[]) => unknown;

function normalizeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error(fallbackMessage);
}

function toAsyncSafeSpineHookFn(
  task: AnySpineHookFn,
  wrappedMap: WeakMap<AnySpineHookFn, AnySpineHookFn>,
): AnySpineHookFn {
  const existing = wrappedMap.get(task);
  if (existing) return existing;
  const wrapped: AnySpineHookFn = function (this: unknown, ...hookArgs: unknown[]): unknown {
    try {
      return task.apply(this, hookArgs);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  wrappedMap.set(task, wrapped);
  wrappedMap.set(wrapped, wrapped);
  return wrapped;
}

export interface EpubSpineSanitizerOptions {
  isAborted?: (() => boolean) | undefined;
  onError?: ((error: Error) => void) | undefined;
  onInstalled?:
    | ((installation: { contentHook: EpubSpineContentHook; hookTask: AnySpineHookFn }) => void)
    | undefined;
  sanitizedDocuments?: WeakSet<Document> | undefined;
}

export function registerEpubSpineSanitizer(
  book: EpubBookLike,
  stylesheetCache: StylesheetCache = new Map(),
  options?: EpubSpineSanitizerOptions | undefined,
): boolean {
  const contentHook = book.spine?.hooks?.content;
  if (
    !contentHook ||
    typeof contentHook !== 'object' ||
    typeof contentHook.register !== 'function'
  ) {
    options?.onError?.(new Error('EPUB spine content sanitizer hook is unavailable.'));
    return false;
  }
  if (contentHook.trigger !== undefined && typeof contentHook.trigger !== 'function') {
    options?.onError?.(new Error('EPUB spine content trigger hook is invalid.'));
    return false;
  }

  const sanitizedDocuments = options?.sanitizedDocuments ?? new WeakSet<Document>();
  const wrappedTasks = new WeakMap<AnySpineHookFn, AnySpineHookFn>();

  const sanitizeSpineContent = async (document: Document, section: SpineSection): Promise<void> => {
    stripReservedEpubStyleIds(document);
    await sanitizeEpubDocument(document, stylesheetCache, async (href, currentDocument) => {
      if (options?.isAborted?.()) return null;
      if (href.toLowerCase().startsWith('blob:')) {
        return isSameOriginBlobUrl(href, currentDocument.baseURI)
          ? loadLocalStylesheet(new URL(href), stylesheetCache)
          : null;
      }
      const sectionPath = section.url ?? section.href;
      if (book.archive?.getText && sectionPath) {
        const sectionUrl = resolveArchiveUrl(sectionPath, '/');
        const stylesheetUrl = sectionUrl ? resolveArchiveUrl(href, sectionUrl.pathname) : null;
        if (!stylesheetUrl) return null;
        return loadArchivedStylesheet(
          book.archive,
          stylesheetUrl.pathname,
          sectionUrl!.pathname,
          stylesheetCache,
          { baseURI: currentDocument.baseURI, isAborted: options?.isAborted },
        );
      }
      if (book.archived) {
        return null;
      }
      if (isLocalContentUrl(href, currentDocument)) {
        return loadLocalStylesheet(new URL(href, currentDocument.baseURI), stylesheetCache);
      }
      return null;
    });
    if (!options?.isAborted?.()) {
      sanitizedDocuments.add(document);
    }
  };

  const wrappedSanitize = toAsyncSafeSpineHookFn(
    sanitizeSpineContent as AnySpineHookFn,
    wrappedTasks,
  );
  const originalRegister = contentHook.register;

  try {
    if (typeof contentHook.list === 'function') {
      const existingHooks = contentHook.list();
      if (Array.isArray(existingHooks)) {
        for (let index = 0; index < existingHooks.length; index += 1) {
          const entry = existingHooks[index];
          if (typeof entry === 'function') {
            existingHooks[index] = toAsyncSafeSpineHookFn(entry as AnySpineHookFn, wrappedTasks);
          }
        }
      }
    }
    originalRegister.call(
      contentHook,
      wrappedSanitize as (document: Document, section: SpineSection) => Promise<void>,
    );
    if (typeof contentHook.list === 'function') {
      const registered = contentHook.list();
      if (!Array.isArray(registered) || !registered.includes(wrappedSanitize)) {
        options?.onError?.(new Error('EPUB spine content sanitizer hook failed to register.'));
        return false;
      }
    }
  } catch (error) {
    options?.onError?.(
      normalizeError(error, 'EPUB spine content sanitizer hook registration failed.'),
    );
    return false;
  }

  contentHook.register = function (this: unknown, ...entries: unknown[]): void {
    const wrappedEntries = entries.map((entry) => {
      if (typeof entry === 'function') {
        return toAsyncSafeSpineHookFn(entry as AnySpineHookFn, wrappedTasks);
      }
      if (Array.isArray(entry)) {
        return entry.map((nested) =>
          typeof nested === 'function'
            ? toAsyncSafeSpineHookFn(nested as AnySpineHookFn, wrappedTasks)
            : nested,
        );
      }
      return entry;
    });
    (originalRegister as (...registerArgs: unknown[]) => void).apply(this, wrappedEntries);
  } as EpubSpineContentHook['register'];

  if (typeof contentHook.deregister === 'function') {
    const originalDeregister = contentHook.deregister;
    contentHook.deregister = function (this: unknown, fn: AnySpineHookFn): void {
      if (fn === (sanitizeSpineContent as AnySpineHookFn) || fn === wrappedSanitize) {
        return;
      }
      originalDeregister.call(this, wrappedTasks.get(fn) ?? fn);
    };
  }

  if (typeof contentHook.trigger === 'function') {
    const originalTrigger = contentHook.trigger;
    contentHook.trigger = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      try {
        if (typeof contentHook.list === 'function') {
          const registered = contentHook.list();
          if (!Array.isArray(registered) || !registered.includes(wrappedSanitize)) {
            throw new Error('EPUB spine content sanitizer hook was removed before render.');
          }
        }
        const result = await originalTrigger.apply(this, args);
        const doc = args[0];
        if (
          doc &&
          typeof doc === 'object' &&
          !options?.isAborted?.() &&
          !sanitizedDocuments.has(doc as Document)
        ) {
          throw new Error('EPUB spine content sanitizer did not complete before serialization.');
        }
        return result;
      } catch (error) {
        const normalized = normalizeError(error, 'EPUB spine content sanitizer failed.');
        options?.onError?.(normalized);
        throw normalized;
      }
    };
  }

  options?.onInstalled?.({ contentHook, hookTask: wrappedSanitize });
  return true;
}

const interceptedBookProperties = new WeakMap<object, Map<string, (value: unknown) => void>>();

function interceptBookProperty(
  book: object,
  property: 'archive' | 'resources' | 'spine',
  onAssign: (value: unknown) => void,
): boolean {
  let handlers = interceptedBookProperties.get(book);
  if (handlers?.has(property)) {
    handlers.set(property, onAssign);
    onAssign((book as Record<string, unknown>)[property]);
    return true;
  }
  if (!handlers) {
    handlers = new Map();
    interceptedBookProperties.set(book, handlers);
  }
  handlers.set(property, onAssign);
  let currentValue = (book as Record<string, unknown>)[property];
  if (currentValue !== undefined) onAssign(currentValue);
  try {
    Object.defineProperty(book, property, {
      configurable: true,
      enumerable: true,
      get: () => currentValue,
      set: (nextValue: unknown) => {
        currentValue = nextValue;
        handlers?.get(property)?.(nextValue);
      },
    });
    return true;
  } catch {
    return false;
  }
}

export class ReaderSession {
  private readonly book;
  private readonly stylesheetCache: StylesheetCache = new Map();
  private readonly createdBlobUrls = new Set<string>();
  private readonly authorStyleMedia = new WeakMap<Element, string | null>();
  private readonly authorInlineStyles = new WeakMap<Element, string>();
  private readonly sanitizedDocuments = new WeakSet<Document>();
  private readonly patchedSpineHooks = new WeakMap<object, AnySpineHookFn>();
  private readonly patchedSections = new WeakSet<object>();
  private installedSpineContentHook: EpubSpineContentHook | null = null;
  private installedSpineHookTask: AnySpineHookFn | null = null;
  private spineSanitizerError: Error | null = null;
  private rejectSpineSanitizerFailed: ((error: Error) => void) | null = null;
  private readonly spineSanitizerFailedPromise: Promise<never>;
  private destroyed = false;
  private bookDestroyed = false;
  private resolveDestroyed: (() => void) | null = null;
  private readonly destroyedPromise = new Promise<void>((resolve) => {
    this.resolveDestroyed = resolve;
  });
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
    this.spineSanitizerFailedPromise = new Promise<never>((_, reject) => {
      this.rejectSpineSanitizerFailed = reject;
    });
    this.spineSanitizerFailedPromise.catch(() => {});

    this.book = ePub(bookUrl);
    const book = this.book as unknown as EpubBookLike & object;
    interceptBookProperty(book, 'archive', (archive) => {
      this.installArchiveUrlTracker(archive);
    });
    interceptBookProperty(book, 'resources', (resources) => {
      this.installResourceCssSanitizer(resources);
    });
    void book.loaded?.resources?.then(
      (loadedResources) => {
        this.installResourceCssSanitizer(loadedResources ?? book.resources);
      },
      () => {},
    );
    const bookWithReplacements = book as {
      replacements?: () => Promise<unknown>;
      spine?: {
        hooks?: {
          serialize?: {
            register?: (
              fn: (output: string, section: { output?: string; url?: string }) => void,
            ) => void;
          };
        };
      };
      resources?: EpubResourcesLike & { replacements?: () => Promise<unknown> };
    };
    if (typeof bookWithReplacements.replacements === 'function') {
      bookWithReplacements.replacements = async () => {
        if (this.destroyed || this.spineSanitizerError || !bookWithReplacements.resources) {
          return [];
        }
        bookWithReplacements.spine?.hooks?.serialize?.register?.((output, section) => {
          if (
            this.destroyed ||
            this.spineSanitizerError ||
            typeof bookWithReplacements.resources?.substitute !== 'function'
          ) {
            return;
          }
          section.output = bookWithReplacements.resources.substitute(output, section.url ?? '');
        });
        if (typeof bookWithReplacements.resources.replacements === 'function') {
          await bookWithReplacements.resources.replacements();
        }
        if (
          this.destroyed ||
          this.spineSanitizerError ||
          typeof bookWithReplacements.resources?.replaceCss !== 'function'
        ) {
          return [];
        }
        return bookWithReplacements.resources.replaceCss();
      };
    }

    this.installSpineSanitizer(book);
    interceptBookProperty(book, 'spine', () => {
      if (this.destroyed) return;
      this.installSpineSanitizer(book);
    });
    void book.loaded?.spine?.then(
      () => {
        if (this.destroyed) return;
        this.installSpineSanitizer(book);
      },
      () => {},
    );
  }

  private recordSpineSanitizerFailure(error: unknown, abortImmediately: boolean): Error {
    const normalized = normalizeError(
      error,
      'EPUB spine content sanitizer hook could not be installed.',
    );
    this.spineSanitizerError ??= normalized;
    this.rejectSpineSanitizerFailed?.(this.spineSanitizerError);
    if (abortImmediately) {
      this.destroy();
    }
    return this.spineSanitizerError;
  }

  private installSpineSanitizerOnBookTarget(targetBook: EpubBookLike): {
    contentHook: EpubSpineContentHook;
    hookTask: AnySpineHookFn;
  } | null {
    const contentHook = targetBook.spine?.hooks?.content;
    if (contentHook && typeof contentHook === 'object') {
      const existingTask = this.patchedSpineHooks.get(contentHook);
      if (existingTask) {
        if (typeof contentHook.list === 'function') {
          const registered = contentHook.list();
          if (!Array.isArray(registered) || !registered.includes(existingTask)) {
            this.recordSpineSanitizerFailure(
              new Error('EPUB spine content sanitizer hook was cleared before render.'),
              true,
            );
            return null;
          }
        }
        return { contentHook, hookTask: existingTask };
      }
    }

    let installed: { contentHook: EpubSpineContentHook; hookTask: AnySpineHookFn } | null = null;
    const registered = registerEpubSpineSanitizer(targetBook, this.stylesheetCache, {
      isAborted: () => this.destroyed && this.spineSanitizerError === null,
      sanitizedDocuments: this.sanitizedDocuments,
      onError: (error) => {
        this.recordSpineSanitizerFailure(error, false);
      },
      onInstalled: (record) => {
        installed = record;
        this.patchedSpineHooks.set(record.contentHook, record.hookTask);
      },
    });
    if (!registered || !installed) {
      this.recordSpineSanitizerFailure(
        this.spineSanitizerError ??
          new Error('EPUB spine content sanitizer hook could not be installed.'),
        true,
      );
      return null;
    }
    return installed;
  }

  private installSpineSanitizer(book: EpubBookLike): void {
    const installed = this.installSpineSanitizerOnBookTarget(book);
    if (!installed) return;
    this.installedSpineContentHook = installed.contentHook;
    this.installedSpineHookTask = installed.hookTask;
  }

  private guardSpineSections(book: EpubBookLike, explicitSections?: SpineSection[]): void {
    const sections: SpineSection[] = explicitSections
      ? [...explicitSections]
      : Array.isArray(book.spine?.spineItems)
        ? [...book.spine.spineItems]
        : this.spine
          ? [...this.spine.sections]
          : [];

    for (const section of sections) {
      if (!section || typeof section !== 'object') continue;
      if ('hooks' in section) {
        const sectionHook = section.hooks?.content;
        if (
          !sectionHook ||
          typeof sectionHook !== 'object' ||
          typeof sectionHook.register !== 'function' ||
          typeof sectionHook.trigger !== 'function'
        ) {
          throw this.recordSpineSanitizerFailure(
            new Error('EPUB section content sanitizer hook is unavailable.'),
            false,
          );
        }
        if (sectionHook !== this.installedSpineContentHook) {
          const sectionInstalled = this.installSpineSanitizerOnBookTarget({
            archived: book.archived,
            archive: book.archive,
            spine: { hooks: section.hooks },
          });
          if (!sectionInstalled) {
            throw (
              this.spineSanitizerError ??
              new Error('EPUB section content sanitizer hook could not be installed.')
            );
          }
        }
      }

      if (typeof section.load === 'function' && !this.patchedSections.has(section)) {
        this.patchedSections.add(section);
        const originalLoad = section.load;
        section.load = async (request) => {
          this.assertSpineSanitizerReady();
          const loaded = await originalLoad.call(section, request);
          const sectionDoc = section.document;
          const abortedCleanly = this.destroyed && this.spineSanitizerError === null;
          if (
            !abortedCleanly &&
            (sectionDoc !== undefined || 'hooks' in section) &&
            (!sectionDoc || !this.sanitizedDocuments.has(sectionDoc))
          ) {
            throw this.recordSpineSanitizerFailure(
              new Error('EPUB chapter was not sanitized before serialization.'),
              false,
            );
          }
          return loaded;
        };
      }
    }
  }

  private assertSpineSanitizerReady(): void {
    if (this.spineSanitizerError) {
      throw this.spineSanitizerError;
    }
    const book = this.book as unknown as EpubBookLike;
    const contentHook = book.spine?.hooks?.content;
    if (
      !contentHook ||
      typeof contentHook !== 'object' ||
      contentHook !== this.installedSpineContentHook ||
      typeof contentHook.register !== 'function' ||
      (contentHook.trigger !== undefined && typeof contentHook.trigger !== 'function')
    ) {
      throw this.recordSpineSanitizerFailure(
        new Error('EPUB spine content sanitizer hook is unavailable.'),
        false,
      );
    }
    if (typeof contentHook.list === 'function') {
      const registered = contentHook.list();
      if (
        !Array.isArray(registered) ||
        !this.installedSpineHookTask ||
        !registered.includes(this.installedSpineHookTask)
      ) {
        throw this.recordSpineSanitizerFailure(
          new Error('EPUB spine content sanitizer hook was removed before render.'),
          false,
        );
      }
    }
    this.guardSpineSections(book);
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
    try {
      this.assertSpineSanitizerReady();
      if (this.destroyed) return;
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
      await Promise.race([
        this.rendition.started,
        this.destroyedPromise,
        this.spineSanitizerFailedPromise,
      ]);
      if (this.spineSanitizerError) throw this.spineSanitizerError;
      if (this.destroyed) return;
      this.assertSpineSanitizerReady();
      this.bindEpubContainer();
      if (!this.isCurrentLocationOperation(restoreGeneration)) return;
      if (cfi) {
        try {
          if (await this.displayAtGeneration(cfi, restoreGeneration)) return;
        } catch (error) {
          if (this.spineSanitizerError) throw this.spineSanitizerError;
          void error;
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
    } catch (error) {
      this.destroy();
      throw error;
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
    this.assertSpineSanitizerReady();
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
      if (this.spineSanitizerError) throw this.spineSanitizerError;
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
    this.resolveDestroyed?.();
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
    const book = this.book as unknown as EpubBookLike;
    const replacementList = Array.isArray(book.resources?.replacementUrls)
      ? (book.resources.replacementUrls as Array<string | undefined>)
      : [];
    const urls = new Set([
      ...Object.values(book.archive?.urlCache ?? {}),
      ...replacementList,
      ...this.createdBlobUrls,
    ]);
    this.createdBlobUrls.clear();
    for (const url of urls) {
      if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    if (!this.bookDestroyed) {
      this.bookDestroyed = true;
      const destroyedBook = this.book as unknown as {
        loaded?: unknown;
        loading?: unknown;
        opening?: unknown;
        openContainer?: () => Promise<string>;
        openPackaging?: () => Promise<void>;
        unpack?: () => void;
        replacements?: () => Promise<unknown[]>;
      };
      destroyedBook.openContainer = async () => '';
      destroyedBook.openPackaging = async () => {};
      destroyedBook.unpack = () => {};
      destroyedBook.replacements = async () => [];
      try {
        this.book.destroy();
      } catch {
        // Malformed epub.js books with missing spine hooks can throw inside Spine.destroy().
      }
      const noopDeferred = {
        resolve: () => {},
        reject: () => {},
        promise: Promise.resolve(),
      };
      destroyedBook.loaded ??= {
        manifest: Promise.resolve(),
        spine: Promise.resolve(),
        metadata: Promise.resolve(),
        cover: Promise.resolve(),
        navigation: Promise.resolve(),
        pageList: Promise.resolve(),
        resources: Promise.resolve(),
        displayOptions: Promise.resolve(),
      };
      destroyedBook.loading ??= {
        manifest: noopDeferred,
        spine: noopDeferred,
        metadata: noopDeferred,
        cover: noopDeferred,
        navigation: noopDeferred,
        pageList: noopDeferred,
        resources: noopDeferred,
        displayOptions: noopDeferred,
      };
      destroyedBook.opening = noopDeferred;
    }
  }

  private async prepareContents(contents: Contents): Promise<void> {
    await this.harden(contents);
    this.registerContentFocusAndLinks(contents);
    this.syncVisibleColumnLinks();
  }

  private async harden(contents: Contents): Promise<void> {
    if (this.destroyed) return;
    await sanitizeEpubDocument(contents.document, this.stylesheetCache);
    if (this.destroyed) return;
    const publisherStyles = this.appearance?.publisherStyles !== false;
    this.syncPublisherStyles(contents.document, publisherStyles);
    if (!publisherStyles) {
      (contents as unknown as { expand?: () => void }).expand?.();
    }
  }

  private readonly patchedArchives = new WeakSet<object>();
  private readonly patchedResources = new WeakSet<object>();

  private trackCreatedBlobUrl(url: unknown, onRevoked?: () => void): string | null {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return null;
    if (this.destroyed) {
      URL.revokeObjectURL(url);
      this.createdBlobUrls.delete(url);
      this.stylesheetCache.delete(url);
      onRevoked?.();
      return null;
    }
    this.createdBlobUrls.add(url);
    return url;
  }

  private installArchiveUrlTracker(target: unknown): void {
    const archive = target as EpubArchiveLike | null;
    if (!archive || typeof archive !== 'object' || this.patchedArchives.has(archive)) return;
    this.patchedArchives.add(archive);
    const originalCreateUrl = archive.createUrl;
    if (typeof originalCreateUrl !== 'function') return;
    archive.createUrl = async (url: string, options?: { base64?: boolean | undefined }) => {
      if (this.destroyed) return '';
      const created = await originalCreateUrl.call(archive, url, options);
      if (typeof created === 'string' && created.startsWith('blob:')) {
        const tracked = this.trackCreatedBlobUrl(created, () => {
          if (archive.urlCache && archive.urlCache[url] === created) {
            delete archive.urlCache[url];
          }
        });
        if (!tracked) return '';
      }
      return created;
    };
  }

  private installResourceCssSanitizer(target: unknown): void {
    const resources = target as EpubResourcesLike | null;
    if (!resources || typeof resources !== 'object' || this.patchedResources.has(resources)) return;
    this.patchedResources.add(resources);

    if (resources.settings?.archive) {
      this.installArchiveUrlTracker(resources.settings.archive);
    }

    const baseOrigin = (): string | undefined =>
      typeof window !== 'undefined' && window.location?.href ? window.location.href : undefined;

    const revokeBlobUrl = (url: unknown, archiveCache?: Record<string, string>): void => {
      if (typeof url !== 'string' || !url.startsWith('blob:')) return;
      URL.revokeObjectURL(url);
      this.createdBlobUrls.delete(url);
      this.stylesheetCache.delete(url);
      if (archiveCache) {
        for (const [cacheKey, cachedUrl] of Object.entries(archiveCache)) {
          if (cachedUrl === url) delete archiveCache[cacheKey];
        }
      }
    };

    const purgeRawCssUrls = (archiveOverride?: unknown): void => {
      const archiveCache = (
        (archiveOverride as EpubArchiveLike | undefined) ?? resources.settings?.archive
      )?.urlCache;
      const cssSet = Array.isArray(resources.cssUrls)
        ? new Set(resources.cssUrls.filter((entry): entry is string => typeof entry === 'string'))
        : null;
      if (Array.isArray(resources.urls) && Array.isArray(resources.replacementUrls)) {
        const replacementList = resources.replacementUrls as Array<string | undefined>;
        resources.urls.forEach((href, index) => {
          const isCssEntry =
            typeof href === 'string' && (cssSet ? cssSet.has(href) : /\.css(?:[?#]|$)/i.test(href));
          if (isCssEntry || cssSet === null) {
            revokeBlobUrl(replacementList[index], archiveCache);
            replacementList[index] = '';
          }
        });
      } else if (Array.isArray(resources.replacementUrls)) {
        const replacementList = resources.replacementUrls as Array<string | undefined>;
        for (let i = 0; i < replacementList.length; i += 1) {
          revokeBlobUrl(replacementList[i], archiveCache);
          replacementList[i] = '';
        }
      }
      if (archiveCache) {
        for (const [cacheKey, cachedUrl] of Object.entries(archiveCache)) {
          if (/\.css(?:[?#]|$)/i.test(cacheKey)) {
            revokeBlobUrl(cachedUrl, archiveCache);
          }
        }
      }
    };

    const originalResourceCreateUrl = resources.createUrl;
    if (typeof originalResourceCreateUrl === 'function') {
      resources.createUrl = async (url: string) => {
        if (this.destroyed) return '';
        const isCssResource =
          typeof url === 'string' &&
          (/\.css(?:[?#]|$)/i.test(url) ||
            (Array.isArray(resources.cssUrls) &&
              typeof resources.settings?.resolver === 'function' &&
              resources.cssUrls.some(
                (href) => typeof href === 'string' && resources.settings?.resolver?.(href) === url,
              )));
        if (isCssResource) return '';
        const created = await originalResourceCreateUrl.call(resources, url);
        if (typeof created === 'string' && created.startsWith('blob:')) {
          const tracked = this.trackCreatedBlobUrl(created);
          if (!tracked) return '';
        }
        return created;
      };
    }

    const mintCssUrl = (sanitized: string): string | undefined => {
      if (this.destroyed) return undefined;
      if (resources.settings?.replacements === 'base64') {
        return `data:text/css;charset=utf-8,${encodeURIComponent(sanitized)}`;
      }
      const sanitizedUrl = URL.createObjectURL(new Blob([sanitized], { type: 'text/css' }));
      if (!this.trackCreatedBlobUrl(sanitizedUrl)) return undefined;
      this.stylesheetCache.set(sanitizedUrl, Promise.resolve(sanitized));
      return sanitizedUrl;
    };

    const buildManifestAssetLookup = (
      resolveHref: (path: string) => string,
    ): ((archivePathname: string) => string | undefined) | undefined => {
      if (!Array.isArray(resources.urls) || !Array.isArray(resources.replacementUrls)) {
        return undefined;
      }
      const cssSet = new Set(
        Array.isArray(resources.cssUrls)
          ? resources.cssUrls.filter((entry): entry is string => typeof entry === 'string')
          : [],
      );
      const map = new Map<string, string>();
      const replacementList = resources.replacementUrls as Array<string | undefined>;
      resources.urls.forEach((assetHref, index) => {
        if (typeof assetHref !== 'string' || cssSet.has(assetHref)) return;
        const replacement = replacementList[index];
        if (typeof replacement !== 'string' || !replacement) return;
        try {
          const resolved = resolveHref(assetHref);
          const normalized = resolveArchiveUrl(resolved, '/');
          if (normalized) map.set(normalized.pathname, replacement);
        } catch {
          // Ignore malformed manifest entries.
        }
      });
      return (pathname: string) => map.get(pathname);
    };

    const loadSanitizedResourceCss = async (
      href: string,
      archiveOverride?: unknown,
      resolverOverride?: unknown,
    ): Promise<string | null> => {
      if (
        this.destroyed ||
        typeof href !== 'string' ||
        !href ||
        !isSafeEpubReference(href, 'stylesheet', baseOrigin())
      ) {
        return null;
      }
      const resolveHref =
        (typeof resolverOverride === 'function'
          ? (resolverOverride as (path: string) => string)
          : undefined) ?? resources.settings?.resolver;
      if (typeof resolveHref !== 'function') return null;

      let absolute: string;
      try {
        absolute = resolveHref(href);
      } catch {
        return null;
      }
      if (typeof absolute !== 'string' || !absolute) return null;

      const archiveSource =
        (archiveOverride as EpubArchiveLike | undefined) ?? resources.settings?.archive;
      if (archiveSource && typeof archiveSource.getText === 'function') {
        const archiveUrl = resolveArchiveUrl(absolute, '/');
        if (!archiveUrl) return null;
        return loadArchivedStylesheet(
          archiveSource,
          archiveUrl.pathname,
          null,
          this.stylesheetCache,
          {
            baseURI: baseOrigin(),
            lookupAssetUrl: buildManifestAssetLookup(resolveHref),
            isAborted: () => this.destroyed,
          },
        );
      }

      if (typeof resources.settings?.request !== 'function') return null;
      if (typeof resources.substitute !== 'function') return null;
      const substituteFn = resources.substitute.bind(resources);
      return rememberCachedStylesheet(
        `resource:${absolute}`,
        async () => {
          if (this.destroyed) return null;
          const response = resources.settings?.request?.(absolute, 'text');
          if (!response) return null;
          const rawText = await response;
          if (this.destroyed || typeof rawText !== 'string') return null;
          const substituted = substituteFn(rawText, absolute);
          return sanitizeCss(substituted, baseOrigin());
        },
        this.stylesheetCache,
      );
    };

    resources.createCssFile = async (href: string, archive?: unknown, resolver?: unknown) => {
      const sanitized = await loadSanitizedResourceCss(href, archive, resolver);
      if (sanitized === null || this.destroyed) return undefined;
      return mintCssUrl(sanitized);
    };

    resources.replaceCss = async (archive?: unknown, resolver?: unknown) => {
      purgeRawCssUrls(archive);
      if (
        this.destroyed ||
        !Array.isArray(resources.cssUrls) ||
        !Array.isArray(resources.urls) ||
        !Array.isArray(resources.replacementUrls)
      ) {
        return [];
      }
      if (!resources.cssUrls.every((entry) => typeof entry === 'string')) {
        return [];
      }
      const urls = resources.urls;
      const replacementUrls = resources.replacementUrls as Array<string | undefined>;
      const cssUrls = resources.cssUrls as string[];

      const loaded = await Promise.all(
        cssUrls.map(async (href) => ({
          indexInUrls: urls.indexOf(href),
          sanitized: await loadSanitizedResourceCss(href, archive, resolver),
        })),
      );
      if (this.destroyed) return [];

      for (const { indexInUrls, sanitized } of loaded) {
        if (indexInUrls < 0) continue;
        if (sanitized === null) {
          replacementUrls[indexInUrls] = '';
          continue;
        }
        replacementUrls[indexInUrls] = mintCssUrl(sanitized) ?? '';
      }
      return replacementUrls;
    };
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
    this.assertSpineSanitizerReady();
    this.displayOperationCount += 1;
    const rendition = this.rendition;
    let onDisplayError: ((error: unknown) => void) | null = null;
    const displayErrorPromise = new Promise<never>((_, reject) => {
      onDisplayError = (error: unknown) => {
        reject(normalizeError(error, 'EPUB chapter display failed.'));
      };
    });
    displayErrorPromise.catch(() => {});
    if (rendition?.on && onDisplayError) {
      rendition.on('displayerror', onDisplayError);
    }
    try {
      const result = await Promise.race([
        operation(),
        displayErrorPromise,
        this.spineSanitizerFailedPromise,
        this.destroyedPromise.then(() => undefined as T),
      ]);
      if (this.spineSanitizerError) throw this.spineSanitizerError;
      return result;
    } finally {
      if (rendition?.off && onDisplayError) {
        rendition.off('displayerror', onDisplayError);
      }
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
      if (this.spineSanitizerError) throw this.spineSanitizerError;
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
      if (this.spineSanitizerError) throw this.spineSanitizerError;
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
    this.guardSpineSections(this.book as unknown as EpubBookLike, sections);
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
