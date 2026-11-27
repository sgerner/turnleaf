// @vitest-environment jsdom

import { compile, parse, type AST } from 'svelte/compiler';
import { expect, it } from 'vitest';
import readerSource from './Reader.svelte?raw';

type ExpectedPanelSpec = {
  panelId: string;
  titleId: string;
  heading: string;
  closeLabel: string;
  closeHandler:
    | 'closeSettings'
    | 'closeToc'
    | 'closeJump'
    | 'closeSearch'
    | 'closeBookmarks'
    | 'closeAnnotations';
};

const EXPECTED_PANELS: readonly ExpectedPanelSpec[] = [
  {
    panelId: 'reader-appearance',
    titleId: 'reader-appearance-title',
    heading: 'Reading appearance',
    closeLabel: 'Close reading appearance',
    closeHandler: 'closeSettings',
  },
  {
    panelId: 'reader-contents',
    titleId: 'reader-contents-title',
    heading: 'Contents',
    closeLabel: 'Close table of contents',
    closeHandler: 'closeToc',
  },
  {
    panelId: 'reader-jump',
    titleId: 'reader-jump-title',
    heading: 'Go to page or percentage',
    closeLabel: 'Close go to page or percentage',
    closeHandler: 'closeJump',
  },
  {
    panelId: 'reader-search',
    titleId: 'reader-search-title',
    heading: 'Search this book',
    closeLabel: 'Close book search',
    closeHandler: 'closeSearch',
  },
  {
    panelId: 'reader-bookmarks',
    titleId: 'reader-bookmarks-title',
    heading: 'Bookmarks and history',
    closeLabel: 'Close bookmarks and history',
    closeHandler: 'closeBookmarks',
  },
  {
    panelId: 'reader-annotations',
    titleId: 'reader-annotations-title',
    heading: 'Highlights and notes',
    closeLabel: 'Close highlights and notes',
    closeHandler: 'closeAnnotations',
  },
];

function collectTemplateNodes(
  nodes: AST.Fragment['nodes'],
  visit: (node: AST.SvelteNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if ('fragment' in node && node.fragment) {
      collectTemplateNodes(node.fragment.nodes, visit);
    }
    if (node.type === 'IfBlock') {
      collectTemplateNodes(node.consequent.nodes, visit);
      if (node.alternate) {
        collectTemplateNodes(node.alternate.nodes, visit);
      }
    } else if (node.type === 'EachBlock') {
      collectTemplateNodes(node.body.nodes, visit);
      if (node.fallback) {
        collectTemplateNodes(node.fallback.nodes, visit);
      }
    }
  }
}

function getStaticAttribute(element: AST.RegularElement, name: string): string | null {
  for (const attr of element.attributes) {
    if (attr.type === 'Attribute' && attr.name === name && Array.isArray(attr.value)) {
      const textChunk = attr.value[0];
      if (attr.value.length === 1 && textChunk?.type === 'Text') {
        return textChunk.data;
      }
    }
  }
  return null;
}

function significantNodes(nodes: AST.Fragment['nodes']): AST.Fragment['nodes'] {
  return nodes.filter((node) => !(node.type === 'Text' && node.data.trim() === ''));
}

function extractReaderSnippetAndPanels(): {
  snippetBlock: AST.SnippetBlock;
  dialogElements: AST.RegularElement[];
} {
  const ast = parse(readerSource, { filename: 'Reader.svelte', modern: true });
  const snippets: AST.SnippetBlock[] = [];
  const dialogElements: AST.RegularElement[] = [];

  collectTemplateNodes(ast.fragment.nodes, (node) => {
    if (node.type === 'SnippetBlock' && node.expression.name === 'readerPanelHeader') {
      snippets.push(node);
    }
    if (
      node.type === 'RegularElement' &&
      node.name === 'div' &&
      getStaticAttribute(node, 'role') === 'dialog'
    ) {
      dialogElements.push(node);
    }
  });

  expect(snippets).toHaveLength(1);
  const snippetBlock = snippets[0]!;
  return {
    snippetBlock,
    dialogElements,
  };
}

// Verify the template structure without invoking Svelte's private runtime APIs.
it('compiles Reader.svelte with one shared readerPanelHeader snippet and leaves alertdialog untouched', () => {
  const { snippetBlock, dialogElements } = extractReaderSnippetAndPanels();
  const snippetSource = readerSource.slice(snippetBlock.start, snippetBlock.end);

  const paramNames = snippetBlock.parameters.map((param) =>
    param.type === 'Identifier' ? param.name : '',
  );
  expect(paramNames).toEqual(['titleId', 'heading', 'closeLabel', 'onClose']);

  const snippetChildren = significantNodes(snippetBlock.body.nodes);
  expect(
    snippetChildren.map((node) => (node.type === 'RegularElement' ? node.name : node.type)),
  ).toEqual(['button', 'h2']);
  expect(snippetSource).toContain('onclick={onClose}');
  expect(snippetSource).toContain('aria-label={closeLabel}');
  expect(snippetSource).toContain('title="Close"');
  expect(snippetSource).toContain('h-11 w-11');
  expect(snippetSource).toContain('id={titleId}');
  expect(snippetSource).toContain('{heading}');
  expect(snippetSource).toContain('aria-hidden="true"');
  expect(snippetSource).toContain('viewBox="0 0 24 24"');

  expect(dialogElements.map((dialog) => getStaticAttribute(dialog, 'id'))).toEqual(
    EXPECTED_PANELS.map((panel) => panel.panelId),
  );

  for (const [index, spec] of EXPECTED_PANELS.entries()) {
    const dialog = dialogElements[index]!;
    expect(getStaticAttribute(dialog, 'aria-labelledby')).toBe(spec.titleId);
    expect(getStaticAttribute(dialog, 'aria-modal')).toBe('true');
    expect(getStaticAttribute(dialog, 'tabindex')).toBe('-1');

    const firstChild = significantNodes(dialog.fragment.nodes)[0];
    expect(firstChild?.type).toBe('RenderTag');
    const renderSource = readerSource.slice(firstChild!.start, firstChild!.end);
    const dialogSource = readerSource.slice(dialog.start, dialog.end);
    expect(renderSource).toContain('readerPanelHeader');
    expect(renderSource).toContain(`'${spec.titleId}'`);
    expect(renderSource).toContain(`'${spec.heading}'`);
    expect(renderSource).toContain(`'${spec.closeLabel}'`);
    expect(renderSource).toContain(spec.closeHandler);
    expect(dialogSource).toContain('trapModalKeydown');
    expect(dialogSource).toContain(spec.closeHandler);
  }

  expect(() =>
    compile(readerSource, { filename: 'Reader.svelte', generate: 'client' }),
  ).not.toThrow();
  expect(readerSource).toContain('role="alertdialog"');
  expect(readerSource).toContain('id="reader-sync-confirm-title"');
});
