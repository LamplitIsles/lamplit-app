<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Button } from "konsta/svelte";
  import ImagePlus from "lucide-svelte/icons/image-plus";
  import type { CompanionTranslate, CompanionLocaleKey } from "./locale.ts";

  type Direction = "landscape" | "portrait";
  type Snapshot = Record<Direction, boolean>;
  let {
    t,
    open,
    refreshBackgrounds,
  }: {
    t: CompanionTranslate;
    open: boolean;
    refreshBackgrounds: () => Promise<boolean>;
  } = $props();
  let snapshot = $state<Snapshot>();
  let phase = $state<"loading" | "ready" | "saving" | "error" | "unsupported">(
    "loading",
  );
  let message = $state<CompanionLocaleKey>();
  let revision = $state(0);
  let request: AbortController | undefined;
  let disposed = false;

  function parseSnapshot(value: unknown): Snapshot {
    if (!value || typeof value !== "object")
      throw new Error("Invalid background settings");
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.landscape !== "boolean" ||
      typeof candidate.portrait !== "boolean"
    )
      throw new Error("Invalid background settings");
    return { landscape: candidate.landscape, portrait: candidate.portrait };
  }
  async function update(value: Snapshot, current: AbortController) {
    snapshot = value;
    revision += 1;
    const refreshed = await refreshBackgrounds();
    if (disposed || request !== current) return;
    phase = refreshed ? "ready" : "error";
    message = refreshed ? undefined : "settings.backgroundDisplayFailed";
  }
  async function load() {
    if (phase === "saving") return;
    request?.abort();
    const current = (request = new AbortController());
    phase = "loading";
    message = undefined;
    try {
      const response = await fetch("/api/background-settings", {
        signal: current.signal,
        cache: "no-store",
      });
      if ([404, 405, 501].includes(response.status)) {
        if (!disposed && request === current) phase = "unsupported";
        return;
      }
      if (!response.ok) throw new Error("Background settings unavailable");
      const value = parseSnapshot(await response.json());
      if (!disposed && request === current) await update(value, current);
    } catch {
      if (disposed || request !== current || current.signal.aborted) return;
      phase = "error";
      message = "settings.backgroundLoadFailed";
    }
  }
  async function upload(direction: Direction, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || phase !== "ready") return;
    if (file.size > 20 * 1024 * 1024) {
      message = "settings.backgroundTooLarge";
      return;
    }
    const current = (request = new AbortController());
    phase = "saving";
    message = undefined;
    try {
      const response = await fetch(`/api/background-settings/${direction}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
        signal: current.signal,
      });
      if (!response.ok) throw new Error("Background upload not confirmed");
      const value = parseSnapshot(await response.json());
      if (!disposed && request === current) await update(value, current);
    } catch {
      if (disposed || request !== current) return;
      phase = "error";
      message = "settings.backgroundSaveFailed";
    }
  }
  $effect(() => {
    if (open) untrack(() => void load());
  });
  onDestroy(() => {
    disposed = true;
    request?.abort();
  });
</script>

{#if phase !== "unsupported" && (snapshot || phase === "error")}
  <section
    class="background-settings"
    aria-label={t("settings.backgroundTitle")}
  >
    <h2>{t("settings.backgroundTitle")}</h2>
    <div class="background-settings-grid">
      {#each ["landscape", "portrait"] as direction}
        {@const kind = direction as Direction}
        <label
          class:background-configured={snapshot?.[kind]}
          class:background-disabled={phase !== "ready"}
          class="background-upload"
        >
          {#if snapshot?.[kind]}
            <img src={`/api/backgrounds/${kind}?v=${revision}`} alt="" />
          {:else}
            <ImagePlus size={23} strokeWidth={1.7} aria-hidden="true" />
          {/if}
          <span
            >{t(
              kind === "landscape"
                ? "settings.backgroundLandscape"
                : "settings.backgroundPortrait",
            )}</span
          >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label={t(
              kind === "landscape"
                ? "settings.backgroundLandscape"
                : "settings.backgroundPortrait",
            )}
            disabled={phase !== "ready"}
            onchange={(event) => void upload(kind, event)}
          />
        </label>
      {/each}
    </div>
    {#if phase === "saving"}
      <p role="status">{t("settings.backgroundSaving")}</p>
    {:else if phase === "error"}
      <p role="alert">{message ? t(message) : ""}</p>
      <Button tonal
        type="button"
        onclick={() => void load()}>{t("models.reload")}</Button
      >
    {:else if message}
      <p role="alert">{t(message)}</p>
    {/if}
  </section>
{/if}
