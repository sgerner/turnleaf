// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';
import {
  domRangeToKavitaXPaths,
  fallbackKavitaXPathFromCfi,
  parseKavitaLocator,
  resolveKavitaAnnotationDomRange,
} from './kavita-xpath-range';

describe('Kavita EPUB locations', () => {
  it('adds the one-based Kavita spine fragment to an EPUB content path', () => {
    expect(toKavitaXPath('/html/body/section[1]/p[4]', 2)).toBe(
      '//body/DocFragment[3]/body/section[1]/p[4]',
    );
  });

  it('removes indexed HTML and body roots produced by EPUB documents', () => {
    expect(toKavitaXPath('/html[1]/body[1]/div[2]/p[3]', 0)).toBe(
      '//body/DocFragment[1]/body/div[2]/p[3]',
    );
  });

  it('maps a Kavita location back to a zero-based EPUB spine and content path', () => {
    expect(parseKavitaXPath('//body/DocFragment[3]/body/section[1]/p[4]')).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[1]/p[4]',
    });
  });

  it('accepts Kavita chapter-body locations with a trailing slash', () => {
    expect(parseKavitaXPath('//body/DocFragment[2]/body/')).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body',
    });
  });

  it('rejects unscoped and invalid locations instead of opening the wrong chapter', () => {
    expect(parseKavitaXPath('/html/body/p[1]')).toBeNull();
    expect(parseKavitaXPath('//body/DocFragment[0]/body/p[1]')).toBeNull();
  });

  it('resolves Kavita paths through XHTML-style element names', () => {
    const document = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><section><p>one</p><p>two</p></section></body></html>',
      'application/xhtml+xml',
    );
    expect(resolveContentXPath(document, '/html/body/section[1]/p[2]')?.textContent).toBe('two');
    expect(resolveContentXPath(document, '/html/body')?.localName).toBe('body');
  });

  it('counts XPath indices among siblings of the requested tag', () => {
    const document = new DOMParser().parseFromString(
      '<html><body><p>first</p><h2>heading</h2><p>second</p></body></html>',
      'text/html',
    );
    expect(resolveContentXPath(document, '/html/body/p[2]')?.textContent).toBe('second');
    expect(resolveContentXPath(document, '/html/body/h2[1]')?.textContent).toBe('heading');
  });

  it('parses DocFragment, page-scoped Angular reader, and id() Kavita locators', () => {
    expect(parseKavitaLocator('//body/DocFragment[4]/body/section[1]/p[2]', 0)).toEqual({
      spineIndex: 3,
      contentXPath: '/html/body/section[1]/p[2]',
    });
    expect(
      parseKavitaLocator(
        '//body/app-root[1]/div[1]/app-book-reader[1]/div[2]/div[1]/section[2]/p[5]',
        2,
      ),
    ).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[2]/p[5]',
    });
    expect(parseKavitaLocator('id("fn-42")', 1)).toEqual({
      spineIndex: 1,
      contentXPath: 'id("fn-42")',
    });

    const document = new DOMParser().parseFromString(
      '<html><body><p id="fn-42">Footnote text</p></body></html>',
      'text/html',
    );
    expect(resolveContentXPath(document, 'id("fn-42")')?.textContent).toBe('Footnote text');
  });

  it('derives fallback DocFragment XPaths from EPUB CFIs and round-trips multi-node DOM ranges', () => {
    expect(fallbackKavitaXPathFromCfi('epubcfi(/6/6!/4/2/1:0)')).toEqual({
      spineIndex: 2,
      xPath: '//body/DocFragment[3]/body',
    });

    const document = new DOMParser().parseFromString(
      '<html><body><section><p>Start of a <em>highlighted</em></p><p>passage across paragraphs.</p></section></body></html>',
      'text/html',
    );
    const emphasis = document.querySelector('em')!;
    const secondParagraph = document.querySelectorAll('p')[1]!;
    const selectionRange = document.createRange();
    selectionRange.setStart(emphasis.firstChild!, 0);
    selectionRange.setEnd(secondParagraph.firstChild!, 14);

    const kavitaLocators = domRangeToKavitaXPaths(selectionRange, 1);
    expect(kavitaLocators).toMatchObject({
      xPath: '//body/DocFragment[2]/body/section[1]/p[1]/em[1]',
      endingXPath: '//body/DocFragment[2]/body/section[1]/p[2]',
    });
    const resolved = resolveKavitaAnnotationDomRange(
      document,
      '/html/body/section[1]/p[1]',
      '/html/body/section[1]/p[2]',
      'highlighted   passage across',
    );
    expect(resolved?.startContainer).toBe(emphasis.firstChild);
    expect(resolved?.startOffset).toBe(0);
    expect(resolved?.endContainer).toBe(secondParagraph.firstChild);
    expect(resolved?.endOffset).toBe(14);
  });
});
