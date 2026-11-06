<script lang="ts">
  import { renderMarkdown } from "svelte-a2ui/catalog/basic";
  let {
    text = "",
    variant = "body",
    ariaLabel,
  }: { text?: string; variant?: string; ariaLabel?: string } = $props();
  // The library escapes source HTML before making this small fixed set of tags.
  // Its generated links are reduced to labels: agent data cannot navigate.
  const content = $derived(
    renderMarkdown(String(text))
      .replace(
        /<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">/g,
        "",
      )
      .replace(/<\/a>/g, ""),
  );
</script>

<div
  class:caption={variant === "caption"}
  class="a2ui-text-content"
  aria-label={ariaLabel}
>
  {@html content}
</div>

<style>
  .a2ui-text-content {
    margin: 0.4rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .a2ui-text-content :global(p) {
    margin: 0 0 0.4em;
  }
  .a2ui-text-content :global(p:last-child) {
    margin-bottom: 0;
  }
  .caption {
    font-size: 0.8125rem;
    opacity: 0.7;
  }
</style>
