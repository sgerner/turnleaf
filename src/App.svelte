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

<div class="app-shell">
  <div class="app-ambient" aria-hidden="true">
    <div class="orb orb-primary"></div>
    <div class="orb orb-secondary"></div>
    <div class="orb orb-tertiary"></div>
    <div class="mesh"></div>
    <div class="vignette"></div>
  </div>

  <div class="app-stage">
    {#if booting}
      <main class="grid min-h-dvh place-items-center" aria-label="Opening Turnleaf">
        <p class="text-sm tracking-wide text-surface-700-300">Opening your library...</p>
      </main>
    {:else if server && apiKey}
      <Library {server} {apiKey} />
    {:else}
      {#if startupError}
        <div class="alert preset-tonal-error mx-auto mt-6 max-w-lg" role="alert">
          {startupError}
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
    position: relative;
    min-height: 100dvh;
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
    opacity: 0.72;
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
    opacity: 0.16;
    mask-image: radial-gradient(circle at center, black 38%, transparent 100%);
  }

  .vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      circle at center,
      transparent 34%,
      color-mix(in oklab, var(--color-surface-50-950) 56%, transparent) 100%
    );
  }

  .app-stage {
    position: relative;
    z-index: 1;
  }

  :global([data-mode='dark']) .orb {
    opacity: 0.92;
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
    opacity: 0.08;
    mask-image: radial-gradient(circle at center, black 40%, transparent 100%);
  }

  :global([data-mode='dark']) .vignette {
    background: radial-gradient(
      circle at center,
      transparent 28%,
      color-mix(in oklab, var(--color-surface-950) 84%, transparent) 100%
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
