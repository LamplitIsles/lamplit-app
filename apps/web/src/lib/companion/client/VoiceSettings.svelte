<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { CompanionTranslate, CompanionLocaleKey } from "./locale.ts";

  type Region = "beijing" | "singapore";
  type Snapshot = { region: Region; configured: boolean };
  let {
    t,
    open,
    onSupportChange = () => {},
  }: {
    t: CompanionTranslate;
    open: boolean;
    onSupportChange?: (supported: boolean) => void;
  } = $props();
  let snapshot = $state<Snapshot>();
  let region = $state<Region>("beijing");
  let apiKey = $state("");
  let phase = $state<"loading" | "ready" | "saving" | "error" | "unsupported">(
    "loading",
  );
  let message = $state<CompanionLocaleKey>();
  let disposed = false;
  let request: AbortController | undefined;
  const keyRequired = $derived(
    !snapshot?.configured || region !== snapshot.region,
  );

  function parseSnapshot(value: unknown): Snapshot {
    if (!value || typeof value !== "object")
      throw new Error("Invalid voice settings");
    const candidate = value as Record<string, unknown>;
    if (
      (candidate.region !== "beijing" && candidate.region !== "singapore") ||
      typeof candidate.configured !== "boolean"
    )
      throw new Error("Invalid voice settings");
    return { region: candidate.region, configured: candidate.configured };
  }
  async function load() {
    if (phase === "saving") return;
    request?.abort();
    const current = (request = new AbortController());
    phase = "loading";
    message = undefined;
    try {
      const response = await fetch("/api/voice/settings", {
        signal: current.signal,
        cache: "no-store",
      });
      if ([404, 405, 501].includes(response.status)) {
        if (!disposed && request === current) {
          phase = "unsupported";
          onSupportChange(false);
        }
        return;
      }
      if (!response.ok) throw new Error("Voice settings unavailable");
      const value = parseSnapshot(await response.json());
      if (disposed || request !== current) return;
      snapshot = value;
      region = value.region;
      apiKey = "";
      phase = "ready";
      window.dispatchEvent(new Event("companion-voice-settings-changed"));
      onSupportChange(true);
    } catch {
      if (disposed || request !== current || current.signal.aborted) return;
      phase = "error";
      message = "settings.voiceLoadFailed";
      onSupportChange(true);
    }
  }
  async function save() {
    if (phase !== "ready" || !snapshot || (keyRequired && !apiKey.trim()))
      return;
    const current = (request = new AbortController());
    phase = "saving";
    message = undefined;
    try {
      const response = await fetch("/api/voice/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region, apiKey: apiKey.trim() }),
        signal: current.signal,
      });
      if (!response.ok) throw new Error("Voice settings not confirmed");
      const value = parseSnapshot(await response.json());
      if (disposed || request !== current) return;
      snapshot = value;
      region = value.region;
      apiKey = "";
      phase = "ready";
      window.dispatchEvent(new Event("companion-voice-settings-changed"));
    } catch {
      if (disposed || request !== current) return;
      apiKey = "";
      phase = "error";
      message = "settings.voiceSaveFailed";
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

{#if phase !== "unsupported"}
  <div class="settings-voice">
    {#if phase === "loading"}
      <p role="status">{t("models.loading")}</p>
    {:else if phase === "error"}
      <p role="alert">{message ? t(message) : ""}</p>
      <button
        class="button button-tonal"
        type="button"
        onclick={() => void load()}>{t("models.reload")}</button
      >
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label for="voice-region">{t("settings.voiceRegion")}</label>
        <select
          id="voice-region"
          bind:value={region}
          disabled={phase === "saving"}
        >
          <option value="beijing">{t("settings.beijing")}</option>
          <option value="singapore">{t("settings.singapore")}</option>
        </select>
        <label for="voice-key">{t("settings.voiceKey")}</label>
        <input
          id="voice-key"
          type="password"
          autocomplete="off"
          spellcheck="false"
          bind:value={apiKey}
          disabled={phase === "saving"}
          aria-describedby="voice-key-help"
        />
        <p id="voice-key-help">
          {t(
            keyRequired ? "settings.voiceKeyRequired" : "settings.voiceKeyKeep",
          )}
        </p>
        <button
          class="button button-fill settings-save"
          type="submit"
          disabled={phase === "saving" || (keyRequired && !apiKey.trim())}
          >{t(phase === "saving" ? "settings.saving" : "settings.save")}</button
        >
      </form>
    {/if}
  </div>
{/if}
