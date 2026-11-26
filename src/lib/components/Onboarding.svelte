<script lang="ts">
  import { untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { saveServer, type ServerConfig } from '../database/database';
  import { KavitaClient, KavitaError } from '../kavita/client';
  import { normalizeServerUrl, ServerUrlError } from '../kavita/url';
  import { removeApiKey, saveApiKey } from '../native/credentials';
  import { getDiagnosticCount, recordDiagnostic, subscribeDiagnostics } from '../diagnostics/log';
  import DiagnosticsPanel from './DiagnosticsPanel.svelte';
  import TurnleafLogo from './TurnleafLogo.svelte';

  let {
    savedServer = null,
    editAddress = false,
    onCancel,
    onConnected,
  }: {
    savedServer?: ServerConfig | null;
    editAddress?: boolean;
    onCancel?: (() => void) | undefined;
    onConnected: (server: ServerConfig, key: string) => void;
  } = $props();

  let serverUrl = $state(untrack(() => (editAddress ? (savedServer?.baseUrl ?? '') : '')));
  let changeServerAddress = $state(untrack(() => editAddress));
  let displayName = $state('Books');
  let apiKey = $state('');
  let allowHttp = $state(false);
  let busy = $state(false);
  let error = $state('');
  let invalidField = $state<'address' | 'key' | null>(null);
  let showKey = $state(false);
  let diagnosticCount = $state(getDiagnosticCount());

  $effect(() =>
    subscribeDiagnostics((count) => {
      diagnosticCount = count;
    }),
  );

  async function saveConnection(
    server: ServerConfig,
    key: string,
    messages: { saveFailed: string; cleanupFailed: string },
  ): Promise<void> {
    try {
      await saveApiKey(server.credentialRef, key);
    } catch (credentialError) {
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/credentials',
        detail: 'credential-save-failed',
      });
      throw credentialError;
    }
    try {
      await saveServer(server);
    } catch (storageError) {
      try {
        await removeApiKey(server.credentialRef);
      } catch (cleanupError) {
        recordDiagnostic({
          category: 'startup',
          endpoint: 'local/credentials',
          detail: 'credential-cleanup-failed',
        });
        throw new Error(messages.cleanupFailed, { cause: cleanupError });
      }
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'server-save-failed',
      });
      throw new Error(messages.saveFailed, { cause: storageError });
    }
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
      if ((!savedServer || changingServerAddress) && normalized.insecure && !allowHttp) {
        recordDiagnostic({
          category: 'validation',
          endpoint: 'local/setup',
          detail: 'insecure-http-blocked',
        });
        throw new Error('Confirm that you accept an unencrypted HTTP connection.');
      }
      const key = apiKey.trim();
      if (!key) {
        invalidField = 'key';
        recordDiagnostic({
          category: 'validation',
          endpoint: 'local/setup',
          detail: 'missing-auth-key',
        });
        throw new Error('Enter a Kavita auth key.');
      }

      const result = await new KavitaClient(normalized.baseUrl, key).testConnection();
      if (result.bookLibraries.length === 0) {
        recordDiagnostic({
          category: 'validation',
          endpoint: '/api/Library/libraries',
          detail: 'no-book-libraries',
        });
        throw new Error(
          'This account has no book or light novel libraries. Other media types are not supported.',
        );
      }

      if (savedServer) {
        let connectedServer = savedServer;
        if (changingServerAddress) {
          const credentialRef = `${savedServer.credentialRef}_${Date.now().toString(36)}`;
          connectedServer = {
            ...savedServer,
            baseUrl: normalized.baseUrl,
            credentialRef,
            kavitaVersion: result.version,
            lastConnectedAt: new Date().toISOString(),
          };
          await saveConnection(connectedServer, key, {
            saveFailed:
              'The new address tested successfully, but local setup could not be saved. The saved connection and auth key were left in place; retry reconnect.',
            cleanupFailed:
              'The new address tested successfully, but local setup could not be saved and the new auth key could not be cleaned up. The saved connection was left in place; retry reconnect.',
          });
          await removeApiKey(savedServer.credentialRef).catch(() => {});
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
        onConnected(connectedServer, key);
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

      await saveConnection(server, key, {
        saveFailed:
          'The connection worked, but local setup could not be saved. No auth key was retained; try again.',
        cleanupFailed:
          'The connection worked, but local setup could not be saved and the auth key could not be cleaned up. Retry setup or remove the server from settings.',
      });
      apiKey = '';
      onConnected(server, key);
    } catch (cause) {
      if (cause instanceof ServerUrlError) {
        invalidField = 'address';
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
      if (cause instanceof KavitaError && cause.kind === 'authentication') invalidField = 'key';
      if (
        cause instanceof KavitaError ||
        cause instanceof ServerUrlError ||
        cause instanceof Error
      ) {
        error = cause.message;
      } else {
        error = 'Turnleaf could not complete setup.';
      }
    } finally {
      unsubscribe();
      busy = false;
    }
  }
</script>

<main
  class="onboarding-main mx-auto flex min-h-full w-full max-w-5xl flex-col lg:grid lg:min-h-full lg:grid-cols-2 lg:items-center lg:gap-16 xl:gap-24"
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
      class="card preset-filled-surface-50-950 space-y-5 p-6 shadow-2xl sm:p-8"
      onsubmit={connect}
    >
      {#if !savedServer || changeServerAddress}
        <label class="label">
          <span class="label-text">
            {savedServer ? 'New Kavita server address' : 'Kavita server address'}
          </span>
          <input
            class="input"
            type="url"
            inputmode="url"
            autocomplete="url"
            placeholder="https://books.example.com"
            bind:value={serverUrl}
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

      {#if savedServer && !editAddress}
        <button
          class="btn btn-sm preset-tonal-surface h-11 self-start"
          type="button"
          disabled={busy}
          onclick={() => {
            changeServerAddress = !changeServerAddress;
            serverUrl = changeServerAddress ? savedServer.baseUrl : '';
            error = '';
            invalidField = null;
          }}
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
            class="input min-w-0 flex-1"
            type={showKey ? 'text' : 'password'}
            autocomplete="off"
            spellcheck="false"
            bind:value={apiKey}
            aria-invalid={invalidField === 'key' || undefined}
            aria-describedby={error ? 'connection-error' : undefined}
            required
          />
          <button
            class="btn preset-tonal-surface"
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
          <input class="input" autocomplete="off" bind:value={displayName} />
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

      <button class="btn btn-lg preset-filled-primary-700-300 w-full" type="submit" disabled={busy}>
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
      {#if onCancel}
        <button
          class="btn preset-tonal-surface w-full"
          type="button"
          onclick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      {/if}
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

<style>
  .onboarding-main {
    padding-top: max(
      3rem,
      calc(
        var(--safe-top, max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px))) +
          0.5rem
      )
    );
    padding-inline-start: max(
      1.5rem,
      var(--safe-left, max(env(safe-area-inset-left, 0px), var(--safe-area-inset-left, 0px)))
    );
    padding-inline-end: max(
      1.5rem,
      var(--safe-right, max(env(safe-area-inset-right, 0px), var(--safe-area-inset-right, 0px)))
    );
    padding-bottom: max(
      2.5rem,
      calc(
        var(
            --safe-bottom,
            max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px))
          ) +
          1rem
      )
    );
  }

  @media (min-width: 40rem) {
    .onboarding-main {
      padding-inline-start: max(
        2rem,
        var(--safe-left, max(env(safe-area-inset-left, 0px), var(--safe-area-inset-left, 0px)))
      );
      padding-inline-end: max(
        2rem,
        var(--safe-right, max(env(safe-area-inset-right, 0px), var(--safe-area-inset-right, 0px)))
      );
    }
  }

  @media (min-width: 64rem) {
    .onboarding-main {
      padding-top: max(
        4rem,
        calc(
          var(--safe-top, max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px))) +
            1rem
        )
      );
      padding-bottom: max(
        4rem,
        calc(
          var(
              --safe-bottom,
              max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px))
            ) +
            1rem
        )
      );
    }
  }
</style>
