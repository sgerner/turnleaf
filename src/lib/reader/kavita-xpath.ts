export interface KavitaXPathTarget {
  spineIndex: number;
  contentXPath: string;
}

export interface KavitaXPathStep {
  tag: string;
  index: number;
}

interface KavitaDocFragmentMatch {
  fragment: number;
  content: string;
}

interface KavitaIdAnchorMatch {
  id: string;
  content: string;
}

function isValidSpineIndex(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stripKoreaderSuffix(content: string): string {
  return content
    .replace(/\/+$/, '')
    .replace(/(?:\/text\(\)(?:\[\d+])?)?(?:\.\d+)?$/i, '')
    .replace(/\/+$/, '');
}

function parseContentSteps(content: string): KavitaXPathStep[] | null {
  const cleaned = stripKoreaderSuffix(content);
  if (!cleaned) return [];
  if (!cleaned.startsWith('/')) return null;
  const parts = cleaned.split('/').filter(Boolean);
  const steps: KavitaXPathStep[] = [];
  for (const part of parts) {
    const match = part.match(/^([A-Za-z0-9:_-]+)(?:\[(\d+)])?$/);
    if (!match?.[1]) return null;
    const index = match[2] !== undefined ? Number(match[2]) : 1;
    if (!Number.isInteger(index) || index < 1) return null;
    steps.push({ tag: match[1].toLowerCase(), index });
  }
  return steps;
}

function formatContentSteps(steps: KavitaXPathStep[]): string {
  return steps.length ? `/${steps.map((step) => `${step.tag}[${step.index}]`).join('/')}` : '';
}

function formatIdAnchor(id: string): string {
  const quote = id.includes('"') && !id.includes("'") ? "'" : '"';
  return `id(${quote}${id}${quote})`;
}

function matchDocFragmentXPath(xpath: string): KavitaDocFragmentMatch | null {
  const match = xpath.match(/^\/{1,2}body\/DocFragment\[(\d+)]\/body(?<content>(?:\/.*)?)$/i);
  if (!match?.[1]) return null;
  return {
    fragment: Number(match[1]),
    content: match.groups?.content ?? '',
  };
}

function matchIdAnchorXPath(xpath: string): KavitaIdAnchorMatch | null {
  const idFunc = xpath.match(
    /^(?:\/{1,2})?id\((?<quote>["'])(?<id>[^"']+)\k<quote>\)(?<content>(?:\/.*)?)$/i,
  );
  if (idFunc?.groups?.id) {
    if (idFunc.groups.id.includes('"') && idFunc.groups.id.includes("'")) return null;
    return { id: idFunc.groups.id, content: idFunc.groups.content ?? '' };
  }
  const attrMatch = xpath.match(
    /^\/{1,2}[A-Za-z0-9:*_-]+\[@id=(?<quote>["'])(?<id>[^"']+)\k<quote>](?<content>(?:\/.*)?)$/i,
  );
  if (attrMatch?.groups?.id) {
    return { id: attrMatch.groups.id, content: attrMatch.groups.content ?? '' };
  }
  return null;
}

function matchBodyXPath(xpath: string): string | null {
  const match = xpath.match(
    /^(?:\/{1,2}(?:html(?:\[1])?\/)?)?body(?:\[1])?(?<content>(?:\/.*)?)$/i,
  );
  return match ? (match.groups?.content ?? '') : null;
}

export function resolveKavitaPageNumber(
  pageNum: number | null | undefined,
  xpath?: string | null,
  totalPages = 0,
): number | null {
  if (totalPages > 0 && isValidSpineIndex(pageNum) && pageNum >= totalPages) {
    return pageNum;
  }
  const trimmed = xpath?.trim();
  if (trimmed) {
    const legacy = matchDocFragmentXPath(trimmed);
    if (legacy) {
      return Number.isInteger(legacy.fragment) && legacy.fragment >= 1 ? legacy.fragment - 1 : null;
    }
  }
  return isValidSpineIndex(pageNum) ? pageNum : null;
}

export function parseKavitaXPath(
  xpath: string,
  spineIndex?: number | null,
): KavitaXPathTarget | null {
  const trimmed = xpath.trim();
  if (!trimmed) return null;

  if (/^\/{1,2}body\/DocFragment(?:\[|\/|$)/i.test(trimmed)) {
    const legacy = matchDocFragmentXPath(trimmed);
    if (!legacy || !Number.isInteger(legacy.fragment) || legacy.fragment < 1) return null;
    const steps = parseContentSteps(legacy.content);
    if (!steps) return null;
    return {
      spineIndex: legacy.fragment - 1,
      contentXPath: `/html/body${formatContentSteps(steps)}`,
    };
  }

  const idMatch = matchIdAnchorXPath(trimmed);
  if (idMatch) {
    if (!isValidSpineIndex(spineIndex)) return null;
    const steps = parseContentSteps(idMatch.content);
    if (!steps) return null;
    return {
      spineIndex,
      contentXPath: `${formatIdAnchor(idMatch.id)}${formatContentSteps(steps)}`,
    };
  }

  const bodyContent = matchBodyXPath(trimmed);
  if (bodyContent !== null) {
    if (!isValidSpineIndex(spineIndex)) return null;
    const steps = parseContentSteps(bodyContent);
    if (!steps) return null;
    return {
      spineIndex,
      contentXPath: `/html/body${formatContentSteps(steps)}`,
    };
  }

  return null;
}

export function bodyContentSteps(contentXPath: string): KavitaXPathStep[] | null {
  const bodyContent = matchBodyXPath(contentXPath);
  if (bodyContent === null) return null;
  return parseContentSteps(bodyContent);
}

export function kavitaXPathSteps(
  xpath: string,
  spineIndex?: number | null,
): KavitaXPathStep[] | null {
  const target = parseKavitaXPath(xpath, spineIndex);
  if (!target) return null;
  const steps = bodyContentSteps(target.contentXPath);
  if (!steps) return null;
  return [{ tag: 'spine', index: target.spineIndex }, ...steps];
}

export function toKavitaXPath(contentXPath: string, spineIndex?: number): string | null {
  if (spineIndex !== undefined && !isValidSpineIndex(spineIndex)) return null;
  const trimmed = contentXPath.trim();
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/^\/{0,2}html(?:\[1])?\/body(?:\[1])?(?=\/|$)/i, '')
    .replace(/^\/{0,2}body(?:\[1])?(?=\/|$)/i, '');
  const normalized =
    stripped === '' || stripped === '/' ? '' : stripped.startsWith('/') ? stripped : `/${stripped}`;
  const steps = parseContentSteps(normalized);
  if (!steps) return null;
  return `//body${formatContentSteps(steps)}`;
}

export function resolveContentXPath(document: Document, xpath: string): Element | null {
  const trimmed = xpath.trim();
  if (!trimmed) return null;
  const body =
    [...document.documentElement.children].find(
      (element) => element.localName.toLowerCase() === 'body',
    ) ?? null;
  if (!body) return null;

  let current: Element | null;
  let steps: KavitaXPathStep[] | null;

  const idMatch = matchIdAnchorXPath(trimmed);
  if (idMatch) {
    const byId = document.getElementById(idMatch.id);
    current =
      byId && (byId === body || body.contains(byId))
        ? byId
        : body.getAttribute('id') === idMatch.id
          ? body
          : ([...body.querySelectorAll('[id]')].find(
              (element) => element.getAttribute('id') === idMatch.id,
            ) ?? null);
    steps = parseContentSteps(idMatch.content);
  } else {
    const bodyContent = matchBodyXPath(trimmed);
    if (bodyContent === null) return null;
    current = body;
    steps = parseContentSteps(bodyContent);
  }

  if (!current || !steps) return null;

  for (const step of steps) {
    const matches: Element[] = [...current.children].filter(
      (element) => element.localName.toLowerCase() === step.tag,
    );
    current = matches[step.index - 1] ?? null;
    if (!current) return null;
  }
  return current;
}
