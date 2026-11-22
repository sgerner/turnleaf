// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import fixture from './hostile-epub.xhtml?raw';
import { sanitizeEpubDocument } from '../session';

it('keeps local EPUB content while removing network and executable references', async () => {
  const document = new DOMParser().parseFromString(fixture, 'application/xhtml+xml');

  await sanitizeEpubDocument(document);

  expect(document.querySelector('base')).toBeNull();
  expect(document.querySelector('script, iframe, form, meta[http-equiv="refresh"]')).toBeNull();
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toContain("connect-src 'none'");
  expect(document.body?.getAttribute('onload')).toBeNull();
  expect(document.querySelector('#internal')?.getAttribute('href')).toBe('chapter-2.xhtml#section');
  expect(document.querySelector('#fragment')?.getAttribute('href')).toBe('#section');
  expect(document.querySelector('#remote')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#encoded')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#scheme-relative')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#file')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#malformed')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#local-image')?.getAttribute('src')).toBe('../Images/cover.jpg');
  expect(document.querySelector('#embedded-image')?.getAttribute('src')).toMatch(
    /^data:image\/png/,
  );
  expect(document.querySelector('#remote-image')?.getAttribute('src')).toBeNull();
  expect(document.querySelector('#remote-srcset')?.getAttribute('srcset')).toBe(
    '../Images/a.jpg 2x',
  );
  expect(document.querySelector('#remote-svg-image')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#remote-video')?.getAttribute('poster')).toBeNull();
  expect(document.querySelector('link[href="styles/book.css"]')).toBeNull();
  expect(document.querySelector('link[href^="https:"]')).toBeNull();
  expect(document.querySelector('style')?.textContent).toContain('../Images/paper.png');
  expect(document.querySelector('style')?.textContent).not.toContain('attacker.example');
});

it('sanitizes a local stylesheet before restoring its safe rules', async () => {
  const chapter = () =>
    new DOMParser().parseFromString(
      '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
      'application/xhtml+xml',
    );
  const document = chapter();
  const anotherChapter = chapter();
  const stylesheetCache = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          '.cover { background: url(../Images/cover.jpg); } .remote { background: url(https://attacker.example/pixel); }',
          {
            status: 200,
            headers: { 'content-type': 'text/css' },
          },
        ),
    ),
  );

  await Promise.all([
    sanitizeEpubDocument(document, stylesheetCache),
    sanitizeEpubDocument(anotherChapter, stylesheetCache),
  ]);

  expect(fetch).toHaveBeenCalledOnce();
  expect(anotherChapter.querySelectorAll('style')).toHaveLength(2);
  expect(document.querySelector('base')?.getAttribute('href')).toContain('localhost');
  expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
  expect(document.querySelector('style')?.textContent).toContain('../Images/cover.jpg');
  expect(document.querySelector('style')?.textContent).not.toContain('attacker.example');
  const requested = vi.mocked(fetch).mock.calls[0]?.[0];
  expect(requested instanceof URL ? requested.href : requested).toBe(
    'http://localhost/_capacitor_file/books/book.epub/OEBPS/styles/book.css',
  );
  vi.unstubAllGlobals();
});

function write16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  write16(bytes, offset, value);
  write16(bytes, offset + 2, Math.floor(value / 0x10000));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredEpubZip(
  entries: Array<{ name: string; content: string | Uint8Array }>,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const normalized = entries.map((entry) => {
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    return {
      name: encoder.encode(entry.name),
      data,
      crc: crc32(data),
    };
  });
  const localSize = normalized.reduce(
    (sum, item) => sum + 30 + item.name.length + item.data.length,
    0,
  );
  const centralSize = normalized.reduce((sum, item) => sum + 46 + item.name.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const item of normalized) {
    localOffsets.push(offset);
    write32(archive, offset, 0x04034b50);
    write16(archive, offset + 4, 20);
    write32(archive, offset + 14, item.crc);
    write32(archive, offset + 18, item.data.length);
    write32(archive, offset + 22, item.data.length);
    write16(archive, offset + 26, item.name.length);
    offset += 30;
    archive.set(item.name, offset);
    offset += item.name.length;
    archive.set(item.data, offset);
    offset += item.data.length;
  }

  const centralOffset = offset;
  normalized.forEach((item, index) => {
    write32(archive, offset, 0x02014b50);
    write16(archive, offset + 4, 20);
    write16(archive, offset + 6, 20);
    write32(archive, offset + 16, item.crc);
    write32(archive, offset + 20, item.data.length);
    write32(archive, offset + 24, item.data.length);
    write16(archive, offset + 28, item.name.length);
    write32(archive, offset + 42, localOffsets[index]!);
    offset += 46;
    archive.set(item.name, offset);
    offset += item.name.length;
  });

  write32(archive, offset, 0x06054b50);
  write16(archive, offset + 8, normalized.length);
  write16(archive, offset + 10, normalized.length);
  write32(archive, offset + 12, centralSize);
  write32(archive, offset + 16, centralOffset);
  return archive.buffer;
}

it('retains local blob stylesheets and @font-face rules while stripping remote CSS targets', async () => {
  const { sanitizeCss } = await import('../session');
  const fontBlobUrl = 'blob:http://localhost/font-asset-id';
  const css = [
    "@import url('https://attacker.example/import-url.css');",
    '@import "https://attacker.example/import-string.css" screen;',
    '@import"https://attacker.example/no-space.css";',
    '@import/**/"https://attacker.example/comment-bypass.css";',
    "@import 'typography.css';",
    `@font-face { font-family: 'BookFont'; src: url('${fontBlobUrl}') format('woff2'), url('https://attacker.example/font.woff2') format('woff2'); }`,
    ".foreign-blob { background-image: url('blob:https://attacker.example/foreign-id'); }",
    ".callout { border-left: 4px solid rgb(180, 83, 9); background-image: url('https://attacker.example/pixel.png'); }",
  ].join('\n');

  const sanitized = sanitizeCss(css, 'http://localhost/OEBPS/styles/book.css');
  expect(sanitized).toContain("@import 'typography.css';");
  expect(sanitized).toContain(fontBlobUrl);
  expect(sanitized).toContain('border-left: 4px solid rgb(180, 83, 9)');
  expect(sanitized).not.toContain('attacker.example');

  const styleBlobUrl = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
  try {
    const doc = new DOMParser().parseFromString(
      `<html><head><base href="http://localhost/OEBPS/text/chapter1.xhtml" /><link rel="stylesheet" href="${styleBlobUrl}" /><link rel="stylesheet" href="blob:https://attacker.example/evil-css" /></head><body><p class="callout">Text</p></body></html>`,
      'application/xhtml+xml',
    );
    await sanitizeEpubDocument(doc);

    const styles = [...doc.querySelectorAll('style')]
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(styles).toContain(fontBlobUrl);
    expect(styles).not.toContain('attacker.example');
  } finally {
    URL.revokeObjectURL(styleBlobUrl);
  }
});

it('opens a zipped EPUB with sanitized manifest CSS, embedded fonts, publisherStyles toggling, and blob cleanup', async () => {
  const { defaultAppearance } = await import('../appearance');
  const { ReaderSession } = await import('../session');

  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const createObjectUrl = (blob: Blob | MediaSource): string => {
    const url = nativeCreateObjectURL(blob as Blob);
    createdUrls.push(url);
    return url;
  };
  const revokeObjectUrl = (url: string): void => {
    revokedUrls.push(url);
    nativeRevokeObjectURL(url);
  };
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectUrl,
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectUrl,
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectUrl);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl);

  const originalRangeRect = Range.prototype.getBoundingClientRect;
  const originalRangeRects = Range.prototype.getClientRects;
  const rectList = () =>
    ({
      length: 1,
      item: () => new DOMRect(0, 0, 320, 24),
      0: new DOMRect(0, 0, 320, 24),
      [Symbol.iterator]: function* () {
        yield new DOMRect(0, 0, 320, 24);
      },
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 320, 480);
  Range.prototype.getClientRects ??= rectList;
  const nativeCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = nativeCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'iframe') {
      element.addEventListener(
        'load',
        () => {
          const frameEl = element as HTMLIFrameElement;
          const frameWin = frameEl.contentWindow as (Window & typeof globalThis) | null;
          const frameDoc = frameEl.contentDocument;
          if (!frameWin || !frameDoc) return;
          if (frameEl.srcdoc && !frameDoc.body?.children.length) {
            const parsed = new DOMParser().parseFromString(frameEl.srcdoc, 'text/html');
            frameDoc.documentElement.replaceWith(frameDoc.importNode(parsed.documentElement, true));
          }
          frameWin.scrollTo = () => {};
          frameWin.Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 320, 480);
          frameWin.Range.prototype.getClientRects ??= rectList;
        },
        true,
      );
    }
    return element;
  }) as typeof document.createElement);

  const epubArchive = makeStoredEpubZip([
    { name: 'mimetype', content: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">hostile-zip-test</dc:identifier><dc:title>Hostile Styled EPUB</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles/book.css" media-type="text/css"/><item id="subcss" href="styles/typography.css" media-type="text/css"/><item id="font" href="fonts/sample.woff2" media-type="font/woff2"/><item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    },
    {
      name: 'OEBPS/nav.xhtml',
      content:
        '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">Chapter 1</a></li><li><a href="text/chapter2.xhtml">Chapter 2</a></li></ol></nav></body></html>',
    },
    {
      name: 'OEBPS/fonts/sample.woff2',
      content: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]),
    },
    {
      name: 'OEBPS/styles/book.css',
      content: [
        '@import "https://attacker.example/remote-import.css";',
        '@import "typography.css";',
        'h1 { font-family: EmbeddedTestFont, serif; border-bottom: 2px solid rgb(180, 83, 9); }',
        ".callout { border-left: 4px solid rgb(180, 83, 9); background-image: url('https://attacker.example/tracker.png'); }",
      ].join('\n'),
    },
    {
      name: 'OEBPS/styles/typography.css',
      content: [
        '@import "https://attacker.example/nested-import.css";',
        "@font-face { font-family: 'EmbeddedTestFont'; src: url('../fonts/sample.woff2') format('woff2'), url('https://attacker.example/evil.woff2') format('woff2'); }",
      ].join('\n'),
    },
    {
      name: 'OEBPS/text/chapter1.xhtml',
      content: [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<base href="https://attacker.example/hijack/" />',
        '<link rel="stylesheet" type="text/css" href="../styles/book.css" />',
        '<link rel="stylesheet" type="text/css" href="https://attacker.example/external.css" />',
        '</head>',
        '<body onload="fetch(\'https://attacker.example/onload\')">',
        '<script>fetch("https://attacker.example/script")</script>',
        '<h1>Chapter 1</h1>',
        '<p class="callout" style="font-style: italic; background-image: url(https://attacker.example/inline.png)">Styled paragraph.</p>',
        '<img id="remote" src="https://attacker.example/remote.jpg" />',
        '</body>',
        '</html>',
      ].join(''),
    },
    {
      name: 'OEBPS/text/chapter2.xhtml',
      content: [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<link rel="stylesheet" type="text/css" href="../styles/book.css" />',
        '</head>',
        '<body>',
        '<h1>Chapter 2</h1>',
        '<p class="callout" style="font-style: italic">Second chapter paragraph.</p>',
        '</body>',
        '</html>',
      ].join(''),
    },
  ]);

  const viewport = document.createElement('div');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 360, 640),
  );
  document.body.appendChild(viewport);

  const locations: string[] = [];
  const session = new ReaderSession(epubArchive);
  try {
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      (loc) => {
        locations.push(loc.cfi);
      },
      vi.fn(),
    );

    const frame = viewport.querySelector('iframe');
    expect(frame).not.toBeNull();
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).not.toContain('attacker.example');
    expect(srcdoc).not.toContain('<script');

    const chapterDoc = frame!.contentDocument!;
    const chapterWin = frame!.contentWindow!;
    let authorStyleText = '';
    await vi.waitFor(() => {
      expect(chapterDoc.querySelector('link[rel="stylesheet"]')).toBeNull();
      authorStyleText = [...chapterDoc.querySelectorAll('style')]
        .filter((style) => !style.id.startsWith('epubjs-inserted-css-'))
        .map((style) => style.textContent ?? '')
        .join('\n');
      expect(authorStyleText).toContain('border-bottom: 2px solid rgb(180, 83, 9)');
    });
    expect(authorStyleText).toContain('@import "blob:');
    expect(authorStyleText).not.toContain('attacker.example');
    const importedBlobMatch = authorStyleText.match(/@import\s+"(blob:[^"]+)"/);
    expect(importedBlobMatch?.[1]).toBeTruthy();
    const importedCssText = await (await fetch(importedBlobMatch![1]!)).text();
    expect(importedCssText).toContain('EmbeddedTestFont');
    expect(importedCssText).toContain('blob:');
    expect(importedCssText).not.toContain('attacker.example');

    const heading = chapterDoc.querySelector('h1')!;
    const callout = chapterDoc.querySelector('p.callout')!;
    expect(chapterWin.getComputedStyle(heading).borderBottomWidth).toBe('2px');
    expect(chapterWin.getComputedStyle(callout).borderLeftWidth).toBe('4px');
    expect(chapterWin.getComputedStyle(callout).fontStyle).toBe('italic');

    await vi.waitFor(() => {
      expect(locations.length).toBeGreaterThan(0);
    });
    const activeCfi = locations.at(-1)!;
    expect(activeCfi).toMatch(/^epubcfi\(/);

    session.applyAppearance({ ...defaultAppearance, publisherStyles: false });
    expect(chapterWin.getComputedStyle(heading).borderBottomWidth).toBe('0px');
    expect(chapterWin.getComputedStyle(callout).borderLeftWidth).toBe('0px');
    expect(chapterWin.getComputedStyle(callout).fontStyle).toBe('normal');
    expect(chapterDoc.getElementById('epubjs-inserted-css-turnleaf')).not.toBeNull();
    expect(locations.at(-1)).toBe(activeCfi);

    await session.display('text/chapter2.xhtml');
    const ch2Frame = viewport.querySelector('iframe')!;
    await vi.waitFor(() => {
      expect(ch2Frame.contentDocument?.querySelector('h1')?.textContent).toBe('Chapter 2');
      expect(ch2Frame.contentDocument?.querySelector('link[rel="stylesheet"]')).toBeNull();
    });
    expect(
      ch2Frame.contentWindow!.getComputedStyle(ch2Frame.contentDocument!.querySelector('h1')!)
        .borderBottomWidth,
    ).toBe('0px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).fontStyle,
    ).toBe('normal');

    session.applyAppearance({ ...defaultAppearance, publisherStyles: true });
    expect(
      ch2Frame.contentWindow!.getComputedStyle(ch2Frame.contentDocument!.querySelector('h1')!)
        .borderBottomWidth,
    ).toBe('2px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).borderLeftWidth,
    ).toBe('4px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).fontStyle,
    ).toBe('italic');
  } finally {
    session.destroy();
    viewport.remove();
    Range.prototype.getBoundingClientRect = originalRangeRect;
    Range.prototype.getClientRects = originalRangeRects;
    vi.restoreAllMocks();
  }

  expect(createdUrls.length).toBeGreaterThan(0);
  for (const url of createdUrls) {
    expect(revokedUrls).toContain(url);
  }
});
