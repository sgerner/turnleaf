export interface KavitaXPathTarget {
  spineIndex: number;
  contentXPath: string;
}

interface KavitaXPathMatch {
  fragment: number;
  content: string;
}

function matchKavitaXPath(xpath: string): KavitaXPathMatch | null {
  const match = xpath.match(/^\/{1,2}body\/DocFragment\[(\d+)]\/body(?<content>\/.*)?$/i);
  if (!match?.[1]) return null;
  return {
    fragment: Number(match[1]),
    content: match.groups?.content ?? '',
  };
}

export function parseKavitaXPath(xpath: string): KavitaXPathTarget | null {
  const match = matchKavitaXPath(xpath);
  if (!match || !Number.isInteger(match.fragment) || match.fragment < 1) return null;
  const content = match.content.replace(/\/+$/, '');
  return {
    spineIndex: match.fragment - 1,
    contentXPath: `/html/body${content}`,
  };
}

export function kavitaXPathSteps(xpath: string): { tag: string; index: number }[] | null {
  const match = matchKavitaXPath(xpath);
  if (!match || match.fragment < 1) return null;
  const steps = [{ tag: 'DocFragment', index: match.fragment }];
  for (const part of match.content.split('/').filter(Boolean)) {
    const step = part.match(/^([A-Za-z0-9:_-]+)\[(\d+)]$/);
    if (!step?.[1] || !step[2] || Number(step[2]) < 1) return null;
    steps.push({ tag: step[1].toLowerCase(), index: Number(step[2]) });
  }
  return steps;
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
    if (!match?.[1] || !match[2]) return null;
    const name = match[1].toLowerCase();
    const index = Number(match[2]) - 1;
    const matches: Element[] = [...current.children].filter(
      (element) => element.localName.toLowerCase() === name,
    );
    current = matches[index] ?? null;
    if (!current) return null;
  }
  return current;
}
