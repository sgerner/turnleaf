<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { trapModalKeydown } from '../a11y/modal-focus';

  let {
    labelledBy,
    onClose,
    dialogElement = $bindable<HTMLElement | null>(null),
    header,
    children,
  }: {
    labelledBy: string;
    onClose: () => void;
    dialogElement?: HTMLElement | null;
    header: Snippet;
    children: Snippet;
  } = $props();
</script>

<div
  class="dialog-backdrop fixed inset-0 z-50 grid place-items-center bg-black/55"
  role="presentation"
  transition:fade
  onclick={(event) => event.target === event.currentTarget && onClose()}
>
  <div
    bind:this={dialogElement}
    class="dialog-card card preset-filled-surface-50-950 relative flex w-full max-w-md flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledBy}
    tabindex="-1"
    onkeydown={(event) => trapModalKeydown(event, event.currentTarget, onClose)}
    transition:fly={{ y: 16, duration: 150 }}
  >
    <div class="dialog-header shrink-0 px-6 pb-3 pt-6">
      {@render header()}
    </div>
    <div class="dialog-body flex-1 min-h-0 overflow-y-auto px-6 pb-6">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .dialog-backdrop {
    padding-top: max(
      1rem,
      var(--safe-top, max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px)))
    );
    padding-inline-end: max(
      1rem,
      var(--safe-right, max(env(safe-area-inset-right, 0px), var(--safe-area-inset-right, 0px)))
    );
    padding-bottom: max(
      1rem,
      var(--safe-bottom, max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px)))
    );
    padding-inline-start: max(
      1rem,
      var(--safe-left, max(env(safe-area-inset-left, 0px), var(--safe-area-inset-left, 0px)))
    );
  }

  .dialog-card {
    max-height: min(88vh, 100%);
    max-height: min(88dvh, 100%);
  }

  .dialog-body {
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scroll-padding-block: 8px;
  }

  @media (max-height: 24rem) {
    .dialog-backdrop {
      padding-top: max(
        0.25rem,
        var(--safe-top, max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px)))
      );
      padding-inline-end: max(
        0.5rem,
        var(--safe-right, max(env(safe-area-inset-right, 0px), var(--safe-area-inset-right, 0px)))
      );
      padding-bottom: max(
        0.25rem,
        var(
          --safe-bottom,
          max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px))
        )
      );
      padding-inline-start: max(
        0.5rem,
        var(--safe-left, max(env(safe-area-inset-left, 0px), var(--safe-area-inset-left, 0px)))
      );
    }

    .dialog-card {
      max-height: 100%;
    }

    .dialog-header {
      padding: 0.375rem 0.75rem;
    }

    .dialog-body {
      padding: 0 0.75rem 0.75rem;
    }
  }
</style>
