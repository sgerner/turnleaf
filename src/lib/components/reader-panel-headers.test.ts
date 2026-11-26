// @vitest-environment jsdom

import type { Component, mount as mountType, unmount as unmountType } from 'svelte';
import { compile, parse, type AST } from 'svelte/compiler';
import { afterEach, expect, it, vi } from 'vitest';
import { focusFirstElement, restoreFocus, trapModalKeydown } from '../a11y/modal-focus';
import confirmDialogSource from './ConfirmDialog.svelte?raw';
import readerSource from './Reader.svelte?raw';

type ExpectedPanelSpec = {
  panelId: string;
  titleId: string;
  heading: string;
  closeLabel: string;
  closeHandler:
    'closeSettings' | 'closeToc' | 'closeSearch' | 'closeBookmarks' | 'closeAnnotations';
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

type HarnessProps = {
  closeSettings: () => void;
  closeToc: () => void;
  closeSearch: () => void;
  closeBookmarks: () => void;
  closeAnnotations: () => void;
  trapModalKeydown: typeof trapModalKeydown;
};

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
  ast: AST.Root;
  snippetBlock: AST.SnippetBlock;
  snippetSource: string;
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
    ast,
    snippetBlock,
    snippetSource: readerSource.slice(snippetBlock.start, snippetBlock.end),
    dialogElements,
  };
}

let mountedCleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (mountedCleanup) {
    await mountedCleanup();
    mountedCleanup = null;
  }
  document.body.innerHTML = '';
});

async function mountCompiledReaderHeaders(props: HarnessProps): Promise<HTMLElement> {
  const { snippetSource, dialogElements } = extractReaderSnippetAndPanels();

  const panelMarkup = dialogElements
    .map((dialog) => {
      const id = getStaticAttribute(dialog, 'id');
      const className = getStaticAttribute(dialog, 'class');
      const ariaLabelledby = getStaticAttribute(dialog, 'aria-labelledby');
      const firstChild = significantNodes(dialog.fragment.nodes)[0];
      expect(firstChild?.type).toBe('RenderTag');
      const renderTagSource = readerSource.slice(firstChild!.start, firstChild!.end);
      const spec = EXPECTED_PANELS.find((item) => item.panelId === id);
      expect(spec).toBeDefined();

      return `
        <div
          class="${className}"
          id="${id}"
          role="dialog"
          aria-modal="true"
          aria-labelledby="${ariaLabelledby}"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, event.currentTarget, ${spec!.closeHandler})}
        >
          ${renderTagSource}
          <button type="button" data-panel-body="${id}">Body control</button>
        </div>
      `;
    })
    .join('\n');

  const harnessSource = `
    <script lang="ts">
      import type { trapModalKeydown as TrapFn } from '../a11y/modal-focus';
      let {
        closeSettings,
        closeToc,
        closeSearch,
        closeBookmarks,
        closeAnnotations,
        trapModalKeydown,
      }: {
        closeSettings: () => void;
        closeToc: () => void;
        closeSearch: () => void;
        closeBookmarks: () => void;
        closeAnnotations: () => void;
        trapModalKeydown: typeof TrapFn;
      } = $props();
    </script>
    ${snippetSource}
    ${panelMarkup}
  `;

  const compiled = compile(harnessSource, {
    filename: 'ReaderPanelHeadersHarness.svelte',
    generate: 'client',
  });

  const executableBody = compiled.js.code
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+\*\s+as\s+\$\s+from\s+['"]svelte\/internal\/client['"];?\s*$/gm, '')
    .replace(/export\s+default\s+function\s+(\w+)/, 'function $1')
    .concat('\nreturn ReaderPanelHeadersHarness;');

  const svelteClientModule = '../../../../node_modules/svelte/src/index-client.js';
  const svelteInternalModule = 'svelte/internal/client';

  const { mount, unmount } = (await import(svelteClientModule)) as {
    mount: typeof mountType;
    unmount: typeof unmountType;
  };
  const internalClient = (await import(svelteInternalModule)) as unknown;

  const factory = new Function('$', executableBody) as (
    runtime: unknown,
  ) => Component<HarnessProps>;
  const HarnessComponent = factory(internalClient);

  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(HarnessComponent, { target, props });
  mountedCleanup = async () => {
    await unmount(instance);
  };
  return target;
}

it('compiles Reader.svelte with one shared readerPanelHeader snippet and leaves alertdialog untouched', () => {
  const { snippetBlock, dialogElements } = extractReaderSnippetAndPanels();

  const paramNames = snippetBlock.parameters.map((param) =>
    param.type === 'Identifier' ? param.name : '',
  );
  expect(paramNames).toEqual(['titleId', 'heading', 'closeLabel', 'onClose']);

  const snippetChildren = significantNodes(snippetBlock.body.nodes);
  expect(
    snippetChildren.map((node) => (node.type === 'RegularElement' ? node.name : node.type)),
  ).toEqual(['button', 'h2']);

  expect(dialogElements.map((dialog) => getStaticAttribute(dialog, 'id'))).toEqual(
    EXPECTED_PANELS.map((panel) => panel.panelId),
  );

  for (const [index, spec] of EXPECTED_PANELS.entries()) {
    const dialog = dialogElements[index]!;
    expect(getStaticAttribute(dialog, 'aria-labelledby')).toBe(spec.titleId);

    const firstChild = significantNodes(dialog.fragment.nodes)[0];
    expect(firstChild?.type).toBe('RenderTag');
    const renderSource = readerSource.slice(firstChild!.start, firstChild!.end);
    expect(renderSource).toContain('readerPanelHeader');
    expect(renderSource).toContain(`'${spec.titleId}'`);
    expect(renderSource).toContain(`'${spec.heading}'`);
    expect(renderSource).toContain(`'${spec.closeLabel}'`);
    expect(renderSource).toContain(spec.closeHandler);
  }

  const compiled = compile(readerSource, { filename: 'Reader.svelte', generate: 'client' });
  const closeButtonTemplates = compiled.js.code
    .split('\n')
    .filter((line) => line.includes('$.from_html(') && line.includes('title="Close"'));
  expect(closeButtonTemplates).toHaveLength(1);
  expect(closeButtonTemplates[0]).toContain('h-11 w-11');
  expect(closeButtonTemplates[0]).toContain('<h2 class="font-serif text-xl">');

  for (const spec of EXPECTED_PANELS) {
    expect(compiled.js.code).toContain(`readerPanelHeader(`);
    expect(compiled.js.code).toContain(`() => '${spec.titleId}'`);
    expect(compiled.js.code).toContain(`() => '${spec.heading}'`);
    expect(compiled.js.code).toContain(`() => '${spec.closeLabel}'`);
    expect(compiled.js.code).toContain(`() => ${spec.closeHandler}`);
  }

  expect(compiled.js.code).toContain('ConfirmDialog(');
  const compiledConfirm = compile(confirmDialogSource, {
    filename: 'ConfirmDialog.svelte',
    generate: 'client',
  });
  expect(compiledConfirm.js.code).toContain('role="alertdialog"');
  expect(compiledConfirm.js.code).not.toContain('readerPanelHeader');
  expect(compiledConfirm.js.code).not.toContain('title="Close"');
});

it('renders all five compiled headers without wrapper elements and invokes each close handler', async () => {
  const spies = {
    closeSettings: vi.fn(),
    closeToc: vi.fn(),
    closeSearch: vi.fn(),
    closeBookmarks: vi.fn(),
    closeAnnotations: vi.fn(),
  };

  const container = await mountCompiledReaderHeaders({
    ...spies,
    trapModalKeydown,
  });

  const dialogs = container.querySelectorAll<HTMLElement>('[role="dialog"]');
  expect(dialogs).toHaveLength(EXPECTED_PANELS.length);

  for (const spec of EXPECTED_PANELS) {
    const dialog = container.querySelector<HTMLElement>(`#${spec.panelId}`);
    expect(dialog).not.toBeNull();
    expect(dialog!.classList.contains('reader-settings')).toBe(true);
    expect(dialog!.classList.contains('relative')).toBe(true);
    expect(dialog!.getAttribute('aria-labelledby')).toBe(spec.titleId);

    const firstElement = dialog!.firstElementChild as HTMLElement | null;
    expect(firstElement?.tagName).toBe('BUTTON');
    const closeButton = firstElement as HTMLButtonElement;
    expect(closeButton.parentElement).toBe(dialog);
    expect(closeButton.type).toBe('button');
    expect(closeButton.getAttribute('title')).toBe('Close');
    expect(closeButton.getAttribute('aria-label')).toBe(spec.closeLabel);
    expect(closeButton.classList.contains('h-11')).toBe(true);
    expect(closeButton.classList.contains('w-11')).toBe(true);
    expect(closeButton.classList.contains('absolute')).toBe(true);
    expect(closeButton.classList.contains('right-3')).toBe(true);
    expect(closeButton.classList.contains('top-3')).toBe(true);

    const svg = closeButton.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');

    const heading = closeButton.nextElementSibling as HTMLElement | null;
    expect(heading?.tagName).toBe('H2');
    expect(heading?.parentElement).toBe(dialog);
    expect(heading?.id).toBe(spec.titleId);
    expect(heading?.className).toContain('font-serif');
    expect(heading?.className).toContain('text-xl');
    expect(heading?.textContent).toBe(spec.heading);

    const spy = spies[spec.closeHandler];
    expect(spy).not.toHaveBeenCalled();
    closeButton.click();
    expect(spy).toHaveBeenCalledOnce();
  }
});

it('preserves close-button-first modal focus order, Tab wrapping, and Escape close across all five panels', async () => {
  const spies = {
    closeSettings: vi.fn(),
    closeToc: vi.fn(),
    closeSearch: vi.fn(),
    closeBookmarks: vi.fn(),
    closeAnnotations: vi.fn(),
  };

  const opener = document.createElement('button');
  opener.type = 'button';
  opener.textContent = 'Open panel';
  document.body.append(opener);

  const container = await mountCompiledReaderHeaders({
    ...spies,
    trapModalKeydown,
  });

  for (const spec of EXPECTED_PANELS) {
    const dialog = container.querySelector<HTMLElement>(`#${spec.panelId}`)!;
    const closeButton = dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!;
    const bodyButton = dialog.querySelector<HTMLButtonElement>(
      `button[data-panel-body="${spec.panelId}"]`,
    )!;

    focusFirstElement(dialog);
    expect(document.activeElement).toBe(closeButton);

    closeButton.tabIndex = -1;
    focusFirstElement(dialog);
    expect(document.activeElement).toBe(bodyButton);
    closeButton.tabIndex = 0;

    bodyButton.focus();
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(forward);
    expect(document.activeElement).toBe(closeButton);
    expect(forward.defaultPrevented).toBe(true);

    closeButton.focus();
    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(backward);
    expect(document.activeElement).toBe(bodyButton);
    expect(backward.defaultPrevented).toBe(true);

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(escape);
    restoreFocus(opener);

    expect(spies[spec.closeHandler]).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(opener);
  }
});
