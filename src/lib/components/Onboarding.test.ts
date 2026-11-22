// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../database/database';
import Onboarding from './Onboarding.svelte';

const savedServer: ServerConfig = {
  id: 'primary',
  displayName: 'Books',
  baseUrl: 'https://books.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.8',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const mounted: Array<{ instance: Record<string, unknown>; target: HTMLDivElement }> = [];

function mountOnboarding(
  props: {
    savedServer?: ServerConfig | null;
  } = {},
): HTMLDivElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(Onboarding, {
    target,
    props: {
      ...props,
      onConnected: vi.fn(),
    },
  });
  flushSync();
  mounted.push({ instance, target });
  return target;
}

function findLabeledInput(root: ParentNode, labelPrefix: string): HTMLInputElement | null {
  for (const label of root.querySelectorAll('label')) {
    const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text.startsWith(labelPrefix)) {
      continue;
    }
    const htmlFor = label.getAttribute('for');
    if (htmlFor) {
      const target = root.querySelector(`#${CSS.escape(htmlFor)}`);
      return target instanceof HTMLInputElement ? target : null;
    }
    return label.querySelector('input');
  }
  return null;
}

describe('Onboarding autocomplete attributes', () => {
  beforeEach(() => {
    if (typeof Element.prototype.animate !== 'function') {
      Element.prototype.animate = () =>
        ({
          finished: Promise.resolve(),
          cancel: () => {},
          onfinish: null,
        }) as unknown as Animation;
    }
  });

  afterEach(() => {
    for (const { instance, target } of mounted.splice(0)) {
      unmount(instance);
      target.remove();
    }
  });

  it('sets autocomplete attributes and defaults library name to Books during initial setup', () => {
    const root = mountOnboarding();

    const serverAddressInput = findLabeledInput(root, 'Kavita server address');
    expect(serverAddressInput).not.toBeNull();
    expect(serverAddressInput?.getAttribute('autocomplete')).toBe('url');

    const authKeyInput = root.querySelector('#kavita-auth-key');
    expect(authKeyInput).toBeInstanceOf(HTMLInputElement);
    expect(authKeyInput?.getAttribute('autocomplete')).toBe('off');

    const libraryNameInput = findLabeledInput(root, 'Library name Optional');
    expect(libraryNameInput).not.toBeNull();
    expect(libraryNameInput?.getAttribute('class')).toBe('input min-h-11');
    expect(libraryNameInput?.getAttribute('autocomplete')).toBe('off');
    expect(libraryNameInput?.value).toBe('Books');
    expect(root.querySelector('[autocomplete="organization"]')).toBeNull();
  });

  it('hides the library name input during reconnect while preserving autocomplete attributes', () => {
    const root = mountOnboarding({ savedServer });
    expect(findLabeledInput(root, 'Library name')).toBeNull();
    expect(root.querySelector('#kavita-auth-key')?.getAttribute('autocomplete')).toBe('off');

    const changeAddressButton = Array.from(root.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    );
    expect(changeAddressButton).toBeDefined();
    changeAddressButton?.click();
    flushSync();

    expect(findLabeledInput(root, 'Library name')).toBeNull();
    expect(findLabeledInput(root, 'New Kavita server address')?.getAttribute('autocomplete')).toBe(
      'url',
    );
    expect(root.querySelector('#kavita-auth-key')?.getAttribute('autocomplete')).toBe('off');
  });
});
