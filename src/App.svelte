<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { onMount } from 'svelte';
  import Onboarding from './lib/components/Onboarding.svelte';
  import Library from './lib/components/Library.svelte';
  import { getServer, type ServerConfig } from './lib/database/database';
  import { getApiKey } from './lib/native/credentials';

  let server = $state<ServerConfig | null>(null);
  let booting = $state(Capacitor.isNativePlatform());
  let startupError = $state('');
  let apiKey = $state<string | null>(null);

  onMount(async () => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const saved = await getServer();
      if (saved) {
        apiKey = await getApiKey(saved.credentialRef);
        if (apiKey) server = saved;
      }
    } catch {
      startupError = 'Local data could not be opened. Your downloaded books were not changed.';
    } finally {
      booting = false;
    }
  });
</script>

{#if booting}
  <main class="grid min-h-dvh place-items-center" aria-label="Opening Turnleaf">
    <p class="text-sm tracking-wide text-surface-500">Opening your library...</p>
  </main>
{:else if server && apiKey}
  <Library {server} {apiKey} />
{:else}
  {#if startupError}
    <div class="alert preset-tonal-error mx-auto mt-6 max-w-lg" role="alert">{startupError}</div>
  {/if}
  <Onboarding
    onConnected={async (connected) => {
      apiKey = await getApiKey(connected.credentialRef);
      server = connected;
    }}
  />
{/if}
