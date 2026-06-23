<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import Onboarding from './lib/components/Onboarding.svelte';
  import Library from './lib/components/Library.svelte';
  import TurnleafLogo from './lib/components/TurnleafLogo.svelte';
  import { fetchLatestGithubRelease, type ReleaseBanner } from './lib/github/releases';
  import {
    getPreference,
    getServer,
    resetLocalDatabase,
    setPreference,
    type ServerConfig,
  } from './lib/database/database';
  import { getApiKey } from './lib/native/credentials';

  const themePreferenceKey = 'uiTheme';
  const modePreferenceKey = 'uiMode';
  const defaultTheme = 'fennec';
  const defaultMode = 'dark';

  let server = $state<ServerConfig | null>(null);
  let booting = $state(Capacitor.isNativePlatform());
  let startupError = $state('');
  let repairing = $state(false);
  let apiKey = $state<string | null>(null);
  let uiTheme = $state(defaultTheme);
  let uiMode = $state<'light' | 'dark'>(defaultMode);
  let releaseBanner = $state<ReleaseBanner | null>(null);

  onMount(async () => {
    void checkForRelease();
    try {
      const saved = await getServer();
      const savedTheme = await getPreference(themePreferenceKey);
      const savedMode = await getPreference(modePreferenceKey);
      uiTheme = savedTheme ?? defaultTheme;
      uiMode = savedMode === 'light' ? 'light' : 'dark';
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

  async function repairLocalData(): Promise<void> {
    repairing = true;
    startupError = '';
    try {
      await resetLocalDatabase();
    } catch {
      startupError = 'Local data could not be reset. Try reinstalling the app.';
      return;
    } finally {
      repairing = false;
    }
  }

  async function checkForRelease(): Promise<void> {
    const latest = await fetchLatestGithubRelease(__APP_VERSION__);
    if (latest) releaseBanner = latest;
  }

  function displayVersion(version: string): string {
    return version.split('+', 1)[0] ?? version;
  }

  $effect(() => {
    document.documentElement.dataset.theme = uiTheme;
    document.documentElement.dataset.mode = uiMode;
    if (booting) return;
    void setPreference(themePreferenceKey, uiTheme);
    void setPreference(modePreferenceKey, uiMode);
  });
</script>

<div class="app-shell">
  <div class="app-ambient" aria-hidden="true">
    <div class="orb orb-primary"></div>
    <div class="orb orb-secondary"></div>
    <div class="orb orb-tertiary"></div>
    <div class="mesh"></div>
    <div class="vignette"></div>
  </div>

  <div class="app-stage">
    {#if releaseBanner}
      <div class="sticky top-0 z-20 mx-auto w-full max-w-4xl px-4 pt-4" transition:fade>
        <div
          class="flex flex-col gap-3 rounded-2xl preset-filled-surface-50-950 px-4 py-3 shadow-2xl sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="text-xs uppercase tracking-[0.3em] text-surface-700-300">Update available</p>
            <p class="mt-1 font-medium text-surface-950-50">
              Turnleaf {displayVersion(releaseBanner.version)}{releaseBanner.title
                ? ` · ${releaseBanner.title}`
                : ''}
            </p>
            <p class="text-sm text-surface-700-300">A newer GitHub release was found at startup.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {#if releaseBanner.downloadUrl}
              <a
                class="btn btn-sm preset-filled-success-500 !text-sm"
                href={releaseBanner.downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                Download APK
              </a>
            {/if}
            <a
              class="btn btn-sm preset-filled-tertiary-500 !text-sm"
              href={releaseBanner.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              Release notes
            </a>
            <button
              class="btn btn-sm preset-tonal-error !text-sm"
              type="button"
              onclick={() => (releaseBanner = null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if booting}
      <main class="grid min-h-full place-items-center" aria-label="Opening Turnleaf">
        <div class="grid justify-items-center gap-4">
          <TurnleafLogo size={104} />
          <p class="text-sm tracking-wide text-surface-700-300">Opening your library...</p>
        </div>
      </main>
    {:else if server && apiKey}
      <Library
        {server}
        {apiKey}
        theme={uiTheme}
        mode={uiMode}
        onThemeChange={(value) => (uiTheme = value)}
        onModeChange={(value) => (uiMode = value)}
        onApiKeyChange={(value) => (apiKey = value)}
        onServerDeleted={() => {
          server = null;
          apiKey = null;
        }}
      />
    {:else}
      {#if startupError}
        <div
          class="alert preset-tonal-error mx-auto mt-6 max-w-lg flex flex-col gap-3"
          role="alert"
        >
          <p>{startupError}</p>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-sm preset-filled-error-500 !text-sm"
              type="button"
              disabled={repairing}
              onclick={repairLocalData}
            >
              {repairing ? 'Resetting...' : 'Reset local data'}
            </button>
          </div>
        </div>
      {/if}
      <Onboarding
        onConnected={async (connected) => {
          apiKey = await getApiKey(connected.credentialRef);
          server = connected;
        }}
      />
    {/if}
  </div>
</div>

<style>
  .app-shell {
    position: fixed;
    inset: 0;
    isolation: isolate;
    overflow: hidden;
    background-color: color-mix(
      in oklab,
      var(--body-background-color) 72%,
      var(--color-surface-50-950) 28%
    );
    background:
      radial-gradient(
        circle at 18% 16%,
        color-mix(in oklab, var(--color-primary-300-700) 42%, var(--color-surface-50-950) 58%),
        transparent 44%
      ),
      radial-gradient(
        circle at 82% 18%,
        color-mix(in oklab, var(--color-secondary-300-700) 34%, var(--color-surface-50-950) 66%),
        transparent 42%
      ),
      radial-gradient(
        circle at 52% 80%,
        color-mix(in oklab, var(--color-tertiary-300-700) 38%, var(--color-surface-50-950) 62%),
        transparent 46%
      ),
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--color-surface-100-900) 30%, transparent),
        transparent 30%,
        transparent 70%,
        color-mix(in oklab, var(--color-surface-50-950) 20%, transparent)
      );
  }

  :global([data-mode='dark']) .app-shell {
    background-color: color-mix(
      in oklab,
      var(--body-background-color-dark) 92%,
      var(--color-surface-950) 8%
    );
    background:
      radial-gradient(
        circle at 18% 16%,
        color-mix(in oklab, var(--color-primary-300-700) 74%, var(--color-surface-950) 26%),
        transparent 38%
      ),
      radial-gradient(
        circle at 82% 18%,
        color-mix(in oklab, var(--color-secondary-300-700) 64%, var(--color-surface-950) 36%),
        transparent 36%
      ),
      radial-gradient(
        circle at 52% 80%,
        color-mix(in oklab, var(--color-tertiary-300-700) 70%, var(--color-surface-950) 30%),
        transparent 40%
      ),
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--color-surface-50-950) 72%, transparent),
        transparent 28%,
        transparent 66%,
        color-mix(in oklab, var(--color-surface-50-950) 46%, transparent)
      );
  }

  .app-ambient {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 0;
  }

  .orb {
    position: absolute;
    border-radius: 9999px;
    opacity: 0.66;
    transform: translate3d(0, 0, 0);
    will-change: transform;
  }

  .orb-primary {
    width: clamp(14rem, 28vw, 26rem);
    height: clamp(14rem, 28vw, 26rem);
    left: 8vw;
    top: 12vh;
    background: radial-gradient(
      circle at 32% 30%,
      color-mix(in oklab, var(--color-primary-300-700) 58%, var(--color-surface-50-950) 42%),
      transparent 66%
    );
  }

  .orb-secondary {
    width: clamp(12rem, 24vw, 22rem);
    height: clamp(12rem, 24vw, 22rem);
    right: 10vw;
    top: 20vh;
    background: radial-gradient(
      circle at 38% 34%,
      color-mix(in oklab, var(--color-secondary-300-700) 46%, var(--color-surface-50-950) 54%),
      transparent 68%
    );
  }

  .orb-tertiary {
    width: clamp(12rem, 22vw, 20rem);
    height: clamp(12rem, 22vw, 20rem);
    left: 24vw;
    bottom: 10vh;
    background: radial-gradient(
      circle at 36% 34%,
      color-mix(in oklab, var(--color-tertiary-300-700) 52%, var(--color-surface-50-950) 48%),
      transparent 68%
    );
  }

  .mesh {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(
        to bottom,
        color-mix(in oklab, var(--color-surface-100-900) 8%, transparent) 1px,
        transparent 1px
      ),
      linear-gradient(
        to right,
        color-mix(in oklab, var(--color-surface-100-900) 6%, transparent) 1px,
        transparent 1px
      );
    background-size:
      100% 100%,
      100% 100%;
    opacity: 0.12;
    mask-image: radial-gradient(circle at center, black 44%, transparent 100%);
  }

  .vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      circle at center,
      transparent 42%,
      color-mix(in oklab, var(--color-surface-50-950) 48%, transparent) 100%
    );
  }

  .app-stage {
    position: relative;
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    z-index: 1;
  }

  :global([data-mode='dark']) .orb {
    opacity: 0.84;
  }

  :global([data-mode='dark']) .orb-primary {
    background: radial-gradient(
      circle at 32% 30%,
      color-mix(in oklab, var(--color-primary-300-700) 82%, var(--color-surface-950) 18%),
      transparent 62%
    );
  }

  :global([data-mode='dark']) .orb-secondary {
    background: radial-gradient(
      circle at 38% 34%,
      color-mix(in oklab, var(--color-secondary-300-700) 74%, var(--color-surface-950) 26%),
      transparent 60%
    );
  }

  :global([data-mode='dark']) .orb-tertiary {
    background: radial-gradient(
      circle at 36% 34%,
      color-mix(in oklab, var(--color-tertiary-300-700) 78%, var(--color-surface-950) 22%),
      transparent 60%
    );
  }

  :global([data-mode='dark']) .mesh {
    opacity: 0.06;
    mask-image: radial-gradient(circle at center, black 46%, transparent 100%);
  }

  :global([data-mode='dark']) .vignette {
    background: radial-gradient(
      circle at center,
      transparent 38%,
      color-mix(in oklab, var(--color-surface-950) 74%, transparent) 100%
    );
  }

  @media (prefers-reduced-motion: no-preference) {
    .orb-primary {
      animation: drift-primary 42s ease-in-out infinite alternate;
    }

    .orb-secondary {
      animation: drift-secondary 56s ease-in-out infinite alternate;
    }

    .orb-tertiary {
      animation: drift-tertiary 64s ease-in-out infinite alternate;
    }
  }

  @keyframes drift-primary {
    from {
      transform: translate3d(0, 0, 0) scale(1);
    }

    to {
      transform: translate3d(2rem, 1.25rem, 0) scale(1.05);
    }
  }

  @keyframes drift-secondary {
    from {
      transform: translate3d(0, 0, 0) scale(1);
    }

    to {
      transform: translate3d(-1.5rem, 1rem, 0) scale(1.04);
    }
  }

  @keyframes drift-tertiary {
    from {
      transform: translate3d(0, 0, 0) scale(1);
    }

    to {
      transform: translate3d(1rem, -1.25rem, 0) scale(1.03);
    }
  }
</style>
