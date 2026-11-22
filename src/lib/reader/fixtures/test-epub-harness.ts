export interface TestChapter {
  id: string;
  href: string;
  title: string;
  body: string;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export const TEST_PAGE_WIDTH = 600;
export const TEST_PAGE_HEIGHT = 800;

function write16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  write16(bytes, offset, value);
  write16(bytes, offset + 2, Math.floor(value / 0x10000));
}

function makeStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const normalized = entries.map((entry) => ({
    name: encoder.encode(entry.name),
    data: entry.data,
  }));
  const localSize = normalized.reduce(
    (sum, entry) => sum + 30 + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = normalized.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  const localOffsets: number[] = [];
  let offset = 0;

  for (const entry of normalized) {
    localOffsets.push(offset);
    write32(archive, offset, 0x04034b50);
    write16(archive, offset + 4, 20);
    write32(archive, offset + 18, entry.data.length);
    write32(archive, offset + 22, entry.data.length);
    write16(archive, offset + 26, entry.name.length);
    offset += 30;
    archive.set(entry.name, offset);
    offset += entry.name.length;
    archive.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralOffset = offset;
  normalized.forEach((entry, index) => {
    write32(archive, offset, 0x02014b50);
    write16(archive, offset + 4, 20);
    write16(archive, offset + 6, 20);
    write32(archive, offset + 20, entry.data.length);
    write32(archive, offset + 24, entry.data.length);
    write16(archive, offset + 28, entry.name.length);
    write32(archive, offset + 42, localOffsets[index]!);
    offset += 46;
    archive.set(entry.name, offset);
    offset += entry.name.length;
  });

  write32(archive, offset, 0x06054b50);
  write16(archive, offset + 8, normalized.length);
  write16(archive, offset + 10, normalized.length);
  write32(archive, offset + 12, centralSize);
  write32(archive, offset + 16, centralOffset);
  return archive;
}

export function buildTestEpub(chapters: TestChapter[], bookTitle = 'Test Edition'): Uint8Array {
  const encoder = new TextEncoder();
  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...chapters.map(
      (chapter) =>
        `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`,
    ),
  ].join('\n    ');
  const spineItems = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join('\n    ');
  const navItems = chapters
    .map((chapter) => `<li><a href="${chapter.href}">${chapter.title}</a></li>`)
    .join('\n        ');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-edition</dc:identifier>
    <dc:title>${bookTitle}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Navigation</title></head>
  <body>
    <nav epub:type="toc">
      <ol>
        ${navItems}
      </ol>
    </nav>
  </body>
</html>`;

  const entries: ZipEntry[] = [
    { name: 'mimetype', data: encoder.encode('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      ),
    },
    { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
    { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
    ...chapters.map((chapter) => ({
      name: `OEBPS/${chapter.href}`,
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${chapter.title}</title></head>
  <body>
    ${chapter.body}
  </body>
</html>`,
      ),
    })),
  ];

  return makeStoredZip(entries);
}

function makeDomRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    },
  } as DOMRect;
}

function elementPageIndex(element: Element): number {
  const explicit = element.closest('[data-page]')?.getAttribute('data-page');
  if (explicit !== null && explicit !== undefined) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function elementRowIndex(element: Element): number {
  const body = element.ownerDocument.body;
  if (!body) return 0;
  const blocks = [...body.querySelectorAll('h1, h2, h3, p, blockquote, li')];
  const target = element.closest('h1, h2, h3, p, blockquote, li') ?? element;
  const idx = blocks.indexOf(target);
  return idx >= 0 ? idx : 0;
}

function computeContentElementRect(element: Element): DOMRect {
  const tag = element.localName.toLowerCase();
  if (tag === 'html' || tag === 'body') {
    const pages = [...element.ownerDocument.querySelectorAll('[data-page]')].map((node) =>
      Number.parseInt(node.getAttribute('data-page') ?? '0', 10),
    );
    const maxPage = pages.length > 0 ? Math.max(0, ...pages) : 0;
    return makeDomRect(0, 0, (maxPage + 1) * TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT);
  }
  const page = elementPageIndex(element);
  const row = elementRowIndex(element);
  return makeDomRect(page * TEST_PAGE_WIDTH + 24, (row % 12) * 40 + 24, 520, 24);
}

function computeRangeRect(range: Range): DOMRect {
  const startNode = range.startContainer;
  if (startNode.nodeType === Node.ELEMENT_NODE) {
    const startElement = startNode as Element;
    const tag = startElement.localName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      return computeContentElementRect(startElement);
    }
  }
  const ownerElement =
    startNode.nodeType === Node.ELEMENT_NODE
      ? (startNode as Element)
      : (startNode.parentElement ?? startNode.ownerDocument?.body ?? null);
  const base = ownerElement
    ? computeContentElementRect(ownerElement)
    : makeDomRect(24, 24, 200, 24);
  const startChars = startNode.nodeType === Node.TEXT_NODE ? range.startOffset : 0;
  const lengthChars = Math.max(1, range.toString().length || 4);
  const left = base.left + Math.min(400, startChars * 6);
  const width = Math.min(480, Math.max(12, lengthChars * 6));
  return makeDomRect(left, base.top, width, base.height);
}

function patchWindowDomGeometry(targetWindow: Window & typeof globalThis): void {
  targetWindow.scrollTo = (() => {}) as typeof targetWindow.scrollTo;
  targetWindow.scrollBy = (() => {}) as typeof targetWindow.scrollBy;
  const elementProto = targetWindow.Element?.prototype as
    (Element & { animate?: typeof Element.prototype.animate }) | undefined;
  if (elementProto && typeof elementProto.animate !== 'function') {
    elementProto.animate = function () {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel() {},
        finish() {
          animation.onfinish?.();
        },
        play() {},
        pause() {},
        reverse() {},
        currentTime: 0,
        playState: 'finished',
        finished: Promise.resolve(),
      };
      queueMicrotask(() => {
        animation.onfinish?.();
      });
      return animation as unknown as Animation;
    };
  }
  const proto = targetWindow.HTMLElement?.prototype;
  const rangeProto = targetWindow.Range?.prototype;
  const svgProto = targetWindow.SVGElement?.prototype;
  if (proto && !(proto as unknown as { __turnleafPatched?: boolean }).__turnleafPatched) {
    Object.defineProperty(proto, '__turnleafPatched', { value: true });
    proto.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.ownerDocument !== window.document) {
        return computeContentElementRect(this);
      }
      const styleWidth = Number.parseFloat(this.style.width || '');
      const styleHeight = Number.parseFloat(this.style.height || '');
      if (
        this.classList.contains('reader-viewport') ||
        this.classList.contains('epub-container') ||
        this.dataset.readerTestViewport === 'true'
      ) {
        return makeDomRect(0, 0, TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT);
      }
      if (this.classList.contains('epub-view')) {
        const scrollLeft = this.parentElement?.scrollLeft ?? 0;
        return makeDomRect(
          -scrollLeft,
          0,
          Number.isFinite(styleWidth) && styleWidth > 0 ? styleWidth : TEST_PAGE_WIDTH,
          Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : TEST_PAGE_HEIGHT,
        );
      }
      if (this.tagName.toLowerCase() === 'iframe') {
        return makeDomRect(
          0,
          0,
          Number.isFinite(styleWidth) && styleWidth > 0 ? styleWidth : TEST_PAGE_WIDTH,
          Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : TEST_PAGE_HEIGHT,
        );
      }
      return makeDomRect(
        0,
        0,
        Number.isFinite(styleWidth) && styleWidth > 0 ? styleWidth : TEST_PAGE_WIDTH,
        Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : TEST_PAGE_HEIGHT,
      );
    };

    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return Math.round(this.getBoundingClientRect().width);
      },
    });
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return Math.round(this.getBoundingClientRect().height);
      },
    });
    Object.defineProperty(proto, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return Math.round(this.getBoundingClientRect().width);
      },
    });
    Object.defineProperty(proto, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return Math.round(this.getBoundingClientRect().height);
      },
    });
    Object.defineProperty(proto, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.ownerDocument !== window.document) {
          const pages = [...this.ownerDocument.querySelectorAll('[data-page]')].map((node) =>
            Number.parseInt(node.getAttribute('data-page') ?? '0', 10),
          );
          const maxPage = pages.length > 0 ? Math.max(0, ...pages) : 0;
          return (maxPage + 1) * TEST_PAGE_WIDTH;
        }
        if (this.classList.contains('epub-container')) {
          const view = this.querySelector<HTMLElement>('.epub-view');
          const viewWidth = Number.parseFloat(view?.style.width || '');
          return Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : TEST_PAGE_WIDTH;
        }
        return Math.round(this.getBoundingClientRect().width);
      },
    });
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return TEST_PAGE_HEIGHT;
      },
    });
  }

  if (svgProto && !(svgProto as unknown as { __turnleafPatched?: boolean }).__turnleafPatched) {
    Object.defineProperty(svgProto, '__turnleafPatched', { value: true });
    svgProto.getBoundingClientRect = function (): DOMRect {
      return makeDomRect(0, 0, TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT);
    };
  }

  if (rangeProto && !(rangeProto as unknown as { __turnleafPatched?: boolean }).__turnleafPatched) {
    Object.defineProperty(rangeProto, '__turnleafPatched', { value: true });
    rangeProto.getBoundingClientRect = function (this: Range): DOMRect {
      return computeRangeRect(this);
    };
    rangeProto.getClientRects = function (this: Range): DOMRectList {
      const rect = computeRangeRect(this);
      const list = [rect] as unknown as DOMRectList & DOMRect[];
      list.item = (index: number) => list[index] ?? null;
      return list;
    };
  }
}

export function installEpubJsdomEnvironment(): () => void {
  patchWindowDomGeometry(window);
  const originalScrollTo = window.scrollTo;
  const originalScrollBy = window.scrollBy;
  const originalResizeObserver = globalThis.ResizeObserver;
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  window.scrollBy = (() => {}) as typeof window.scrollBy;
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class StubResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  }

  const hadSrcdoc = 'srcdoc' in HTMLIFrameElement.prototype;
  const srcdocDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
  if (hadSrcdoc) {
    delete (HTMLIFrameElement.prototype as { srcdoc?: unknown }).srcdoc;
  }

  const originalAppendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function <T extends Node>(this: Node, child: T): T {
    const appended = originalAppendChild.call(this, child) as T;
    if (child instanceof HTMLIFrameElement && child.contentWindow) {
      patchWindowDomGeometry(child.contentWindow as Window & typeof globalThis);
      const doc = child.contentDocument;
      if (doc && !(doc as unknown as { __turnleafWritePatched?: boolean }).__turnleafWritePatched) {
        Object.defineProperty(doc, '__turnleafWritePatched', { value: true });
        const originalClose = doc.close.bind(doc);
        doc.close = () => {
          originalClose();
          if (child.contentWindow) {
            patchWindowDomGeometry(child.contentWindow as Window & typeof globalThis);
          }
          queueMicrotask(() => {
            child.dispatchEvent(new Event('load'));
          });
        };
      }
    }
    return appended;
  };

  return () => {
    Node.prototype.appendChild = originalAppendChild;
    window.scrollTo = originalScrollTo;
    window.scrollBy = originalScrollBy;
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      delete (window as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
      window.ResizeObserver = originalResizeObserver;
    }
    if (hadSrcdoc && srcdocDescriptor) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', srcdocDescriptor);
    }
  };
}
