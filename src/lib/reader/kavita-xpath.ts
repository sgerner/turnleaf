export interface KavitaXPathTarget {
  spineIndex: number;
  contentXPath: string;
}

export interface KavitaXPathStep {
  tag: string;
  index: number;
}

function isValidSpineIndex(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseContentSteps(content: string): KavitaXPathStep[] | null {
  const cleaned = content
    .replace(/\/+$/, '')
    .replace(/(?:\/text\(\)(?:\[\d+])?)?(?:\.\d+)?$/i, '')
    .replace(/\/+$/, '');
  if (!cleaned) return [];
  if (!cleaned.startsWith('/')) return null;
  const steps: KavitaXPathStep[] = [];
  for (const part of cleaned.split('/').filter(Boolean)) {
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

function matchDocFragmentXPath(xpath: string): { fragment: number; content: string } | null {
  const match = xpath.match(/^\/{1,2}body\/DocFragment\[(\d+)]\/body(?<content>(?:\/.*)?)$/i);
  return match?.[1] ? { fragment: Number(match[1]), content: match.groups?.content ?? '' } : null;
}

function matchIdAnchorXPath(xpath: string): { id: string; content: string } | null {
  const idMatch =
    xpath.match(/^(?:\/{1,2})?id\((?<q>["'])(?<id>[^"']+)\k<q>\)(?<content>(?:\/.*)?)$/i) ??
    xpath.match(
      /^\/{1,2}[A-Za-z0-9:*_-]+\[@id=(?<q>["'])(?<id>[^"']+)\k<q>](?<content>(?:\/.*)?)$/i,
    );
  const id = idMatch?.groups?.id;
  if (!id || (id.includes('"') && id.includes("'"))) return null;
  return { id, content: idMatch.groups?.content ?? '' };
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
  if (totalPages > 0 && isValidSpineIndex(pageNum) && pageNum >= totalPages) return pageNum;
  const legacy = xpath ? matchDocFragmentXPath(xpath.trim()) : null;
  if (legacy) {
    return Number.isInteger(legacy.fragment) && legacy.fragment >= 1 ? legacy.fragment - 1 : null;
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
    const steps =
      legacy && Number.isInteger(legacy.fragment) && legacy.fragment >= 1
        ? parseContentSteps(legacy.content)
        : null;
    return legacy && steps
      ? { spineIndex: legacy.fragment - 1, contentXPath: `/html/body${formatContentSteps(steps)}` }
      : null;
  }

  const idMatch = matchIdAnchorXPath(trimmed);
  if (idMatch) {
    if (!isValidSpineIndex(spineIndex)) return null;
    const steps = parseContentSteps(idMatch.content);
    if (!steps) return null;
    const quote = idMatch.id.includes('"') ? "'" : '"';
    return {
      spineIndex,
      contentXPath: `id(${quote}${idMatch.id}${quote})${formatContentSteps(steps)}`,
    };
  }

  const bodyContent = matchBodyXPath(trimmed);
  if (bodyContent !== null && isValidSpineIndex(spineIndex)) {
    const steps = parseContentSteps(bodyContent);
    if (steps) return { spineIndex, contentXPath: `/html/body${formatContentSteps(steps)}` };
  }
  return null;
}

export function bodyContentSteps(contentXPath: string): KavitaXPathStep[] | null {
  const bodyContent = matchBodyXPath(contentXPath);
  return bodyContent === null ? null : parseContentSteps(bodyContent);
}

export function kavitaXPathSteps(
  xpath: string,
  spineIndex?: number | null,
): KavitaXPathStep[] | null {
  const target = parseKavitaXPath(xpath, spineIndex);
  const steps = target ? bodyContentSteps(target.contentXPath) : null;
  return target && steps ? [{ tag: 'spine', index: target.spineIndex }, ...steps] : null;
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
  return steps ? `//body${formatContentSteps(steps)}` : null;
}

export function resolveContentXPath(document: Document, xpath: string): Element | null {
  const trimmed = xpath.trim();
  const body = trimmed
    ? ([...document.documentElement.children].find(
        (element) => element.localName.toLowerCase() === 'body',
      ) ?? null)
    : null;
  if (!body) return null;

  const idMatch = matchIdAnchorXPath(trimmed);
  let current: Element | null = body;
  let steps: KavitaXPathStep[] | null;
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
