<script lang="ts">
  import { getContext } from "svelte";
  import { defaultRenderers } from "@humanspeak/svelte-markdown";
  import { workspaceImageUrl } from "@lamplit/contracts";
  import type { CompanionTranslate } from "./locale.js";

  let {
    href = "",
    text = "",
    title,
  }: {
    href?: string;
    text?: string;
    title?: string;
  } = $props();
  const context = getContext<{ enabled: boolean; t: CompanionTranslate }>(
    "workspaceMarkdown",
  );
  const ExternalImage = defaultRenderers.image;
  let external = $derived(
    /^https?:\/\//i.test(href) || href.startsWith("/api/"),
  );
  let url = $derived(context.enabled ? workspaceImageUrl(href) : null);
  let failed = $state(false);
  let attempt = $state(0);
  $effect(() => {
    void href;
    failed = false;
    attempt = 0;
  });
</script>

{#if external}
  <ExternalImage {href} {text} {title} />
{:else if url && !failed}
  <img
    class="workspace-image"
    src={url + (attempt ? `&retry=${attempt}` : "")}
    alt={text}
    {title}
    onerror={() => {
      failed = true;
    }}
  />
{:else}
  <span class="workspace-image-unavailable" role="status" {title}>
    {#if text}<span>{text}</span>{/if}
    <span>{context.t("gallery.unavailable")}</span>
    {#if url}
      <button
        class="button button-tonal button-small"
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          attempt++;
          failed = false;
        }}>{context.t("retry")}</button
      >
    {/if}
  </span>
{/if}

<style>
  .workspace-image {
    max-width: 100%;
    height: auto;
    vertical-align: middle;
  }
  .workspace-image-unavailable {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    overflow-wrap: anywhere;
    color: var(--f7-text-color);
  }
</style>
