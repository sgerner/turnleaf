<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { fade, fly } from 'svelte/transition';
  import { saveServer, type ServerConfig } from '../database/database';
  import { KavitaClient, KavitaError } from '../kavita/client';
  import { normalizeServerUrl, ServerUrlError } from '../kavita/url';
  import { saveApiKey } from '../native/credentials';

  let { onConnected }: { onConnected: (server: ServerConfig) => void } = $props();

  let serverUrl = $state('');
  let displayName = $state('My library');
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
        displayName: displayName.trim() || 'My library',
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
  class="mx-auto flex min-h-dvh max-w-lg flex-col px-6 pb-10 pt-[max(3rem,env(safe-area-inset-top))]"
>
  <header class="mb-10" in:fly={{ y: 10, duration: 220 }}>
    <p class="mb-4 text-xs font-semibold uppercase tracking-[0.28em] text-primary-700">Turnleaf</p>
    <h1 class="font-serif text-5xl leading-[1.04] tracking-tight text-surface-950">
      Your books,<br />quietly at hand.
    </h1>
    <p class="mt-5 max-w-sm text-base leading-relaxed text-surface-600">
      Connect directly to Kavita. Download EPUB books and keep your place across devices.
    </p>
  </header>

  <form class="card preset-outlined-surface-200-800 space-y-5 p-6" onsubmit={connect}>
    <label class="label">
      <span class="label-text">Kavita server</span>
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
      <label class="flex min-h-12 items-start gap-3 text-sm text-warning-900" transition:fade>
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
      <span class="label-text text-xs text-surface-500">
        Create this in Kavita for a dedicated non-administrator account.
      </span>
    </label>

    <label class="label">
      <span class="label-text">Library name <span class="text-surface-400">Optional</span></span>
      <input class="input" autocomplete="organization" bind:value={displayName} />
    </label>

    {#if error}
      <div class="alert preset-tonal-error" role="alert" transition:fade>{error}</div>
    {/if}

    <button class="btn preset-filled-primary-700 w-full" type="submit" disabled={busy}>
      {busy ? 'Testing connection...' : 'Connect to Kavita'}
    </button>
  </form>

  <p class="mt-auto pt-8 text-center text-xs leading-relaxed text-surface-500">
    {#if Capacitor.isNativePlatform()}
      Credentials are stored in your device's secure Keychain or Keystore.
    {:else}
      Browser preview stores credentials locally in this browser only. Use it for development.
    {/if}
  </p>
</main>
