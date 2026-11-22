// @vitest-environment jsdom

import { crc32 } from 'node:zlib';
import ePub, { EpubCFI, type Contents } from 'epubjs';
import { afterEach, expect, it, vi } from 'vitest';
import indexHtml from '../../../../index.html?raw';
import { defaultAppearance } from '../appearance';
import { ReaderSession, registerEpubSpineSanitizer, sanitizeEpubDocument } from '../session';
import fixture from './hostile-epub.xhtml?raw';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

function buildEpubArchive(entries: Array<[string, string | Uint8Array]>): ArrayBuffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const checksum = crc32(dataBytes);
    const flags = name === 'mimetype' ? 0 : 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, dataBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(dataBytes.length, 20);
    central.writeUInt32LE(dataBytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
  return new Uint8Array(archive).buffer;
}

function buildHostileEpubArchive(): ArrayBuffer {
  const chapterTwo = `<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Chapter 2</title>
  </head>
  <body>
    <section id="section">
      <p>Second chapter target</p>
      <p>Follow-up paragraph</p>
    </section>
  </body>
</html>`;
  const packagedCss = `
@import url('https://attacker.example/packaged-import.css');
@import'https://attacker.example/compact-import.css';
.packaged-local {
  background-image: url('../Images/paper.png');
  color: rgb(18, 52, 86);
}
.packaged-remote {
  background-image: url('https://attacker.example/packaged-bg');
}
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:hostile-epub-fixture</dc:identifier>
    <dc:title>Hostile EPUB Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter-1" href="Text/hostile-epub.xhtml" media-type="application/xhtml+xml" />
    <item id="chapter-2" href="Text/chapter-2.xhtml" media-type="application/xhtml+xml" />
    <item id="book-css" href="Text/styles/book.css" media-type="text/css" />
    <item id="cover-image" href="Images/cover.jpg" media-type="image/png" />
    <item id="paper-image" href="Images/paper.png" media-type="image/png" />
    <item id="srcset-image" href="Images/a.jpg" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
    <itemref idref="chapter-2" />
  </spine>
</package>`;

  return buildEpubArchive([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    ['OEBPS/content.opf', opf],
    ['OEBPS/Text/hostile-epub.xhtml', fixture],
    ['OEBPS/Text/chapter-2.xhtml', chapterTwo],
    ['OEBPS/Text/styles/book.css', packagedCss],
    ['OEBPS/Images/cover.jpg', ONE_PIXEL_PNG],
    ['OEBPS/Images/paper.png', ONE_PIXEL_PNG],
    ['OEBPS/Images/a.jpg', ONE_PIXEL_PNG],
  ]);
}

function installObjectUrlShim(): () => void {
  const originalCreate = window.URL.createObjectURL;
  const originalRevoke = window.URL.revokeObjectURL;
  let nextBlobId = 0;
  window.URL.createObjectURL = () => `blob:http://localhost/asset-${++nextBlobId}`;
  window.URL.revokeObjectURL = () => {};
  return () => {
    window.URL.createObjectURL = originalCreate;
    window.URL.revokeObjectURL = originalRevoke;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

it('sanitizes Section.render output and packaged stylesheets before iframe serialization', async () => {
  const restoreObjectUrls = installObjectUrlShim();
  const fetchSpy = vi.fn(async () => {
    throw new Error('Unexpected network fetch during Section.render');
  });
  vi.stubGlobal('fetch', fetchSpy);
  const book = ePub(buildHostileEpubArchive());
  registerEpubSpineSanitizer(book as unknown as Parameters<typeof registerEpubSpineSanitizer>[0]);

  try {
    await book.opened;
    const section = book.spine.get(0);
    const rendered = await section.render(book.load.bind(book));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rendered).toContain('http-equiv="Content-Security-Policy"');
    expect(rendered).toContain("img-src 'self' data: blob:");
    expect(rendered).not.toContain('attacker.example');

    const serializedDoc = new DOMParser().parseFromString(rendered, 'text/html');
    expect(
      serializedDoc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
    ).toHaveLength(1);
    expect(
      serializedDoc.querySelector(
        'script, iframe, form, meta[http-equiv="refresh"], link[rel="stylesheet"]',
      ),
    ).toBeNull();
    expect(serializedDoc.querySelector('#internal')?.getAttribute('href')).toBe(
      'chapter-2.xhtml#section',
    );
    expect(serializedDoc.querySelector('#fragment')?.getAttribute('href')).toBe('#section');
    expect(serializedDoc.querySelector('#remote')?.getAttribute('href')).toBeNull();
    expect(serializedDoc.querySelector('#local-image')?.getAttribute('src')).toMatch(/^blob:/);
    expect(serializedDoc.querySelector('#embedded-image')?.getAttribute('src')).toMatch(
      /^data:image\/png/,
    );
    expect(serializedDoc.querySelector('#remote-image')?.getAttribute('src')).toBeNull();
    expect(serializedDoc.querySelector('#remote-srcset')?.getAttribute('srcset')).toMatch(
      /^blob:\S+\s+2x$/,
    );
    expect(serializedDoc.querySelector('#remote-svg-image')?.getAttribute('href')).toBeNull();
    expect(serializedDoc.querySelector('#remote-video')?.getAttribute('poster')).toBeNull();

    const combinedStyles = [...serializedDoc.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(combinedStyles).toContain('color: rgb(18, 52, 86)');
    expect(combinedStyles).toMatch(/url\(['"]?blob:/);
    expect(combinedStyles).not.toContain('attacker.example');
  } finally {
    book.destroy();
    restoreObjectUrls();
  }
});

it('opens hostile EPUBs in ReaderSession with zero outbound requests and aligned search CFIs', async () => {
  const restoreObjectUrls = installObjectUrlShim();
  const outboundRequests: string[] = [];
  const assignedSrcdocs: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      outboundRequests.push(target);
      throw new Error(`Unexpected outbound fetch: ${target}`);
    }),
  );

  const originalCreateElement = document.createElement.bind(document);
  const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = originalCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'iframe') {
      const frame = element as HTMLIFrameElement;
      let needsSrcdocHydration = false;
      const srcdocDescriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        'srcdoc',
      );
      if (srcdocDescriptor?.set && srcdocDescriptor.get) {
        Object.defineProperty(frame, 'srcdoc', {
          configurable: true,
          get: () => srcdocDescriptor.get!.call(frame),
          set: (value: string) => {
            assignedSrcdocs.push(value);
            needsSrcdocHydration = true;
            srcdocDescriptor.set!.call(frame, value);
          },
        });
      }
      frame.addEventListener(
        'load',
        () => {
          if (needsSrcdocHydration && frame.contentDocument && frame.srcdoc) {
            needsSrcdocHydration = false;
            frame.contentDocument.open();
            frame.contentDocument.write(frame.srcdoc);
            frame.contentDocument.close();
          }
          const frameWindow = frame.contentWindow as (Window & { Range?: typeof Range }) | null;
          if (!frameWindow) return;
          frameWindow.scrollTo = () => {};
          if (frameWindow.Range) {
            frameWindow.Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600);
            frameWindow.Range.prototype.getClientRects = () =>
              Object.assign([], { item: () => null }) as DOMRectList;
          }
        },
        { capture: true },
      );
    }
    return element;
  }) as typeof document.createElement);

  const viewport = originalCreateElement('div');
  Object.defineProperty(viewport, 'clientWidth', { value: 400 });
  Object.defineProperty(viewport, 'clientHeight', { value: 600 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
  document.body.appendChild(viewport);

  const session = new ReaderSession(buildHostileEpubArchive());
  try {
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());

    expect(outboundRequests).toEqual([]);
    expect(assignedSrcdocs.length).toBeGreaterThan(0);
    for (const srcdoc of assignedSrcdocs) {
      expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
      expect(srcdoc).not.toContain('attacker.example');
    }

    const frame = viewport.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(String(frame?.sandbox)).toBe('allow-same-origin');

    const frameDoc = frame?.contentDocument ?? null;
    expect(frameDoc).not.toBeNull();
    expect(frameDoc?.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(
      1,
    );
    expect(frameDoc?.documentElement.outerHTML).not.toContain('attacker.example');

    const results = await session.search('Continue');
    expect(results).toHaveLength(1);
    expect(results[0]?.spineIndex).toBe(0);
    expect(results[0]?.cfi).toMatch(/^epubcfi\(/);

    const rendition = (session as unknown as { rendition: { getContents: () => unknown } })
      .rendition;
    const contents = rendition.getContents() as Contents[];
    expect(contents).toHaveLength(1);
    expect(contents[0]?.range(results[0]!.cfi)?.toString()).toBe('Continue');
    expect(new EpubCFI(results[0]!.cfi).toRange(frameDoc!)?.toString()).toBe('Continue');

    const chapterTwoResults = await session.search('Second chapter target');
    expect(chapterTwoResults).toHaveLength(1);
    expect(chapterTwoResults[0]?.spineIndex).toBe(1);

    session.updateHighlights([{ cfi: results[0]!.cfi }]);
    expect(outboundRequests).toEqual([]);
  } finally {
    session.destroy();
    viewport.remove();
    createElementSpy.mockRestore();
    restoreObjectUrls();
  }
});

it('restricts parent index.html img-src to local, native, data, and blob schemes', () => {
  const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
  const csp =
    parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ??
    '';
  const directives = new Map(
    csp
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, ...values] = entry.split(/\s+/);
        return [name ?? '', values];
      }),
  );

  expect(directives.get('img-src')).toEqual(["'self'", 'capacitor:', 'data:', 'blob:']);
  expect(directives.get('frame-src')).toEqual(["'self'", 'capacitor:', 'blob:']);
});
