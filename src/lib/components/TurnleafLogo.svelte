<script lang="ts">
  let {
    size = 56,
    wordmark = true,
  }: {
    size?: number;
    wordmark?: boolean;
  } = $props();
</script>

<span
  class="turnleaf-logo"
  style={`--turnleaf-logo-size:${size}px`}
  aria-label={wordmark ? undefined : 'Turnleaf'}
  role={wordmark ? undefined : 'img'}
>
  <img class="turnleaf-image" src="/logo.png" alt="" decoding="async" loading="eager" />

  {#if wordmark}
    <span class="turnleaf-wordmark">Turnleaf</span>
  {/if}
</span>

<style>
  .turnleaf-logo {
    --turnleaf-logo-size: 3.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.85rem;
    color: var(--base-font-color);
  }

  .turnleaf-image {
    width: var(--turnleaf-logo-size);
    height: var(--turnleaf-logo-size);
    object-fit: contain;
    display: block;
  }

  .turnleaf-wordmark {
    font-family: var(--heading-font-family);
    font-size: calc(var(--turnleaf-logo-size) * 0.44);
    line-height: 1;
    letter-spacing: 0.02em;
  }
</style>
