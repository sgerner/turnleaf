<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { onMount, untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { focusModal, trapModalKeydown } from '../a11y/modal-focus';
  import {
    removeServer,
    saveServer,
    setPreference,
    type BookRecord,
    type ServerConfig,
  } from '../database/database';
  import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
  import { KavitaClient } from '../kavita/client';
  import { removeApiKey, saveApiKey } from '../native/credentials';
  import { loadTheme, skeletonThemes, type SkeletonTheme } from '../themes/themes';

  let {
    server,
    books,
    downloadingBookId,
    cleanupInProgress,
    pendingTheme,
    pendingMode,
    pendingAutoSync,
    credentialCleanupComplete,
    diagnosticsRevision,
    onClose,
    onThemeSelected,
    onModeSelected,
    onAutoSyncSelected,
    onChangeServerAddress,
    onApiKeySaved,
    onClearCache,
    onRemoveAllDownloads,
    onDeleteServerResources,
    onCredentialCleanedUp,
    onServerRemoved,
  }: {
    server: ServerConfig;
    books: BookRecord[];
    downloadingBookId: string | null;
    cleanupInProgress: boolean;
    pendingTheme: SkeletonTheme;
    pendingMode: 'light' | 'dark';
    pendingAutoSync: boolean;
    credentialCleanupComplete: boolean;
    diagnosticsRevision: number;
    onClose: () => void;
    onThemeSelected: (theme: SkeletonTheme) => void;
    onModeSelected: (mode: 'light' | 'dark') => void;
    onAutoSyncSelected: (autoSync: boolean) => void;
    onChangeServerAddress: () => void;
    onApiKeySaved: (nextKey: string) => Promise<void>;
    onClearCache: () => Promise<void>;
    onRemoveAllDownloads: () => Promise<void>;
    onDeleteServerResources: () => Promise<void>;
    onCredentialCleanedUp: () => void;
    onServerRemoved: () => void;
  } = $props();

  let settingsDialog = $state<HTMLElement | null>(null);
  let diagnosticsVisible = $state(false);
  let diagnosticsOutput = $state('');
  let diagnosticsMessage = $state('');
  let replacementApiKey = $state('');
  let showReplacementKey = $state(false);
  let settingsError = $state('');
  let replacingApiKey = $state(false);
  let deletingServer = $state(false);
  let confirmDeleteServer = $state(false);

  onMount(() => {
    void Promise.allSettled(skeletonThemes.map(loadTheme));
    focusModal(() => settingsDialog);
  });

  $effect(() => {
    if (diagnosticsVisible && diagnosticsRevision >= 0) {
      diagnosticsOutput = untrack(() => diagnosticsText());
    }
  });

  function insecureServer(): boolean {
    return server.baseUrl.toLowerCase().startsWith('http://');
  }

  function diagnosticsText(): string {
    return exportDiagnostics({
      appVersion: __APP_VERSION__,
      platform: Capacitor.getPlatform(),
      kavitaVersion: server.kavitaVersion,
    });
  }

  async function copyDiagnostics(): Promise<void> {
    diagnosticsMessage = '';
    diagnosticsOutput = diagnosticsText();
    try {
      const text = diagnosticsOutput;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        let copied = false;
        try {
          field.select();
          copied = document.execCommand('copy');
        } finally {
          field.remove();
        }
        if (!copied) throw new Error('Clipboard unavailable');
      }
      diagnosticsMessage = 'Diagnostics copied. Review them before sharing.';
    } catch {
      diagnosticsVisible = true;
      diagnosticsMessage =
        'Copy is unavailable here. Open the log below to select and copy it, or download it.';
    }
  }

  function downloadDiagnostics(): void {
    diagnosticsMessage = '';
    diagnosticsOutput = diagnosticsText();
    const file = new Blob([diagnosticsOutput], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'turnleaf-diagnostics.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    diagnosticsVisible = true;
    diagnosticsMessage =
      'Review the log before sharing. If the file did not download, select and copy it below.';
  }

  function showDiagnostics(): void {
    diagnosticsOutput = diagnosticsText();
    diagnosticsVisible = !diagnosticsVisible;
  }

  function selectDiagnostics(): void {
    const field = document.querySelector<HTMLTextAreaElement>('#turnleaf-diagnostics-output');
    field?.focus();
    field?.select();
  }

  function clearDiagnosticLog(): void {
    clearDiagnostics();
    diagnosticsOutput = diagnosticsText();
    diagnosticsMessage = 'Diagnostics cleared.';
  }

  async function updateTheme(next: SkeletonTheme): Promise<void> {
    try {
      await loadTheme(next);
    } catch {
      settingsError = 'The theme could not load. Try again.';
      return;
    }
    onThemeSelected(next);
    await setPreference('uiTheme', next);
  }

  async function updateMode(next: 'light' | 'dark'): Promise<void> {
    onModeSelected(next);
    await setPreference('uiMode', next);
  }

  async function updateAutoSync(next: boolean): Promise<void> {
    onAutoSyncSelected(next);
    await setPreference('syncFurthest', String(next));
  }

  async function updateApiKey(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    settingsError = '';
    replacingApiKey = true;
    try {
      const nextKey = replacementApiKey.trim();
      if (!nextKey) throw new Error('Enter a new Kavita auth key.');

      const result = await new KavitaClient(server.baseUrl, nextKey).testConnection();
      if (result.bookLibraries.length === 0) {
        throw new Error(
          'This account has no book or light novel libraries. Only EPUB books are supported.',
        );
      }

      const updatedServer: ServerConfig = {
        ...server,
        kavitaVersion: result.version,
        lastConnectedAt: new Date().toISOString(),
      };
      await saveApiKey(server.credentialRef, nextKey);
      await saveServer(updatedServer);
      replacementApiKey = '';
      await onApiKeySaved(nextKey);
    } catch (cause) {
      settingsError =
        cause instanceof Error ? cause.message : 'Turnleaf could not update the API key.';
    } finally {
      replacingApiKey = false;
    }
  }

  async function deleteServer(): Promise<void> {
    settingsError = '';
    deletingServer = true;
    let credentialsRemoved = credentialCleanupComplete;
    try {
      await onDeleteServerResources();
      if (!credentialsRemoved) {
        await removeApiKey(server.credentialRef);
        credentialsRemoved = true;
        onCredentialCleanedUp();
      }
      await removeServer(server.id);
      onServerRemoved();
    } catch (cause) {
      settingsError = credentialsRemoved
        ? 'The auth key was removed, but the local server configuration could not be cleared. Retry Delete server to finish cleanup.'
        : cause instanceof Error
          ? `Could not remove the server safely: ${cause.message} The connection was left in place; retry Delete server.`
          : 'Could not remove the server safely. The connection was left in place; retry Delete server.';
    } finally {
      deletingServer = false;
      confirmDeleteServer = false;
    }
  }
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4"
  role="presentation"
  transition:fade
  onclick={(event) => event.target === event.currentTarget && onClose()}
>
  <div
    bind:this={settingsDialog}
    class="card preset-filled-surface-50-950 relative max-h-[88dvh] w-full max-w-md overflow-auto p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="library-settings-title"
    tabindex="-1"
    onkeydown={(event) => trapModalKeydown(event, settingsDialog!, onClose)}
    transition:fly={{ y: 16, duration: 150 }}
  >
    <div
      class="sticky top-0 z-10 -mx-6 -mt-6 mb-6 flex items-center justify-between gap-3 bg-inherit px-6 pb-3 pt-6"
    >
      <h2 id="library-settings-title" class="font-serif text-3xl">Settings</h2>
      <button
        class="btn btn-sm preset-tonal-surface h-11 w-11 shrink-0 p-0"
        type="button"
        onclick={onClose}
        aria-label="Close settings"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
          <path
            fill="currentColor"
            d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
          />
        </svg>
      </button>
    </div>

    <section class="mt-6" aria-labelledby="library-settings-appearance-title">
      <h3 id="library-settings-appearance-title" class="text-lg font-medium">
        Application appearance
      </h3>
      <p class="mt-1 text-sm text-surface-700-300">
        Choose the colors and theme that make reading comfortable. Changes apply immediately.
      </p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <button
          class="btn {pendingMode === 'light'
            ? 'preset-filled-primary-700-300'
            : 'preset-tonal-surface'}"
          type="button"
          aria-pressed={pendingMode === 'light'}
          onclick={() => void updateMode('light')}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"
            />
          </svg>
          Light
        </button>
        <button
          class="btn {pendingMode === 'dark'
            ? 'preset-filled-primary-700-300'
            : 'preset-tonal-surface'}"
          type="button"
          aria-pressed={pendingMode === 'dark'}
          onclick={() => void updateMode('dark')}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
            />
          </svg>
          Dark
        </button>
      </div>

      <p class="mt-6 text-xs uppercase tracking-wider text-surface-700-300">Theme palette</p>
      <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Theme palette">
        {#each skeletonThemes as option (option)}
          <button
            class="relative inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-md {pendingTheme ===
            option
              ? 'preset-filled-primary-700-300 ring-2 ring-primary-500 ring-offset-2'
              : 'preset-tonal-surface'}"
            type="button"
            aria-pressed={pendingTheme === option}
            aria-label={`Use ${option} theme`}
            title={option}
            onclick={() => void updateTheme(option)}
          >
            <span class="flex h-full w-full" data-theme={option}>
              <span class="h-full flex-1" style:background-color="var(--color-primary-500)"></span>
              <span class="h-full flex-1" style:background-color="var(--color-secondary-500)"
              ></span>
              <span class="h-full flex-1" style:background-color="var(--color-tertiary-500)"></span>
            </span>
            {#if pendingTheme === option}
              <span class="absolute inset-0 grid place-items-center bg-black/20" aria-hidden="true">
                <svg viewBox="0 0 24 24" class="h-5 w-5 drop-shadow" fill="white">
                  <path d="m9 16.2-3.5-3.5L4 14.2l5 5 11-11-1.5-1.4z" />
                </svg>
              </span>
            {/if}
          </button>
        {/each}
      </div>

      <p class="mt-6 text-xs uppercase tracking-wider text-surface-700-300">Sync</p>
      <p class="mt-1 text-sm text-surface-700-300">
        Turnleaf always saves your latest position on this device. Auto-sync furthest read also lets
        a newer local position replace an older Kavita position when progress is uploaded.
      </p>
      <div
        class="mt-2 flex min-h-12 items-center justify-between gap-4 rounded-xl preset-tonal-surface px-3 py-3"
      >
        <span class="min-w-0 flex-1 font-medium text-surface-950-50">Auto-sync furthest read</span>
        <button
          class="switch-button"
          type="button"
          role="switch"
          aria-checked={pendingAutoSync}
          aria-label="Auto-sync furthest read"
          onclick={() => void updateAutoSync(!pendingAutoSync)}
        >
          <span
            class={`switch-track ${pendingAutoSync ? 'switch-checked' : ''} ${
              pendingAutoSync ? 'preset-filled-primary-700-300' : 'preset-filled-secondary-700-300'
            }`}
            aria-hidden="true"
          >
            <span class="switch-thumb preset-filled-tertiary-100-900"></span>
          </span>
        </button>
      </div>
    </section>

    <section class="mt-7" aria-labelledby="library-settings-connection-title">
      <h3 id="library-settings-connection-title" class="text-lg font-medium">Connection</h3>
      <p class="mt-1 text-sm text-surface-700-300">
        Update the server address or replace the key used to access this library.
      </p>
      <dl class="mt-3 space-y-2 text-sm">
        <div class="flex items-center justify-between gap-3">
          <dt class="text-surface-700-300">Server</dt>
          <dd class="truncate text-right">{server.displayName}</dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-surface-700-300">Address</dt>
          <dd class="truncate text-right">{server.baseUrl}</dd>
        </div>
      </dl>
      <button
        class="btn preset-tonal-surface mt-3"
        type="button"
        disabled={Boolean(downloadingBookId) ||
          cleanupInProgress ||
          replacingApiKey ||
          deletingServer}
        onclick={onChangeServerAddress}
      >
        Change server address
      </button>
      {#if insecureServer()}
        <div class="alert preset-tonal-warning mt-4" role="alert">
          Plain HTTP is enabled. Anyone on this network may be able to observe your reading traffic
          and Kavita auth key. HTTPS is strongly recommended.
        </div>
      {/if}

      <form class="mt-4 grid gap-3" onsubmit={updateApiKey}>
        <div class="label">
          <label for="replacement-api-key" class="label-text">Replace API key</label>
          <div class="flex flex-wrap gap-2">
            <input
              id="replacement-api-key"
              class="input min-w-0 flex-1 max-w-96"
              type={showReplacementKey ? 'text' : 'password'}
              spellcheck="false"
              autocomplete="off"
              bind:value={replacementApiKey}
              placeholder="Enter a new Kavita key"
              aria-invalid={settingsError ? true : undefined}
              aria-describedby={settingsError ? 'settings-key-error' : undefined}
              required
            />
            <button
              class="btn preset-tonal-surface"
              type="button"
              onclick={() => (showReplacementKey = !showReplacementKey)}
            >
              {showReplacementKey ? 'Hide key' : 'Show key'}
            </button>
            <button
              class="btn preset-filled-primary-700-300 shrink-0"
              type="submit"
              disabled={replacingApiKey}
            >
              {replacingApiKey ? 'Testing...' : 'Save'}
            </button>
          </div>
          <span class="label-text text-xs text-surface-700-300">
            The new key is tested before it is saved.
          </span>
        </div>
        <div
          id="settings-key-error"
          role="alert"
          class:alert={settingsError}
          class:preset-tonal-error={settingsError}
        >
          {settingsError}
        </div>
        <button
          class="btn preset-tonal-error"
          type="button"
          onclick={() => (confirmDeleteServer = true)}
          disabled={deletingServer}
        >
          Delete server
        </button>
      </form>
    </section>

    <section class="mt-7" aria-labelledby="library-settings-storage-title">
      <h3 id="library-settings-storage-title" class="text-lg font-medium">
        Storage and maintenance
      </h3>
      <p class="mt-1 text-sm text-surface-700-300">
        Downloads and reading progress stay on this device. Clearing covers is safe; removing
        downloads deletes local EPUB files but does not change Kavita.
      </p>
      <div class="mt-3 grid gap-2">
        <button
          class="btn preset-outlined-error-500"
          type="button"
          onclick={() => void onClearCache()}
        >
          Clear cover cache
        </button>
        <button
          class="btn preset-tonal-error"
          type="button"
          disabled={Boolean(downloadingBookId) || !books.some((book) => book.downloadPath)}
          onclick={() => void onRemoveAllDownloads()}
        >
          Remove all downloaded books
        </button>
      </div>
      <dl class="mt-4 text-sm">
        <div class="flex items-center justify-between gap-3">
          <dt class="text-surface-700-300">Downloaded storage</dt>
          <dd class="tabular-nums">
            {(
              books.reduce((sum, book) => sum + (book.downloadPath ? (book.fileSize ?? 0) : 0), 0) /
              1_048_576
            ).toFixed(1)} MB
          </dd>
        </div>
      </dl>
    </section>
    <section class="mt-7" aria-labelledby="library-settings-diagnostics-title">
      <h3 id="library-settings-diagnostics-title" class="text-lg font-medium">Diagnostics</h3>
      <p class="mt-1 text-sm text-surface-700-300">
        Copy or download recent connection and book download details. The log includes API routes,
        HTTP statuses, and failure categories. It stays in memory until the app closes or you clear
        it. Review it before sharing.
      </p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <button
          class="btn preset-tonal-surface"
          type="button"
          onclick={() => void copyDiagnostics()}
        >
          Copy diagnostics
        </button>
        <button class="btn preset-tonal-surface" type="button" onclick={downloadDiagnostics}>
          Download log
        </button>
      </div>
      <button class="btn preset-tonal-surface mt-2 w-full" type="button" onclick={showDiagnostics}>
        {diagnosticsVisible ? 'Hide diagnostics' : 'View diagnostics'}
      </button>
      {#if diagnosticsVisible}
        <div class="mt-3 grid gap-2">
          <p class="text-sm text-surface-700-300">
            If copy or download is unavailable, select all text below, then copy it manually.
          </p>
          <textarea
            id="turnleaf-diagnostics-output"
            class="input min-h-48 w-full font-mono text-xs"
            readonly
            rows="10"
            bind:value={diagnosticsOutput}
            aria-label="Turnleaf diagnostics log"
            onclick={selectDiagnostics}></textarea>
          <button class="btn preset-tonal-surface" type="button" onclick={selectDiagnostics}>
            Select all text
          </button>
        </div>
      {/if}
      <button
        class="btn preset-tonal-surface mt-2 w-full"
        type="button"
        onclick={clearDiagnosticLog}
      >
        Clear diagnostics
      </button>
      {#if diagnosticsMessage}
        <p class="mt-2 text-sm text-surface-700-300" role="status">{diagnosticsMessage}</p>
      {/if}
    </section>
    {#if confirmDeleteServer}
      <div class="mt-7 rounded-xl border border-error-500/35 p-4" transition:fade>
        <p class="text-sm font-medium text-error-700-300">Delete this server?</p>
        <p class="mt-2 text-sm text-surface-700-300">
          This removes the server connection, downloaded books, cached covers, and local progress
          from this device.
        </p>
        <div class="mt-4 flex gap-2">
          <button
            class="btn preset-outlined-error-500"
            type="button"
            onclick={() => void deleteServer()}
            disabled={deletingServer}
          >
            {deletingServer ? 'Deleting...' : 'Delete now'}
          </button>
          <button
            class="btn preset-tonal-surface"
            type="button"
            onclick={() => (confirmDeleteServer = false)}
            disabled={deletingServer}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .switch-track {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 3rem;
    height: 1.75rem;
    flex: none;
    border-radius: 9999px;
    border: 1px solid color-mix(in srgb, var(--color-primary-900) 35%, transparent);
    padding: 0.2rem;
    box-shadow:
      inset 0 1px 1px hsl(0 0% 100% / 0.08),
      0 1px 4px hsl(0 0% 0% / 0.2);
    cursor: pointer;
    transition:
      background-color 160ms ease,
      border-color 160ms ease,
      box-shadow 160ms ease;
  }

  .switch-button {
    display: inline-grid;
    width: 3rem;
    height: 2.75rem;
    flex: none;
    place-items: center;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }

  .switch-thumb {
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 9999px;
    box-shadow:
      inset 0 1px 1px hsl(0 0% 100% / 0.3),
      0 1px 2px hsl(0 0% 0% / 0.28);
    transform: translateX(0);
    transition: transform 160ms ease;
  }

  .switch-checked .switch-thumb {
    transform: translateX(1.2rem);
  }
</style>
