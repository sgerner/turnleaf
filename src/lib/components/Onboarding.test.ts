import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
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

function renderOnboarding(
  props: {
    savedServer?: ServerConfig | null;
    editAddress?: boolean;
  } = {},
): string {
  return render(Onboarding, {
    props: {
      ...props,
      onConnected: vi.fn(),
    },
  }).body;
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const inner = tag.replace(/^<[a-zA-Z0-9-]+\b/, '').replace(/\/?>$/, '');
  const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
  for (const match of inner.matchAll(attrPattern)) {
    const name = match[1];
    if (name) {
      attributes[name] = match[2] ?? '';
    }
  }
  return attributes;
}

function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findInputById(html: string, id: string): Record<string, string> | null {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (attrs.id === id) {
      return attrs;
    }
  }
  return null;
}

function findLabeledInput(html: string, labelPrefix: string): Record<string, string> | null {
  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    const fullLabel = match[0];
    const content = match[1] ?? '';
    if (!stripTags(content).startsWith(labelPrefix)) {
      continue;
    }
    const labelOpenTag = fullLabel.match(/^<label\b[^>]*>/i)?.[0] ?? '';
    const forId = parseAttributes(labelOpenTag).for;
    if (forId) {
      return findInputById(html, forId);
    }
    const inputMatch = content.match(/<input\b[^>]*>/i);
    return inputMatch ? parseAttributes(inputMatch[0]) : null;
  }
  return null;
}

describe('Onboarding autocomplete attributes', () => {
  it('sets autocomplete attributes and defaults library name to Books during initial setup', () => {
    const body = renderOnboarding();

    const serverAddressInput = findLabeledInput(body, 'Kavita server address');
    expect(serverAddressInput).not.toBeNull();
    expect(serverAddressInput?.autocomplete).toBe('url');

    const authKeyInput = findInputById(body, 'kavita-auth-key');
    expect(authKeyInput).not.toBeNull();
    expect(authKeyInput?.autocomplete).toBe('off');

    const libraryNameInput = findLabeledInput(body, 'Library name Optional');
    expect(libraryNameInput).not.toBeNull();
    expect(libraryNameInput?.class).toBe('input');
    expect(libraryNameInput?.autocomplete).toBe('off');
    expect(libraryNameInput?.value).toBe('Books');
    expect(body).not.toContain('autocomplete="organization"');
  });

  it('hides the library name input during reconnect while preserving autocomplete attributes', () => {
    const reconnectBody = renderOnboarding({ savedServer });
    expect(findLabeledInput(reconnectBody, 'Library name')).toBeNull();
    expect(findInputById(reconnectBody, 'kavita-auth-key')?.autocomplete).toBe('off');

    const editAddressBody = renderOnboarding({ savedServer, editAddress: true });
    expect(findLabeledInput(editAddressBody, 'Library name')).toBeNull();
    expect(findLabeledInput(editAddressBody, 'New Kavita server address')?.autocomplete).toBe(
      'url',
    );
    expect(findInputById(editAddressBody, 'kavita-auth-key')?.autocomplete).toBe('off');
  });
});
