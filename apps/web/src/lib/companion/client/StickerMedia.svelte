<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { StickerClient } from "../../sticker-client.js";

  export let client: StickerClient;
  export let version: string;
  export let variant: "thumbnail" | "original" = "thumbnail";
  export let name = "";
  let url = "";
  let error = false;
  let disposed = false;

  function update(blob: Blob | null) {
    if (disposed) return;
    const next = blob ? URL.createObjectURL(blob) : "";
    if (url) URL.revokeObjectURL(url);
    url = next;
    error = !blob;
  }
  onMount(() => {
    try {
      void client.loadMedia(version, variant, update).catch(() => {
        if (!disposed && !url) error = true;
      });
    } catch { error = true; }
  });
  onDestroy(() => {
    disposed = true;
    client.releaseMedia(version, variant, update);
    if (url) URL.revokeObjectURL(url);
  });
</script>

{#if url}
  <img src={url} alt={name} draggable="false" />
{:else if error}
  <span class="sticker-media-error" aria-hidden="true">◇</span>
{:else}
  <span class="sticker-media-placeholder" aria-hidden="true"></span>
{/if}

<style>
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .sticker-media-placeholder { display: block; width: 100%; height: 100%; }
  .sticker-media-error { color: var(--f7-text-color); opacity: .45; }
</style>
