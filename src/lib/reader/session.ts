import ePub, { type Contents, type Location, type Rendition } from 'epubjs';
import type { Appearance } from './appearance';

export interface ReaderLocation {
  cfi: string;
  xpath: string | null;
  href: string;
  percentage: number;
  spineIndex: number;
  pageIndex: number;
  pageCount: number;
}

export interface TocItem {
  label: string;
  href: string;
}

interface SpineSection {
  href: string;
  index: number;
}

const MODE_COLORS = {
  light: {
    background: '--color-surface-50',
    text: '--color-surface-950',
    link: '--color-primary-700',
    selection: '--color-primary-200',
  },
  grayscale: {
    background: '--color-surface-100',
    text: '--color-surface-900',
    link: '--color-surface-700',
    selection: '--color-surface-300',
  },
  dark: {
    background: '--color-surface-950',
    text: '--color-surface-50',
    link: '--color-primary-300',
    selection: '--color-primary-800',
  },
} as const;

export class ReaderSession {
  private readonly book;
  private rendition: Rendition | null = null;
  private relocated: ((location: Location) => void) | null = null;
  private contentClick: ((event: MouseEvent, contents: Contents) => void) | null = null;
  private current: Location | null = null;

  constructor(private readonly bookUrl: string) {
    this.book = ePub(bookUrl);
  }

  async open(
    target: HTMLElement,
    cfi: string | null,
    serverXPath: string | null,
    appearance: Appearance,
    onLocation: (location: ReaderLocation) => void,
    onTap: (zone: 'previous' | 'center' | 'next') => void,
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
    this.relocated = (location) => {
      this.current = location;
      const start = location.start;
      const sections = this.spineSections();
      const sectionCount = Math.max(1, sections.length);
      const sectionIndex = Math.max(
        0,
        sections.findIndex((section) => section.href === start.href),
      );
      const pageIndex = this.pageIndex(start.displayed.page);
      const sectionProgress = pageIndex / Math.max(1, start.displayed.total);
      const reportedPercentage = Number.isFinite(start.percentage) ? start.percentage : null;
      const semanticPercentage = (sectionIndex + sectionProgress) / sectionCount;
      onLocation({
        ...start,
        percentage:
          reportedPercentage !== null && reportedPercentage > 0
            ? reportedPercentage
            : semanticPercentage,
        spineIndex: start.index,
        pageIndex,
        pageCount: start.displayed.total,
        xpath: this.cfiToXPath(start.cfi),
      });
    };
    this.rendition.on('relocated', this.relocated);
    this.contentClick = (event, contents) => {
      const position = event.clientX / contents.window.innerWidth;
      onTap(position < 0.33 ? 'previous' : position > 0.67 ? 'next' : 'center');
    };
    this.rendition.on('click', this.contentClick);
    this.applyAppearance(appearance);
    await this.rendition.display(cfi ?? undefined);
    if (!cfi && serverXPath) await this.displayXPath(serverXPath);
  }

  async next(): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.rendition.next();
  }

  async previous(): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    await this.rendition.prev();
  }

  tableOfContents(): TocItem[] {
    return [...this.book.navigation.toc.values()].map((item) => ({
      label: item.label,
      href: item.href,
    }));
  }

  display(href: string): Promise<void> {
    if (!this.rendition) throw new Error('Reader is not open.');
    return this.rendition.display(href);
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
        padding: `0 ${value.margin}px !important`,
        'box-sizing': 'border-box',
        width: '100% !important',
        height: '100% !important',
      },
      p: {
        'margin-bottom': `${value.paragraphSpacing}em !important`,
        'text-align': `${value.alignment} !important`,
        hyphens: value.hyphenation ? 'auto' : 'none',
      },
      img: {
        'max-width': '100% !important',
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
    this.rendition = null;
    this.relocated = null;
    this.contentClick = null;
    this.current = null;
    this.book.destroy();
  }

  private harden(contents: Contents): void {
    contents.document
      .querySelectorAll('script, iframe, object, embed, form')
      .forEach((node) => node.remove());
    contents.document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') ?? '';
      if (/^(https?:|javascript:|data:)/i.test(href)) anchor.removeAttribute('href');
    });
  }

  private cfiToXPath(cfi: string): string | null {
    try {
      if (!this.rendition) return null;
      const range = this.rendition.getRange(cfi);
      let element =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      if (!element) return null;
      const parts: string[] = [];
      while (element) {
        const tag = element.localName;
        const siblings = element.parentElement
          ? [...element.parentElement.children].filter((child) => child.localName === tag)
          : [];
        parts.unshift(`${tag}[${Math.max(1, siblings.indexOf(element) + 1)}]`);
        if (element.localName === 'html') break;
        element = element.parentElement;
      }
      return `/${parts.join('/')}`;
    } catch {
      return null;
    }
  }

  private async displayXPath(xpath: string): Promise<void> {
    if (!this.rendition) return;
    for (const contents of this.rendition.getContents() as unknown as Contents[]) {
      try {
        const node = contents.document.evaluate(
          xpath,
          contents.document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (!node) continue;
        const range = contents.document.createRange();
        range.selectNodeContents(node);
        await this.rendition.display(contents.cfiFromRange(range));
        return;
      } catch {
        // A server XPath from a changed EPUB is not safe to guess around.
      }
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
