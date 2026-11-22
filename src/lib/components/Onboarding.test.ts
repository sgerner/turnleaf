import { createRequire } from 'node:module';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../database/database';
import Onboarding from './Onboarding.svelte';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => {
    window: {
      document: Document;
      HTMLInputElement: typeof HTMLInputElement;
    };
  };
};

const savedServer: ServerConfig = {
  id: 'primary',
  displayName: 'Books',
  baseUrl: 'https://books.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.8',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

function renderOnboarding(
  props: {
    savedServer?: ServerConfig | null;
    editAddress?: boolean;
  } = {},
): { document: Document; InputElement: typeof HTMLInputElement } {
  const { body } = render(Onboarding, {
    props: {
      ...props,
      onConnected: vi.fn(),
    },
  });
  const { window } = new JSDOM(body);
  return { document: window.document, InputElement: window.HTMLInputElement };
}

function findLabeledInput(
  doc: Document,
  InputElement: typeof HTMLInputElement,
  labelPrefix: string,
): HTMLInputElement | null {
  for (const label of doc.querySelectorAll('label')) {
    const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text.startsWith(labelPrefix)) {
      continue;
    }
    const htmlFor = label.getAttribute('for');
    if (htmlFor) {
      const target = doc.getElementById(htmlFor);
      return target instanceof InputElement ? target : null;
    }
    return label.querySelector('input');
  }
  return null;
}

describe('Onboarding autocomplete attributes', () => {
  it('sets autocomplete attributes and defaults library name to Books during initial setup', () => {
    const { document: doc, InputElement } = renderOnboarding();

    const serverAddressInput = findLabeledInput(doc, InputElement, 'Kavita server address');
    expect(serverAddressInput).not.toBeNull();
    expect(serverAddressInput?.getAttribute('autocomplete')).toBe('url');

    const authKeyInput = doc.getElementById('kavita-auth-key');
    expect(authKeyInput).toBeInstanceOf(InputElement);
    expect(authKeyInput?.getAttribute('autocomplete')).toBe('off');

    const libraryNameInput = findLabeledInput(doc, InputElement, 'Library name Optional');
    expect(libraryNameInput).not.toBeNull();
    expect(libraryNameInput?.getAttribute('class')).toBe('input');
    expect(libraryNameInput?.getAttribute('autocomplete')).toBe('off');
    expect(libraryNameInput?.value).toBe('Books');
    expect(doc.querySelector('[autocomplete="organization"]')).toBeNull();
  });

  it('hides the library name input during reconnect while preserving autocomplete attributes', () => {
    const { document: reconnectDoc, InputElement: ReconnectInput } = renderOnboarding({
      savedServer,
    });
    expect(findLabeledInput(reconnectDoc, ReconnectInput, 'Library name')).toBeNull();
    expect(reconnectDoc.getElementById('kavita-auth-key')?.getAttribute('autocomplete')).toBe(
      'off',
    );

    const { document: editAddressDoc, InputElement: EditInput } = renderOnboarding({
      savedServer,
      editAddress: true,
    });
    expect(findLabeledInput(editAddressDoc, EditInput, 'Library name')).toBeNull();
    expect(
      findLabeledInput(editAddressDoc, EditInput, 'New Kavita server address')?.getAttribute(
        'autocomplete',
      ),
    ).toBe('url');
    expect(editAddressDoc.getElementById('kavita-auth-key')?.getAttribute('autocomplete')).toBe(
      'off',
    );
  });
});
