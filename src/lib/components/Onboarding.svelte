<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { focusFirstElement, restoreFocus } from '../a11y/modal-focus';
  import type { ServerConfig } from '../database/database';
  import { getDiagnosticCount, recordDiagnostic, subscribeDiagnostics } from '../diagnostics/log';
  import { KavitaError } from '../kavita/client';
  import {
    ADDRESS_ROTATION_MESSAGES,
    classifyConnectionError,
    INITIAL_SETUP_MESSAGES,
    rotateServerConnection,
    saveConnection,
    verifyKavitaConnection,
    type InvalidConnectionField,
  } from '../kavita/connection';
  import { extractPastedOpdsUrl, normalizeServerUrl, ServerUrlError } from '../kavita/url';
  import { handleOnboardingBack, type RegisterBackHandler } from '../native/back-button';
  import { saveApiKey } from '../native/credentials';
  import DiagnosticsPanel from './DiagnosticsPanel.svelte';
  import TurnleafLogo from './TurnleafLogo.svelte';

  let {
    savedServer = null,
    autoFocus = false,
    previousStaleCredentialRefs = [],
    registerBackHandler,
    onConnected,
  }: {
    savedServer?: ServerConfig | null;
    autoFocus?: boolean;
    previousStaleCredentialRefs?: readonly string[];
    registerBackHandler?: RegisterBackHandler | undefined;
    onConnected: (
      server: ServerConfig,
      key: string,
      staleCredentialRefs?: string[],
      cleanupWarning?: string | null,
    ) => void;
  } = $props();

  let formElement = $state<HTMLFormElement | null>(null);
  let serverUrlInput = $state<HTMLInputElement | null>(null);
  let changeAddressButton = $state<HTMLButtonElement | null>(null);
  let serverUrl = $state('');
  let changeServerAddress = $state(false);
  let displayName = $state('Books');
  let apiKey = $state('');
  let allowHttp = $state(false);
  let busy = $state(false);
  let error = $state('');
  let invalidField = $state<InvalidConnectionField>(null);
  let showKey = $state(false);
  let diagnosticCount = $state(getDiagnosticCount());

  $effect(() =>
    subscribeDiagnostics((count) => {
      diagnosticCount = count;
    }),
  );

  $effect(() => {
    if (!autoFocus) return;
    void tick().then(() => focusFirstElement(formElement));
  });

  onMount(() =>
    registerBackHandler?.(() =>
      handleOnboardingBack({
        busy,
        onCancel:
          savedServer && changeServerAddress ? () => toggleChangeServerAddress(false) : undefined,
      }),
    ),
  );

  function toggleChangeServerAddress(next = !changeServerAddress): void {
    changeServerAddress = next;
    serverUrl = next && savedServer ? savedServer.baseUrl : '';
    allowHttp = false;
    error = '';
    invalidField = null;
    if (next) {
      void tick().then(() => restoreFocus(serverUrlInput));
    } else {
      void tick().then(() => restoreFocus(changeAddressButton));
    }
  }

  function handleServerUrlPaste(event: ClipboardEvent): void {
    const pasted =
      event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text') || '';
    const extracted = extractPastedOpdsUrl(pasted);
    if (!extracted) return;
    event.preventDefault();
    serverUrl = extracted.baseUrl;
    if (!apiKey.trim()) apiKey = extracted.apiKey;
    error = '';
    invalidField = null;
  }

  async function connect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = '';
    invalidField = null;
    busy = true;
    const changingServerAddress = Boolean(savedServer && changeServerAddress);
    let eventsRecorded = -1;
    const unsubscribe = subscribeDiagnostics(() => {
      eventsRecorded += 1;
    });

    try {
      const normalized = normalizeServerUrl(
        savedServer && !changingServerAddress ? savedServer.baseUrl : serverUrl,
      );
      if ((!savedServer || changingServerAddress) && normalized.apiKey) {
        serverUrl = normalized.baseUrl;
        if (!apiKey.trim()) apiKey = normalized.apiKey;
      }
      if ((!savedServer || changingServerAddress) && normalized.insecure && !allowHttp) {
        invalidField = 'address';
        recordDiagnostic({
          category: 'validation',
          endpoint: 'local/setup',
          detail: 'insecure-http-blocked',
        });
        throw new Error('Confirm that you accept an unencrypted HTTP connection.');
      }
      const key = apiKey.trim() || normalized.apiKey || '';
      if (!key) {
        invalidField = 'key';
        recordDiagnostic({
          category: 'validation',
          endpoint: 'local/setup',
          detail: 'missing-auth-key',
        });
        throw new Error('Enter a Kavita auth key.');
      }

      const result = await verifyKavitaConnection(normalized.baseUrl, key);

      if (savedServer) {
        let connectedServer = savedServer;
        let staleCredentialRefs = [...previousStaleCredentialRefs];
        let cleanupWarning: string | null = null;
        if (changingServerAddress) {
          const rotation = await rotateServerConnection(
            savedServer,
            normalized.baseUrl,
            key,
            result.version,
            ADDRESS_ROTATION_MESSAGES,
            previousStaleCredentialRefs,
          );
          connectedServer = rotation.server;
          staleCredentialRefs = rotation.staleCredentialRefs;
          cleanupWarning = rotation.cleanupWarning;
          serverUrl = normalized.baseUrl;
        } else {
          try {
            await saveApiKey(savedServer.credentialRef, key);
          } catch (credentialError) {
            recordDiagnostic({
              category: 'startup',
              endpoint: 'local/credentials',
              detail: 'credential-save-failed',
            });
            throw credentialError;
          }
        }
        apiKey = '';
        onConnected(connectedServer, key, staleCredentialRefs, cleanupWarning);
        return;
      }

      const id = 'primary';
      const credentialRef = `server_${id}_api_key`;
      const server: ServerConfig = {
        id,
        displayName: displayName.trim() || 'Books',
        baseUrl: normalized.baseUrl,
        credentialRef,
        kavitaVersion: result.version,
        lastConnectedAt: new Date().toISOString(),
      };

      await saveConnection(server, key, INITIAL_SETUP_MESSAGES);
      serverUrl = normalized.baseUrl;
      apiKey = '';
      onConnected(server, key);
    } catch (cause) {
      if (cause instanceof ServerUrlError) {
        recordDiagnostic({
          category: 'validation',
          endpoint: 'local/setup',
          detail: 'invalid-server-url',
        });
      } else if (eventsRecorded === 0) {
        if (cause instanceof KavitaError) {
          recordDiagnostic({
            category: cause.kind === 'invalid-response' ? 'response' : 'request',
            endpoint: '/api/Library/libraries',
            ...(cause.status !== undefined ? { status: cause.status } : {}),
            detail: cause.kind,
          });
        } else {
          recordDiagnostic({
            category: 'startup',
            endpoint: 'local/setup',
            detail: 'setup-failed',
          });
        }
      }
      const classified = classifyConnectionError(cause, 'Turnleaf could not complete setup.');
      if (!invalidField) invalidField = classified.invalidField;
      error = classified.message;
    } finally {
      unsubscribe();
      busy = false;
    }
  }
</script>

<main
  class="mx-auto flex min-h-full max-w-5xl flex-col px-6 pb-10 pt-[max(3rem,env(safe-area-inset-top))] sm:px-8 lg:grid lg:min-h-full lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-16 xl:gap-24"
>
  <header class="flex flex-col lg:pr-4" in:fly={{ y: 12, duration: 280 }}>
    <TurnleafLogo size={80} />
    <h1
      class="mt-6 font-serif text-4xl leading-[1.05] tracking-tight text-surface-950-50 sm:text-5xl lg:mt-10 lg:text-6xl"
    >
      {#if savedServer}
        Reconnect to Kavita
      {:else}
        Your books,<br />quietly at hand.
      {/if}
    </h1>
    <p class="mt-5 max-w-md text-base leading-relaxed text-surface-900-100 sm:text-lg">
      {#if savedServer}
        {#if changeServerAddress}
          Enter a new auth key for the server address below to reopen your saved library.
        {:else}
          Enter a new auth key for {savedServer.baseUrl} to reopen your saved library.
        {/if}
      {:else}
        Connect directly to Kavita. Download EPUB books and keep your place across devices.
      {/if}
    </p>
  </header>

  <div class="mt-10 flex flex-col gap-5 lg:mt-0" in:fly={{ y: 12, duration: 280, delay: 80 }}>
    <form
      bind:this={formElement}
      class="card preset-filled-surface-50-950 space-y-5 p-6 shadow-2xl sm:p-8"
      novalidate
      onsubmit={connect}
    >
      {#if !savedServer || changeServerAddress}
        <label class="label">
          <span class="label-text">
            {savedServer ? 'New Kavita server address' : 'Kavita server address'}
          </span>
          <input
            bind:this={serverUrlInput}
            class="input min-h-11"
            type="url"
            inputmode="url"
            autocomplete="url"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            placeholder="https://books.example.com"
            bind:value={serverUrl}
            onpaste={handleServerUrlPaste}
            aria-invalid={invalidField === 'address' || undefined}
            aria-describedby={error ? 'connection-error' : undefined}
            required
          />
        </label>

        {#if serverUrl.trim().toLowerCase().startsWith('http://')}
          <label
            class="card preset-tonal-warning flex min-h-12 items-start gap-3 p-3 text-sm"
            transition:fade
          >
            <input class="checkbox mt-0.5" type="checkbox" bind:checked={allowHttp} />
            <span>
              Allow plain HTTP. Anyone on this network may be able to observe your reading traffic
              and auth key.
            </span>
          </label>
        {/if}
      {:else}
        <div class="label">
          <span class="label-text">Kavita server address</span>
          <span class="text-sm text-surface-700-300">{savedServer.baseUrl}</span>
        </div>
      {/if}

      {#if savedServer}
        <button
          bind:this={changeAddressButton}
          class="btn btn-sm preset-tonal-surface min-h-11 self-start"
          type="button"
          disabled={busy}
          onclick={() => toggleChangeServerAddress()}
        >
          {changeServerAddress ? 'Use saved address' : 'Change server address'}
        </button>
      {/if}

      {#if savedServer && changeServerAddress}
        <p class="text-sm text-surface-700-300">
          Use this only when the new address reaches the same Kavita server and libraries.
        </p>
      {/if}

      <div class="label">
        <label class="label-text" for="kavita-auth-key">Auth key</label>
        <div class="flex gap-2">
          <input
            id="kavita-auth-key"
            class="input min-h-11 min-w-0 flex-1"
            type={showKey ? 'text' : 'password'}
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            bind:value={apiKey}
            aria-invalid={invalidField === 'key' || undefined}
            aria-describedby={error ? 'connection-error' : undefined}
            required
          />
          <button
            class="btn preset-tonal-surface min-h-11 shrink-0"
            type="button"
            onclick={() => (showKey = !showKey)}
          >
            {showKey ? 'Hide key' : 'Show key'}
          </button>
        </div>
        <span class="label-text text-xs text-surface-800-200">
          Create this in Kavita for a dedicated non-administrator account with access only to the
          book or light novel libraries you want on this device.
        </span>
      </div>

      {#if !savedServer}
        <label class="label">
          <span class="label-text">
            Library name <span class="text-surface-600-400">Optional</span>
          </span>
          <input class="input min-h-11" autocomplete="off" bind:value={displayName} />
        </label>
      {/if}

      <div
        id="connection-error"
        role="alert"
        class:card={error}
        class:p-4={error}
        class:preset-tonal-error={error}
      >
        {error}
      </div>

      {#if error || diagnosticCount > 0}
        <DiagnosticsPanel compact kavitaVersion={savedServer?.kavitaVersion} />
      {/if}

      <button
        class="btn btn-lg preset-filled-primary-700-300 min-h-11 w-full"
        type="submit"
        disabled={busy}
      >
        {#if busy}
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 animate-spin">
            <path
              fill="currentColor"
              d="M12 4V2a10 10 0 0 0-7.07 17.07l1.42-1.42A8 8 0 1 1 12 4Z"
            />
          </svg>
          <span>Testing connection…</span>
        {:else}
          <span>{savedServer ? 'Reconnect to Kavita' : 'Connect to Kavita'}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        {/if}
      </button>
    </form>

    <aside class="card preset-tonal-surface p-5" aria-labelledby="getting-started-title">
      <h2 id="getting-started-title" class="font-serif text-xl">Getting started</h2>
      <ol class="mt-3 grid gap-3 text-sm text-surface-800-200">
        <li>
          <strong>1. Connect.</strong> Turnleaf checks the address and key before saving them.
        </li>
        <li>
          <strong>2. Download.</strong> Use a book's download action to keep an EPUB available offline.
        </li>
        <li>
          <strong>3. Resume.</strong> Your reading position is saved locally and can sync when Kavita
          is reachable.
        </li>
      </ol>
    </aside>
  </div>
</main>
