<script lang="ts">
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import type { GalleryRow, GalleryImage } from "./gallery.ts";
  export let unavailableLabel = "Image unavailable";
  export let rows: GalleryRow[];
  export let hasMore: boolean;
  export let loading: boolean;
  export let loadMore: () => Promise<void>;
  export let pick: (image: GalleryImage) => void;
  let viewport: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport ?? null,
    estimateSize: (index) => (rows[index]?.kind === "group" ? 38 : 132),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 3,
  });
  $: if (viewport && rows) {
    get(virtualizer).setOptions({
      count: rows.length,
      getScrollElement: () => viewport ?? null,
      estimateSize: (index) => (rows[index]?.kind === "group" ? 38 : 132),
      getItemKey: (index) => rows[index]?.key ?? index,
    });
    void tick().then(checkMore);
  }
  function checkMore() {
    if (
      viewport?.isConnected &&
      hasMore &&
      !loading &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 250
    )
      void loadMore();
  }
</script>

<div
  bind:this={viewport}
  class="page-content companion-gallery-viewport"
  on:scroll={checkMore}
>
  <div
    class="companion-gallery-virtual"
    style={`height:${$virtualizer.getTotalSize()}px;position:relative`}
  >
      {#each $virtualizer.getVirtualItems() as item (item.key)}
        {@const row = rows[item.index]}
        {#if row}<div style={`position:absolute;top:0;left:0;width:100%;transform:translateY(${item.start}px)`}>
        {#if row.kind === "group"}<div class="companion-gallery-group">
            <h3>{row.label}</h3>
          </div>
        {:else}<div class="companion-gallery-grid">
            {#each row.images as image (image.id)}<button
                type="button"
                class="companion-gallery-tile"
                aria-label={image.filename}
                disabled={!image.available}
                on:click={() => pick(image)}
                >{#if image.available}<img
                    src={image.url}
                    alt={image.filename}
                    loading="lazy"
                    decoding="async"
                  />{:else}<span
                    >{image.filename}<br /><span>{unavailableLabel}</span></span
                  >{/if}</button
              >{/each}
          </div>{/if}
        </div>{/if}
      {/each}
  </div>
</div>
