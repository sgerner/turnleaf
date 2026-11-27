import ePub, { type EpubCFI as EpubCfiInstance, type Rendition } from 'epubjs';

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

export type ReaderCfiDisplayStatus = 'displayed' | 'missing' | 'aborted';

export type ReaderAnnotationDisplayResult =
  | { status: 'displayed'; cfi: string; href: string }
  | { status: 'repaired'; cfi: string; href: string }
  | { status: 'missing' }
  | { status: 'aborted' };

export interface SpineSectionLike {
  id?: string | null;
  idref?: string | null;
  cfiBase?: string;
  href: string;
  index: number;
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

export interface RuntimeParsedCfi {
  spinePos: number;
  range: boolean;
  base: RuntimeCfiComponent;
  path: RuntimeCfiComponent;
  start: RuntimeCfiComponent | null;
  end: RuntimeCfiComponent | null;
}

export interface EpubCfiConstructor {
  new (
    cfiFrom?: string | Range | Node,
    base?: string | object,
    ignoreClass?: string,
  ): EpubCfiInstance;
}

export interface RenderedViewContents {
  document: Document;
  sectionIndex?: number;
  cfiBase?: string;
  range: (cfi: string, ignoreClass?: string) => Range | null;
  cfiFromRange: (range: Range, ignoreClass?: string) => string;
}

export interface RenderedEpubView {
  index: number;
  displayed?: boolean;
  section?: { href: string; index: number; cfiBase?: string };
  contents?: RenderedViewContents;
}

interface TextMapPosition {
  node: Text;
  offset: number;
}

export interface DocumentTextMap {
  text: string;
  lowerText: string;
  starts: TextMapPosition[];
  ends: TextMapPosition[];
}

export interface ClaimedTextSpan {
  start: number;
  end: number;
}

export interface ExcerptMatchResult {
  range: Range;
  score: number;
  candidateCount: number;
  unambiguous: boolean;
}

interface ResolvedCfiEndpoint {
  node: Node;
  offset: number;
  clamped: boolean;
  elementOnly: boolean;
  relocatedById: boolean;
}

const SELECTION_CONTEXT_CHARS = 64;
export const MAX_STORED_EXCERPT_LENGTH = 500;
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

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeSpineHref(href: string): string {
  return href.split('#', 1)[0]?.trim() ?? '';
}

export function getEpubCfiConstructor(rendition?: Rendition | null): EpubCfiConstructor | null {
  const fromModule = (ePub as unknown as { CFI?: EpubCfiConstructor }).CFI;
  if (typeof fromModule === 'function') return fromModule;
  const fromRendition = (rendition as unknown as { epubcfi?: { constructor?: EpubCfiConstructor } })
    ?.epubcfi?.constructor;
  return typeof fromRendition === 'function' ? fromRendition : null;
}

export function parseRuntimeCfi(
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

function canEpubCfiResolveInDocument(
  doc: Document,
  cfi: string,
  CfiClass: EpubCfiConstructor,
): boolean {
  try {
    const instance = new CfiClass(cfi) as unknown as {
      toRange?: (targetDoc: Document) => Range | null;
    };
    return typeof instance.toRange === 'function' ? Boolean(instance.toRange(doc)) : true;
  } catch {
    return false;
  }
}

function resolveCfiStepsInDocument(
  doc: Document,
  steps: Array<RuntimeCfiStep | undefined>,
  terminalOffset: number | null,
): ResolvedCfiEndpoint | null {
  const root = doc.documentElement;
  if (!root || steps.length === 0) return null;
  let current: Node | null = root;
  let relocatedById = false;

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
          relocatedById = true;
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
      relocatedById,
    };
  }

  if (terminalOffset === null) {
    return { node: current, offset: 0, clamped: false, elementOnly: true, relocatedById };
  }
  const clampedOffset = Math.max(0, Math.min(terminalOffset, current.childNodes.length));
  return {
    node: current,
    offset: clampedOffset,
    clamped: clampedOffset !== terminalOffset,
    elementOnly: false,
    relocatedById,
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

export function validateAndClampReadingCfi(
  doc: Document,
  parsed: RuntimeParsedCfi,
  originalCfi: string,
  cfiBase: string | undefined,
  sectionIndex: number,
  CfiClass: EpubCfiConstructor,
): string | null {
  const spineShifted = parsed.spinePos !== sectionIndex;
  if (!parsed.range) {
    const endpoint = resolveCfiStepsInDocument(
      doc,
      parsed.path.steps,
      parsed.path.terminal?.offset ?? null,
    );
    if (!endpoint) return null;
    if (!cfiBase) {
      return endpoint.clamped || endpoint.relocatedById || spineShifted ? null : originalCfi;
    }
    if (
      !endpoint.clamped &&
      !endpoint.relocatedById &&
      !spineShifted &&
      canEpubCfiResolveInDocument(doc, originalCfi, CfiClass)
    ) {
      return originalCfi;
    }
    return cfiFromEndpoint(doc, endpoint, cfiBase, CfiClass);
  }

  const startSteps = [...parsed.path.steps, ...(parsed.start?.steps ?? [])];
  const endSteps = [...parsed.path.steps, ...(parsed.end?.steps ?? [])];
  const start = resolveCfiStepsInDocument(doc, startSteps, parsed.start?.terminal?.offset ?? null);
  if (!start) return null;
  const end = resolveCfiStepsInDocument(doc, endSteps, parsed.end?.terminal?.offset ?? null);
  if (!cfiBase) {
    return start.clamped ||
      start.relocatedById ||
      end?.clamped ||
      end?.relocatedById ||
      spineShifted
      ? null
      : originalCfi;
  }

  if (
    end &&
    !start.clamped &&
    !start.relocatedById &&
    !end.clamped &&
    !end.relocatedById &&
    !spineShifted &&
    canEpubCfiResolveInDocument(doc, originalCfi, CfiClass)
  ) {
    return originalCfi;
  }

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
  return (
    compactRange === compactExcerpt ||
    (excerptWasTruncated && compactRange.startsWith(compactExcerpt))
  );
}

export function validateHighlightRangeInDocument(
  doc: Document,
  parsed: RuntimeParsedCfi,
  annotation: ReaderHighlightInput,
  cfiBase: string | undefined,
  sectionIndex: number,
  CfiClass: EpubCfiConstructor,
): { cfi: string; range: Range; repaired: boolean } | null {
  const range = doc.createRange();
  let clamped: boolean;
  let relocatedById: boolean;
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
    relocatedById = start.relocatedById || end.relocatedById;
  } else {
    const endpoint = resolveCfiStepsInDocument(
      doc,
      parsed.path.steps,
      parsed.path.terminal?.offset ?? null,
    );
    if (!endpoint || (endpoint.elementOnly && annotation.excerpt === undefined)) return null;
    try {
      range.selectNodeContents(endpoint.node);
    } catch {
      return null;
    }
    clamped = endpoint.clamped;
    relocatedById = endpoint.relocatedById;
  }

  if (range.collapsed) return null;
  const rangeText = range.toString();
  if (!normalizeWhitespace(rangeText)) return null;
  const hasExcerpt = Boolean(annotation.excerpt && normalizeWhitespace(annotation.excerpt));
  const excerptWasTruncated = Boolean(
    annotation.excerpt && annotation.excerpt.length >= MAX_STORED_EXCERPT_LENGTH,
  );
  if (hasExcerpt) {
    if (!rangeMatchesExcerpt(rangeText, annotation.excerpt!, excerptWasTruncated)) return null;
  } else if (clamped || relocatedById || parsed.spinePos !== sectionIndex) {
    return null;
  }

  const needsFreshCfi =
    clamped ||
    relocatedById ||
    parsed.spinePos !== sectionIndex ||
    !canEpubCfiResolveInDocument(doc, annotation.cfi, CfiClass);
  if (!needsFreshCfi) return { cfi: annotation.cfi, range, repaired: false };
  if (!cfiBase) return null;
  try {
    const freshCfi = new CfiClass(range, cfiBase).toString();
    const canPersistRepair =
      hasExcerpt && (!clamped || !excerptWasTruncated) && freshCfi !== annotation.cfi;
    return { cfi: freshCfi, range, repaired: canPersistRepair };
  } catch {
    return null;
  }
}

function isIgnoredTextNode(node: Text): boolean {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (IGNORED_TEXT_CONTAINERS.has(parent.localName.toLowerCase())) return true;
  }
  return false;
}

function closestBlockElement(node: Node): Element | null {
  for (let current = node.parentElement; current; current = current.parentElement) {
    if (BLOCK_ELEMENTS.has(current.localName.toLowerCase())) return current;
  }
  return null;
}

export function buildDocumentTextMap(doc: Document): DocumentTextMap {
  const root = doc.body ?? doc.documentElement;
  if (!root) return { text: '', lowerText: '', starts: [], ends: [] };
  const chars: string[] = [];
  const starts: TextMapPosition[] = [];
  const ends: TextMapPosition[] = [];
  let lastBlock: Element | null = null;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let currentNode = walker.nextNode(); currentNode;) {
    const textNode = currentNode as Text;
    currentNode = walker.nextNode();
    if (!textNode.data || isIgnoredTextNode(textNode)) continue;

    const block = closestBlockElement(textNode);
    if (chars.length > 0 && block !== lastBlock && chars[chars.length - 1] !== ' ') {
      chars.push(' ');
      starts.push(ends[ends.length - 1]!);
      ends.push({ node: textNode, offset: 0 });
    }
    if (block) lastBlock = block;

    const data = textNode.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const character = data[offset]!;
      if (/\s/.test(character)) {
        if (chars.length === 0 || chars[chars.length - 1] === ' ') continue;
        chars.push(' ');
      } else {
        chars.push(character);
      }
      starts.push({ node: textNode, offset });
      ends.push({ node: textNode, offset: offset + 1 });
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

export function recordRangeInTextMap(
  map: DocumentTextMap,
  range: Range,
  claimedSpans: ClaimedTextSpan[],
): void {
  if (map.starts.length === 0 || range.collapsed) return;
  if (typeof range.comparePoint === 'function') {
    let first = -1;
    let last = -1;
    for (let index = 0; index < map.starts.length; index += 1) {
      const startPos = map.starts[index]!;
      const endPos = map.ends[index]!;
      try {
        const startCmp = range.comparePoint(startPos.node, startPos.offset);
        if (startCmp > 0) break;
        if (startCmp === 0 && range.comparePoint(endPos.node, endPos.offset) === 0) {
          if (first < 0) first = index;
          last = index;
        }
      } catch {
        return;
      }
    }
    if (first >= 0 && last >= first) claimedSpans.push({ start: first, end: last + 1 });
    return;
  }

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

function isWordCharacter(char: string | undefined): boolean {
  return Boolean(char && /[\p{L}\p{N}]/u.test(char));
}

export function findExcerptMatchInDocument(
  doc: Document,
  excerpt: string,
  options?: {
    prefix?: string | undefined;
    suffix?: string | undefined;
    textMap?: DocumentTextMap | undefined;
    claimedSpans?: ClaimedTextSpan[] | undefined;
    competingBrokenCount?: number | undefined;
    requireUnambiguous?: boolean | undefined;
  },
): ExcerptMatchResult | null {
  const query = normalizeWhitespace(excerpt);
  if (!query) return null;
  const map = options?.textMap ?? buildDocumentTextMap(doc);
  if (!map.text) return null;

  const candidates: ClaimedTextSpan[] = [];
  for (const [haystack, needle] of [
    [map.text, query],
    [map.lowerText, query.toLowerCase()],
  ] as const) {
    let searchFrom = 0;
    while (searchFrom <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, searchFrom);
      if (found < 0) break;
      candidates.push({ start: found, end: found + needle.length });
      searchFrom = found + 1;
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;

  const prefix = options?.prefix ? normalizeWhitespace(options.prefix) : '';
  const suffix = options?.suffix ? normalizeWhitespace(options.suffix) : '';
  const claimed = options?.claimedSpans ?? [];
  const overlapsClaimed = (candidate: ClaimedTextSpan): boolean =>
    claimed.some((span) => candidate.start < span.end && candidate.end > span.start);

  let bestScore = -1;
  let tiedBestCount = 0;
  let chosen: ClaimedTextSpan | null = null;
  let chosenScore = -1;

  for (const candidate of candidates) {
    const before = prefix
      ? map.text.slice(Math.max(0, candidate.start - prefix.length - 8), candidate.start).trimEnd()
      : '';
    const after = suffix
      ? map.text
          .slice(candidate.end, Math.min(map.text.length, candidate.end + suffix.length + 8))
          .trimStart()
      : '';
    const score = scoreContextAffix(before, prefix, true) + scoreContextAffix(after, suffix, false);
    if (score > bestScore) {
      bestScore = score;
      tiedBestCount = 1;
    } else if (score === bestScore) {
      tiedBestCount += 1;
    }
    if (!overlapsClaimed(candidate) && score > chosenScore) {
      chosen = candidate;
      chosenScore = score;
    }
  }

  if (!chosen) return null;

  const minContextScore = Math.min(4, prefix.length + suffix.length);
  const contextContradicted =
    minContextScore > 0 && query.length < 32 && chosenScore < minContextScore;
  const embeddedMidWord =
    query.length < 24 &&
    chosenScore === 0 &&
    ((isWordCharacter(query[0]) && isWordCharacter(map.text[chosen.start - 1])) ||
      (isWordCharacter(query[query.length - 1]) && isWordCharacter(map.text[chosen.end])));
  const competingBrokenAmbiguous =
    (options?.competingBrokenCount ?? 1) > candidates.length &&
    chosenScore < Math.max(1, minContextScore);
  const unambiguous =
    !contextContradicted &&
    !embeddedMidWord &&
    !competingBrokenAmbiguous &&
    ((candidates.length === 1 && chosenScore === bestScore) ||
      (bestScore >= Math.max(1, minContextScore) &&
        tiedBestCount === 1 &&
        chosenScore === bestScore));

  if (options?.requireUnambiguous && !unambiguous) return null;

  const startPos = map.starts[chosen.start];
  const endPos = map.ends[chosen.end - 1];
  if (!startPos || !endPos) return null;
  try {
    const range = doc.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    if (range.collapsed) return null;
    options?.claimedSpans?.push(chosen);
    return {
      range,
      score: Math.max(0, chosenScore),
      candidateCount: candidates.length,
      unambiguous,
    };
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

export function extractSelectionContext(
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
