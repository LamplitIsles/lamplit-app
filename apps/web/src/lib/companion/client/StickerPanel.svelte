<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Heart from "lucide-svelte/icons/heart";
  import { Button as KonstaButton, Glass as KonstaGlass, Searchbar as KonstaSearchbar } from "konsta/svelte";
  import type { Sticker, StickerPack, StickerIdentity } from "@lamplit/contracts";
  import type { StickerClient } from "../../sticker-client.js";
  import type { CompanionTranslate } from "./locale.js";
  import StickerMedia from "./StickerMedia.svelte";

  export let client: StickerClient;
  export let t: CompanionTranslate;
  export let send: (sticker: StickerIdentity) => Promise<void>;
  export let canSend = true;
  export let favoritesRevision = 0;

  let packs: StickerPack[] = [];
  let packCursor: string | null = null;
  let packError = false;
  let packsLoading = false;
  let selected = "favorites";
  let query = "";
  let searchEpoch = 0;
  let stickers: Sticker[] = [];
  let cursor: string | null = null;
  let loading = false;
  let failed = false;
  let message = "";
  let favoriteIds: Set<string> | null = null;
  let favoriteBusy = false;
  let preview: Sticker | null = null;
  let generation = 0;
  let favoriteGeneration = 0;
  let disposed = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFavoritesRevision = favoritesRevision;

  $: if (favoritesRevision !== lastFavoritesRevision) {
    lastFavoritesRevision = favoritesRevision;
    void loadFavorites();
    if (selected === "favorites" && !query.trim()) void load(true);
  }

  $: selectedName = !query.trim() && selected !== "favorites"
    ? packs.find((pack) => pack.id === selected)?.name : undefined;

  async function loadPacks(reset = false) {
    if (packsLoading) return;
    packsLoading = true; packError = false;
    try {
      const page = await client.page("packs", { cursor: reset ? null : packCursor });
      if (disposed || !("packs" in page)) return;
      packs = reset ? page.packs : [...packs, ...page.packs.filter((p) => !packs.some((old) => old.id === p.id))];
      packCursor = page.nextCursor;
    } catch { if (!disposed) packError = true; }
    finally { if (!disposed) packsLoading = false; }
  }
  async function loadFavorites() {
    const token = ++favoriteGeneration;
    favoriteIds = null;
    const ids = new Set<string>();
    const seen = new Set<string>();
    let next: string | null = null;
    try {
      do {
        const page = await client.page("favorites", { cursor: next });
        if (disposed || token !== favoriteGeneration || !("stickers" in page)) return;
        page.stickers.forEach((sticker) => ids.add(sticker.id));
        next = page.nextCursor;
        if (next && seen.has(next)) throw new Error("Repeated cursor");
        if (next) seen.add(next);
      } while (next);
      favoriteIds = ids;
    } catch { if (!disposed && token === favoriteGeneration) message = t("stickers.favoriteFailed"); }
  }
  async function load(reset = false) {
    if (loading && !reset) return;
    const token = ++generation;
    if (reset) { stickers = []; cursor = null; }
    loading = true; failed = false;
    const search = query.trim();
    try {
      const page = await client.page(search ? "search" : selected === "favorites" ? "favorites" : "pack", {
        cursor: reset ? null : cursor,
        ...(search ? { query: search } : selected === "favorites" ? {} : { packId: selected }),
      });
      if (disposed || token !== generation || !("stickers" in page)) return;
      stickers = reset ? page.stickers : [...stickers, ...page.stickers.filter((s) => !stickers.some((old) => old.id === s.id))];
      cursor = page.nextCursor;
    } catch { if (!disposed && token === generation) failed = true; }
    finally { if (!disposed && token === generation) loading = false; }
  }
  function select(id: string) {
    clearTimeout(searchTimer); query = ""; searchEpoch++; selected = id; preview = null;
    void load(true);
  }
  function search() {
    generation++; stickers = []; cursor = null; failed = false;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(true), 250);
  }
  // Searchbar exposes an input id but not input attributes; retain searchbox semantics.
  function searchSemantics(node: HTMLElement) {
    node.querySelector("input")?.setAttribute("role", "searchbox");
  }
  async function favorite(sticker: Sticker) {
    if (!favoriteIds || favoriteBusy) return;
    const desired = !favoriteIds.has(sticker.id);
    favoriteBusy = true; message = "";
    try { await client.favorite(sticker.id, desired); }
    catch { if (!disposed) message = t("stickers.favoriteFailed"); }
    finally {
      if (!disposed) {
        favoriteBusy = false;
        await loadFavorites();
        if (selected === "favorites" && !query.trim()) await load(true);
      }
    }
  }
  async function sendSticker(sticker: Sticker) {
    if (!sticker.available) return;
    if (!canSend) { message = t("stickers.sendFailed"); return; }
    try { await send({ id: sticker.id, version: sticker.version }); }
    catch { if (!disposed) message = t("stickers.sendFailed"); }
  }

  // A hold previews only; movement and scrolling cancel before it fires.
  function hold(node: HTMLElement, sticker: Sticker) {
    let active: { id: number; x: number; y: number; fired: boolean } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppress = false;
    function finish() {
      clearTimeout(timer); active = undefined; preview = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("scroll", scroll, true);
    }
    function down(event: PointerEvent) {
      if (event.button !== 0 || active) return;
      suppress = false;
      active = { id: event.pointerId, x: event.clientX, y: event.clientY, fired: false };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      window.addEventListener("blur", finish);
      document.addEventListener("scroll", scroll, true);
      timer = setTimeout(() => {
        if (!active) return;
        active.fired = true; suppress = true; preview = sticker;
      }, 450);
    }
    function move(event: PointerEvent) {
      if (active && active.id === event.pointerId && !active.fired && Math.hypot(event.clientX - active.x, event.clientY - active.y) > 10) finish();
    }
    function up(event: PointerEvent) {
      if (!active || active.id !== event.pointerId) return;
      finish();
    }
    function click(event: MouseEvent) {
      if (suppress) { event.preventDefault(); event.stopImmediatePropagation(); suppress = false; }
    }
    function contextMenu(event: MouseEvent) { event.preventDefault(); }
    function scroll() { if (active && !active.fired) finish(); }
    node.addEventListener("pointerdown", down);
    node.addEventListener("click", click, true);
    node.addEventListener("contextmenu", contextMenu);
    return { destroy() {
      finish(); node.removeEventListener("pointerdown", down); node.removeEventListener("click", click, true); node.removeEventListener("contextmenu", contextMenu);
    } };
  }
  onMount(() => { void loadPacks(true); void loadFavorites(); void load(true); });
  onDestroy(() => { disposed = true; generation++; favoriteGeneration++; clearTimeout(searchTimer); });
</script>

<section class="sticker-panel" aria-label={t("stickers.open")}>
  {#key searchEpoch}
    <div class="sticker-search-region" use:searchSemantics>
      <label class="sticker-sr-only" for="sticker-search">{t("stickers.search")}</label>
      <KonstaSearchbar class="sticker-search" inputId="sticker-search" placeholder={t("stickers.search")} bind:value={query} clearButton={false} onInput={(event: Event) => { query = (event.currentTarget as HTMLInputElement).value; search(); }} />
    </div>
  {/key}
  <div class="sticker-tabs" role="group" aria-label={t("stickers.open")}>
    <KonstaButton class="sticker-tab" type="button" tonal={selected === "favorites" && !query.trim()} clear={selected !== "favorites" || !!query.trim()} aria-label={t("stickers.favorites")} aria-pressed={selected === "favorites" && !query.trim()} onClick={() => select("favorites")}><Heart size={22} /></KonstaButton>
    {#each packs as pack (pack.id)}
      <KonstaButton class="sticker-tab" type="button" tonal={selected === pack.id && !query.trim()} clear={selected !== pack.id || !!query.trim()} aria-label={pack.name} aria-pressed={selected === pack.id && !query.trim()} onClick={() => select(pack.id)}>
        {#key `${pack.cover.id}:${pack.cover.version}`}<StickerMedia {client} version={pack.cover.version} />{/key}
      </KonstaButton>
    {/each}
    {#if packCursor || packError}<KonstaButton class="sticker-tab" type="button" clear disabled={packsLoading} aria-label={t("stickers.more")} onClick={() => void loadPacks(packError && !packs.length)}>···</KonstaButton>{/if}
  </div>
  {#if selectedName}<div class="sticker-pack-name">{selectedName}</div>{/if}
  {#if message}<KonstaButton class="sticker-message" type="button" clear small inline onClick={() => { message = ""; void loadFavorites(); }}>{message}</KonstaButton>{/if}
  <div class="sticker-scroll">
    <div class="sticker-grid">
      {#each stickers as sticker (sticker.id)}
        <div class="sticker-cell">
          <div class="sticker-send-target" use:hold={sticker}>
            <KonstaButton class="sticker-send" type="button" clear disabled={!sticker.available} aria-label={sticker.name} onClick={() => void sendSticker(sticker)}>
              {#key `${sticker.id}:${sticker.version}`}<StickerMedia {client} version={sticker.version} />{/key}
            </KonstaButton>
          </div>
          <KonstaButton class="sticker-favorite" type="button" tonal rounded disabled={favoriteIds === null || favoriteBusy} aria-label={t(favoriteIds?.has(sticker.id) ? "stickers.unfavorite" : "stickers.favorite")} onClick={() => void favorite(sticker)}><Heart size={15} fill={favoriteIds?.has(sticker.id) ? "currentColor" : "none"} /></KonstaButton>
        </div>
      {/each}
    </div>
    {#if failed}<KonstaButton class="sticker-status" type="button" clear small inline onClick={() => void load(!stickers.length)}>{t("stickers.error")}</KonstaButton>
    {:else if loading}<div class="sticker-status" aria-busy="true">···</div>
    {:else if cursor}<KonstaButton class="sticker-status" type="button" clear small inline onClick={() => void load()}>{t("stickers.more")}</KonstaButton>
    {:else if !stickers.length}<div class="sticker-status">{t("stickers.empty")}</div>{/if}
  </div>
</section>
{#if preview}
  <KonstaGlass class="sticker-preview" role="status" aria-label={t("stickers.preview")}>
    <div class="sticker-preview-image">{#key `${preview.id}:${preview.version}`}<StickerMedia {client} version={preview.version} variant="original" name={preview.name} />{/key}</div>
    <div class="sticker-preview-name">{preview.name}</div>
  </KonstaGlass>
{/if}

<style>
  .sticker-panel { height: min(310px, 40vh); display:flex; flex-direction:column; }
  .sticker-search-region { margin:8px 12px 4px; flex:none; min-width:0; }
  .sticker-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0, 0, 0, 0); white-space:nowrap; border:0; }
  .sticker-search-region :global(.sticker-search) { width:100%; margin:0; padding:0; }
  .sticker-tabs { display:flex; flex:none; gap:7px; overflow-x:auto; padding:5px 12px; }
  .sticker-tabs :global(.sticker-tab) { flex:none; width:38px; height:38px; padding:4px; }
  .sticker-pack-name { font-size:12px; opacity:.65; padding:5px 12px 0; }
  .sticker-scroll { overflow:auto; flex:1; overscroll-behavior:contain; }
  .sticker-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:8px; padding:10px 12px; }
  .sticker-cell { position:relative; height:66px; }
  .sticker-send-target { width:100%; height:100%; touch-action:pan-y; }
  .sticker-send-target :global(img) { -webkit-touch-callout:none; -webkit-user-drag:none; }
  .sticker-cell :global(.sticker-send) { width:100%; height:100%; padding:2px 8px; touch-action:pan-y; }
  .sticker-cell :global(.sticker-favorite) { position:absolute; top:0; right:0; width:24px; height:24px; padding:0; }
  .sticker-status, .sticker-panel :global(.sticker-status), .sticker-panel :global(.sticker-message) { display:block; margin:8px auto; width:auto; text-align:center; }
  .sticker-panel :global(.k-button:focus-visible) { outline:2px solid var(--k-color-primary, #007aff); outline-offset:2px; }
  .sticker-status { text-align:center; }
  :global(.sticker-preview) { position:fixed; z-index:10000; left:50%; top:42%; transform:translate(-50%, -50%); width:200px; padding:16px; border-radius:16px; pointer-events:none; }
  /* Glass has no Material surface of its own. */
  :global(.md .sticker-preview) { background-color:var(--color-md-light-surface-3); color:var(--color-md-light-on-surface); }
  :global(.md.dark .sticker-preview), :global(.md .dark .sticker-preview), :global(.dark .md .sticker-preview) { background-color:var(--color-md-dark-surface-3); color:var(--color-md-dark-on-surface); }
  .sticker-preview-image { height:168px; }
  .sticker-preview-name { padding-top:10px; text-align:center; overflow-wrap:anywhere; }
</style>
