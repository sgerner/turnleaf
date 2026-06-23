<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { fade, fly } from 'svelte/transition';
  import { saveServer, type ServerConfig } from '../database/database';
  import { KavitaClient, KavitaError } from '../kavita/client';
  import { normalizeServerUrl, ServerUrlError } from '../kavita/url';
  import { saveApiKey } from '../native/credentials';
  import TurnleafLogo from './TurnleafLogo.svelte';

  let { onConnected }: { onConnected: (server: ServerConfig) => void } = $props();

  let serverUrl = $state('');
  let displayName = $state('Books');
  let apiKey = $state('');
  let allowHttp = $state(false);
  let busy = $state(false);
  let error = $state('');

  async function connect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = '';
    busy = true;

    try {
      const normalized = normalizeServerUrl(serverUrl);
      if (normalized.insecure && !allowHttp) {
        throw new Error('Confirm that you accept an unencrypted HTTP connection.');
      }
      if (!apiKey.trim()) throw new Error('Enter a Kavita auth key.');

      const result = await new KavitaClient(normalized.baseUrl, apiKey.trim()).testConnection();
      if (result.bookLibraries.length === 0) {
        throw new Error('This account has no book libraries. Other media types are not supported.');
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

      await saveApiKey(credentialRef, apiKey.trim());
      try {
        await saveServer(server);
      } catch (storageError) {
        throw new Error('The connection worked, but local setup could not be saved.', {
          cause: storageError,
        });
      }
      apiKey = '';
      onConnected(server);
    } catch (cause) {
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
      Your books,<br />quietly at hand.
    </h1>
    <p class="mt-5 max-w-md text-base leading-relaxed text-surface-900-100 sm:text-lg">
      Connect directly to Kavita. Download EPUB books and keep your place across devices.
    </p>
  </header>

  <div class="mt-10 flex flex-col gap-5 lg:mt-0" in:fly={{ y: 12, duration: 280, delay: 80 }}>
    <form
      class="card preset-filled-surface-50-950 space-y-5 p-6 shadow-2xl sm:p-8"
      onsubmit={connect}
    >
      <label class="label">
        <span class="label-text">Kavita server address</span>
        <input
          class="input"
          type="url"
          inputmode="url"
          autocomplete="url"
          placeholder="https://books.example.com"
          bind:value={serverUrl}
          required
        />
      </label>

      {#if serverUrl.trim().toLowerCase().startsWith('http://')}
        <label
          class="card preset-tonal-warning flex min-h-12 items-start gap-3 p-3 text-sm"
          transition:fade
        >
          <input class="checkbox mt-0.5" type="checkbox" bind:checked={allowHttp} />
          <span
            >Allow plain HTTP. Anyone on this network may be able to observe your reading traffic.</span
          >
        </label>
      {/if}

      <label class="label">
        <span class="label-text">Auth key</span>
        <input
          class="input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          bind:value={apiKey}
          required
        />
        <span class="label-text text-xs text-surface-800-200">
          Create this in Kavita for a dedicated non-administrator account.
        </span>
      </label>

      <label class="label">
        <span class="label-text">
          Library name <span class="text-surface-600-400">Optional</span></span
        >
        <input class="input" autocomplete="organization" bind:value={displayName} />
      </label>

      {#if error}
        <div class="card preset-tonal-error p-4" role="alert" transition:fade>{error}</div>
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
          <span>Connect to Kavita</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        {/if}
      </button>
    </form>
  </div>
</main>
