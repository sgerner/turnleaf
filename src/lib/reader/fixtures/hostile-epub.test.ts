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
  const document = new DOMParser().parseFromString(
    '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
    'application/xhtml+xml',
  );
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

  await sanitizeEpubDocument(document);

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
