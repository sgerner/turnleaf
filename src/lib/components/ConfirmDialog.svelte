<script lang="ts">
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import {
    activeElement,
    focusFirstElement,
    focusModal,
    restoreModalFocus,
    trapModalKeydown,
  } from '../a11y/modal-focus';

  let {
    title,
    description,
    confirmLabel,
    cancelLabel = 'Cancel',
    tone = 'danger',
    busy = false,
    busyLabel,
    opener = undefined,
    restoreFocusOnConfirm = false,
    onConfirm,
    onCancel,
    children,
  }: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: 'danger' | 'primary';
    busy?: boolean;
    busyLabel?: string | undefined;
    opener?: HTMLElement | null | undefined;
    restoreFocusOnConfirm?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
    children?: Snippet | undefined;
  } = $props();

  const dialogId = $props.id();
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  let dialogElement = $state<HTMLElement | null>(null);
  let submitting = $state(false);
  let confirmed = false;
  const capturedOpener = untrack(() => (opener !== undefined ? opener : activeElement()));

  const isBusy = $derived(busy || submitting);

  onMount(() => {
    if (dialogElement) focusFirstElement(dialogElement);
    else focusModal(() => dialogElement);
  });

  onDestroy(() => {
    if (!confirmed || restoreFocusOnConfirm) {
      restoreModalFocus(capturedOpener);
    }
  });

  function handleCancel(): void {
    if (isBusy) return;
    onCancel();
  }

  async function handleConfirm(): Promise<void> {
    if (isBusy) return;
    confirmed = true;
    submitting = true;
    try {
      await onConfirm();
    } finally {
      submitting = false;
    }
  }
</script>

<div
  class="pointer-events-auto fixed inset-0 z-60 grid place-items-center bg-black/55 p-4"
  role="presentation"
  in:fade={{ duration: 120 }}
  onclick={(event) => {
    if (event.target === event.currentTarget) handleCancel();
  }}
>
  <div
    bind:this={dialogElement}
    class="card preset-filled-surface-50-950 max-h-[calc(100dvh-2rem)] w-full max-w-sm min-w-0 overflow-y-auto p-5 break-words shadow-2xl"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    tabindex="-1"
    onkeydown={(event) => {
      if (dialogElement) trapModalKeydown(event, dialogElement, handleCancel);
    }}
    in:fly={{ y: 12, duration: 150 }}
  >
    <h2 id={titleId} class="font-serif text-xl leading-snug text-surface-950-50">
      {title}
    </h2>
    <div id={descriptionId} class="mt-3 grid gap-2 text-sm text-surface-700-300">
      <p>{description}</p>
      {#if children}
        {@render children()}
      {/if}
    </div>
    <div class="mt-5 flex flex-wrap justify-end gap-2">
      <button
        class="btn preset-tonal-surface min-h-11 min-w-11 max-w-full text-center whitespace-normal"
        type="button"
        disabled={isBusy}
        onclick={handleCancel}
      >
        {cancelLabel}
      </button>
      <button
        class="btn min-h-11 min-w-11 max-w-full text-center whitespace-normal {tone === 'primary'
          ? 'preset-filled-primary-700-300'
          : 'preset-filled-error-700-300'}"
        type="button"
        disabled={isBusy}
        onclick={() => void handleConfirm()}
      >
        {isBusy && busyLabel ? busyLabel : confirmLabel}
      </button>
    </div>
  </div>
</div>
