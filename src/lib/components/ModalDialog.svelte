<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { focusFirstElement, restoreFocus, trapModalKeydown } from '../a11y/modal-focus';

  let {
    open,
    labelledBy,
    describedBy = undefined,
    role = 'dialog',
    maxWidthClass = 'max-w-md',
    panelClass = 'p-4 sm:p-6',
    backdropClass = 'z-40 bg-black/50',
    onClose,
    onAfterClose = undefined,
    children,
  }: {
    open: boolean;
    labelledBy: string;
    describedBy?: string | undefined;
    role?: 'dialog' | 'alertdialog';
    maxWidthClass?: string;
    panelClass?: string;
    backdropClass?: string;
    onClose: () => void;
    onAfterClose?: (() => void) | undefined;
    children: Snippet;
  } = $props();

  let dialogElement = $state<HTMLElement | null>(null);
  let opener: HTMLElement | null = null;
  let wasOpen = false;

  $effect.pre(() => {
    if (open && !wasOpen) {
      opener =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
  });

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      untrack(() => {
        void tick().then(() => {
          if (open) focusFirstElement(dialogElement);
        });
      });
    } else if (!open && wasOpen) {
      wasOpen = false;
      const previousOpener = opener;
      opener = null;
      untrack(() => {
        void tick().then(() => {
          restoreFocus(previousOpener);
          onAfterClose?.();
        });
      });
    }
  });

  onDestroy(() => {
    opener = null;
  });
</script>

{#if open}
  <div
    class="fixed inset-0 grid place-items-center overflow-y-auto p-4 {backdropClass}"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && onClose()}
  >
    <div
      bind:this={dialogElement}
      class="card preset-filled-surface-50-950 relative max-h-[calc(100dvh-2rem)] min-w-0 w-full {maxWidthClass} overflow-x-hidden overflow-y-auto overscroll-contain shadow-2xl {panelClass}"
      {role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabindex="-1"
      onkeydown={(event) => dialogElement && trapModalKeydown(event, dialogElement, onClose)}
      transition:fly={{ y: 16, duration: 150 }}
    >
      {@render children()}
    </div>
  </div>
{/if}
