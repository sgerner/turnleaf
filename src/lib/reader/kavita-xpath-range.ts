import {
  parseKavitaXPath,
  resolveContentXPath,
  toKavitaXPath,
  type KavitaXPathTarget,
} from './kavita-xpath';

export function parseKavitaLocator(
  xpath: string | null | undefined,
  fallbackSpineIndex?: number,
): KavitaXPathTarget | null {
  if (!xpath) return null;
  const trimmed = xpath.trim();
  if (!trimmed) return null;
  const direct = parseKavitaXPath(trimmed);
  if (direct) return direct;
  if (
    fallbackSpineIndex === undefined ||
    !Number.isInteger(fallbackSpineIndex) ||
    fallbackSpineIndex < 0
  ) {
    return null;
  }
  const idMatch = trimmed.match(/^id\("([^"]+)"\)$/i);
  if (idMatch?.[1]) {
    return {
      spineIndex: fallbackSpineIndex,
      contentXPath: `id("${idMatch[1]}")`,
    };
  }
  const descoped = trimmed
    .replace(
      /^\/{1,2}body\/app-root\[\d+\](?:\/[^/]+)*?\/app-book-reader\[\d+\](?:\/div\[\d+\]){1,8}/i,
      '//body',
    )
    .replace(/^\/{1,2}body\/div\[1\](?=\/|$)/i, '//body');
  const bodyMatch = descoped.match(
    /^\/{1,2}(?:html(?:\[1\])?\/)?body(?:\[1\])?(?<content>\/.*)?$/i,
  );
  if (!bodyMatch) return null;
  const content = (bodyMatch.groups?.content ?? '').replace(/\/+$/, '');
  return {
    spineIndex: fallbackSpineIndex,
    contentXPath: `/html/body${content}`,
  };
}

export function fallbackKavitaXPathFromCfi(
  cfi: string,
): { spineIndex: number; xPath: string } | null {
  const match = cfi.trim().match(/^epubcfi\(\/\d+\/(\d+)(?:\[[^\]]*\])?!/i);
  if (!match?.[1]) return null;
  const spineStep = Number(match[1]);
  if (!Number.isInteger(spineStep) || spineStep < 2) return null;
  const spineIndex = Math.max(0, Math.floor(spineStep / 2) - 1);
  const xPath = toKavitaXPath('/html/body', spineIndex);
  return xPath ? { spineIndex, xPath } : null;
}

export function elementToContentXPath(node: Node | null): string | null {
  let element =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
  if (!element) return null;
  const parts: string[] = [];
  while (element && element.localName !== 'body' && element.localName !== 'html') {
    const tag = element.localName.toLowerCase();
    let index = 1;
    for (
      let sibling = element.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.localName.toLowerCase() === tag) index += 1;
    }
    parts.push(`${tag}[${index}]`);
    element = element.parentElement;
  }
  if (!element) return null;
  return parts.length ? `/html/body/${parts.reverse().join('/')}` : '/html/body';
}

export function domRangeToKavitaXPaths(
  range: Range,
  spineIndex: number,
): { xPath: string; endingXPath: string; context: string } | null {
  const startContent = elementToContentXPath(range.startContainer);
  const endContent = elementToContentXPath(range.endContainer) ?? startContent;
  if (!startContent || !endContent) return null;
  const xPath = toKavitaXPath(startContent, spineIndex);
  const endingXPath = toKavitaXPath(endContent, spineIndex);
  if (!xPath || !endingXPath) return null;
  const contextNode =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const context = (contextNode?.textContent ?? range.toString()).trim().slice(0, 1000);
  return { xPath, endingXPath, context };
}

function normalizeTextWithMap(raw: string): { normalized: string; rawIndices: number[] } {
  let normalized = '';
  const rawIndices: number[] = [];
  let previousSpace = true;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (/\s/.test(char)) {
      if (!previousSpace) {
        normalized += ' ';
        rawIndices.push(index);
        previousSpace = true;
      }
    } else {
      normalized += char;
      rawIndices.push(index);
      previousSpace = false;
    }
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    rawIndices.pop();
  }
  return { normalized, rawIndices };
}

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

function closestBlockAncestor(node: Node): Element | null {
  let element = node.parentElement;
  while (element && INLINE_TAGS.has(element.localName.toLowerCase())) {
    element = element.parentElement;
  }
  return element;
}

export function resolveKavitaAnnotationDomRange(
  document: Document,
  startContentXPath: string,
  endContentXPath: string | null | undefined,
  selectedText: string,
): Range | null {
  const startElement = resolveContentXPath(document, startContentXPath);
  if (!startElement) return null;
  const resolvedEnd = endContentXPath
    ? resolveContentXPath(document, endContentXPath)
    : startElement;
  const endElement = resolvedEnd ?? startElement;

  let first = startElement;
  let last = endElement;
  if (first !== last && first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING) {
    first = endElement;
    last = startElement;
  }

  const boundary = document.createRange();
  boundary.setStartBefore(first);
  boundary.setEndAfter(last);

  const trimmedSelection = selectedText.trim();
  if (!trimmedSelection) {
    const fallback = document.createRange();
    fallback.selectNodeContents(first);
    return fallback;
  }

  const runs: Array<{ node: Text; start: number; end: number }> = [];
  let combined = '';
  let previousBlock: Element | null = null;
  const walker = document.createTreeWalker(
    boundary.commonAncestorContainer,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let current: Node | null = walker.currentNode;
  while (current) {
    if (boundary.intersectsNode(current)) {
      if (
        current.nodeType === Node.ELEMENT_NODE &&
        (current as Element).localName.toLowerCase() === 'br' &&
        combined.length > 0 &&
        !/\s$/.test(combined)
      ) {
        combined += ' ';
      } else if (current.nodeType === Node.TEXT_NODE) {
        const textNode = current as Text;
        const value = textNode.data;
        if (value.length > 0) {
          const block = closestBlockAncestor(textNode);
          if (
            previousBlock &&
            block !== previousBlock &&
            combined.length > 0 &&
            !/\s$/.test(combined) &&
            !/^\s/.test(value)
          ) {
            combined += ' ';
          }
          previousBlock = block;
          const start = combined.length;
          combined += value;
          runs.push({ node: textNode, start, end: combined.length });
        }
      }
    }
    current = walker.nextNode();
  }

  if (runs.length === 0) {
    const fallback = document.createRange();
    fallback.selectNodeContents(first);
    return fallback;
  }

  let matchStart = combined.indexOf(trimmedSelection);
  let matchEnd = matchStart >= 0 ? matchStart + trimmedSelection.length : -1;

  if (matchStart < 0) {
    const haystack = normalizeTextWithMap(combined);
    const needle = normalizeTextWithMap(trimmedSelection).normalized;
    if (needle) {
      const normIndex = haystack.normalized.indexOf(needle);
      if (normIndex >= 0) {
        const lastNormIndex = normIndex + needle.length - 1;
        matchStart = haystack.rawIndices[normIndex] ?? -1;
        const rawLastChar = haystack.rawIndices[lastNormIndex] ?? -1;
        matchEnd = rawLastChar >= 0 ? rawLastChar + 1 : -1;
      }
    }
  }

  if (matchStart < 0 || matchEnd <= matchStart) {
    const fallback = document.createRange();
    fallback.selectNodeContents(first);
    return fallback;
  }

  const startRun = runs.find((run) => matchStart >= run.start && matchStart < run.end);
  const endRun = runs.find((run) => matchEnd > run.start && matchEnd <= run.end);
  if (!startRun || !endRun) {
    const fallback = document.createRange();
    fallback.selectNodeContents(first);
    return fallback;
  }

  const range = document.createRange();
  range.setStart(startRun.node, matchStart - startRun.start);
  range.setEnd(endRun.node, matchEnd - endRun.start);
  return range;
}
