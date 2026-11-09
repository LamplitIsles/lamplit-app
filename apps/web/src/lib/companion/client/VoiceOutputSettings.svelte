<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { Actions, ActionsButton, ActionsGroup, Button, List, ListInput, ListItem } from "konsta/svelte";
  import { overlayOpening, overlayOpened, overlayClosed } from "./overlay-focus.ts";
  import type { CompanionLocaleKey, CompanionTranslate } from "./locale.ts";

  type Provider = "minimax" | "alibaba" | "bytedance" | "elevenlabs";
  type KeyProvider = Exclude<Provider, "minimax">;
  type Snapshot = {
    provider: Provider | null;
    voices: Record<Provider, string>;
    speeds: Record<"minimax" | "bytedance", number | null>;
    configured: Record<KeyProvider, boolean>;
  };
  type Voice = { id: string; name: string };
  let { t, open, active, onSupportChange = () => {} }: {
    t: CompanionTranslate; open: boolean; active: boolean;
    onSupportChange?: (supported: boolean) => void;
  } = $props();
  const providers: Provider[] = ["minimax", "alibaba", "bytedance", "elevenlabs"];
  let picker = $state<"provider" | "voice">();
  let snapshot = $state<Snapshot>();
  let provider = $state<Provider>("elevenlabs");
  let voice = $state("");
  let manualVoice = $state(false);
  let voiceEdited = $state(false);
  let selectionDirty = false;
  let speed = $state<number | undefined>(undefined);
  let apiKey = $state("");
  let phase = $state<"loading" | "ready" | "saving" | "error" | "unsupported">("loading");
  let message = $state<CompanionLocaleKey>();
  let voices = $state<Voice[]>([]);
  let cursor = $state<string | null>(null);
  let voicePhase = $state<"idle" | "loading" | "ready" | "error">("idle");
  let matchingVoice = $derived(voices.some((item) => item.id === voice));
  let waitingForVoice = $derived(provider === "elevenlabs" && !!snapshot?.configured.elevenlabs && !voiceEdited && (voicePhase === "idle" || voicePhase === "loading"));
  let showManualVoice = $derived(!waitingForVoice && (manualVoice || (!!voice && !matchingVoice)));
  let providerLabel = $derived(provider === "alibaba" ? t("settings.outputAlibaba") : provider === "bytedance" ? t("settings.outputBytedance") : provider === "minimax" ? "MiniMax" : "ElevenLabs");
  let voiceLabel = $derived(showManualVoice ? t("settings.outputManualVoice") : voices.find((item) => item.id === voice)?.name ?? t("settings.outputChooseVoice"));
  let request: AbortController | undefined;
  let voiceRequest: AbortController | undefined;
  let disposed = false;

  function pickerFocus(node: HTMLElement) {
    const overlay = { el: node };
    let mounted = true;
    overlayOpening(overlay);
    void tick().then(() => { if (mounted) overlayOpened(overlay); });
    return { destroy() { mounted = false; overlayClosed(overlay); } };
  }

  function parseSnapshot(value: unknown): Snapshot {
    if (!value || typeof value !== "object") throw new Error("Invalid settings");
    const v = value as Snapshot;
    if ((v.provider !== null && !providers.includes(v.provider)) || !v.voices || !v.speeds || !v.configured ||
      providers.some((p) => typeof v.voices[p] !== "string") ||
      (["minimax", "bytedance"] as const).some((p) => v.speeds[p] !== null && (typeof v.speeds[p] !== "number" || !Number.isFinite(v.speeds[p]!))) ||
      (["alibaba", "bytedance", "elevenlabs"] as const).some((p) => typeof v.configured[p] !== "boolean")) throw new Error("Invalid settings");
    return v;
  }
  function resetDraft(next: Snapshot, selected: Provider) {
    provider = selected;
    voice = next.voices[selected];
    manualVoice = selected === "elevenlabs" && !!voice && !voices.some((item) => item.id === voice);
    voiceEdited = false;
    speed = selected === "minimax" || selected === "bytedance" ? next.speeds[selected] ?? undefined : undefined;
    apiKey = "";
  }
  function clearVoices() {
    voiceRequest?.abort();
    voiceRequest = undefined;
    voices = [];
    cursor = null;
    voicePhase = "idle";
  }
  async function loadVoices(nextCursor: string | null = null) {
    if (provider !== "elevenlabs" || !snapshot?.configured.elevenlabs || voicePhase === "loading") return;
    voiceRequest?.abort();
    const current = (voiceRequest = new AbortController());
    voicePhase = "loading";
    try {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
      const response = await fetch(`/api/tts/elevenlabs/voices${query}`, { signal: current.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Voice list unavailable");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object") throw new Error("Invalid voice list");
      const result = data as { voices: Voice[]; nextCursor: string | null };
      if (!Array.isArray(result.voices) || result.voices.some((v) => !v || typeof v.id !== "string" || typeof v.name !== "string") ||
        (result.nextCursor !== null && typeof result.nextCursor !== "string")) throw new Error("Invalid voice list");
      if (disposed || voiceRequest !== current) return;
      voices = nextCursor ? [...voices, ...result.voices.filter((v) => !voices.some((old) => old.id === v.id))] : result.voices;
      if (!voiceEdited && voice && voices.some((item) => item.id === voice)) manualVoice = false;
      cursor = result.nextCursor;
      voicePhase = "ready";
    } catch {
      if (disposed || voiceRequest !== current || current.signal.aborted) return;
      voicePhase = "error";
    }
  }
  async function load() {
    if (phase === "saving") return;
    request?.abort();
    clearVoices();
    const current = (request = new AbortController());
    phase = "loading";
    message = undefined;
    try {
      const response = await fetch("/api/tts/settings", { signal: current.signal, cache: "no-store" });
      if ([404, 405, 501].includes(response.status)) {
        if (!disposed && request === current) { phase = "unsupported"; onSupportChange(false); }
        return;
      }
      if (!response.ok) throw new Error("Settings unavailable");
      const next = parseSnapshot(await response.json());
      if (disposed || request !== current) return;
      snapshot = next;
      if (!selectionDirty) resetDraft(next, next.provider ?? "elevenlabs");
      phase = "ready";
      onSupportChange(true);
      if (active && provider === "elevenlabs" && next.configured.elevenlabs) void loadVoices();
    } catch {
      if (disposed || request !== current || current.signal.aborted) return;
      phase = "error";
      message = "settings.outputLoadFailed";
      onSupportChange(true);
    }
  }
  function changeProvider(next: Provider) {
    if (!snapshot || phase !== "ready") return;
    clearVoices();
    resetDraft(snapshot, next);
    markSelectionChanged();
    if (next === "elevenlabs" && snapshot.configured.elevenlabs) void loadVoices();
  }
  function markSelectionChanged() {
    selectionDirty = true;
    message = undefined;
  }
  function chooseVoice(value: string) {
    markSelectionChanged();
    voiceEdited = true;
    if (value === "manual") manualVoice = true;
    else if (value.startsWith("saved:")) {
      manualVoice = false;
      voice = value.slice(6);
    } else {
      manualVoice = false;
      voice = "";
    }
  }
  async function save(kind: "key" | "selection") {
    if (phase !== "ready" || !snapshot) return;
    const selected = provider;
    const key = apiKey.trim();
    if (kind === "key" && (selected === "minimax" || !key)) return;
    if (kind === "selection" && (!voice.trim() || (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)))) return;
    const body = kind === "key" ? { provider: selected, apiKey: key } : { provider: selected, voice: voice.trim(), speed: speed ?? null };
    const current = (request = new AbortController());
    phase = "saving";
    message = undefined;
    apiKey = "";
    try {
      const response = await fetch(kind === "key" ? "/api/tts/settings/key" : "/api/tts/settings", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: current.signal,
      });
      if (!response.ok) throw new Error("Settings not confirmed");
      const next = parseSnapshot(await response.json());
      if (disposed || request !== current) return;
      snapshot = next;
      if (kind === "selection") { selectionDirty = false; resetDraft(next, selected); }
      phase = "ready";
      message = kind === "key" ? "settings.outputKeySaved" : "settings.outputSaved";
      if (kind === "key" && selected === "elevenlabs") { clearVoices(); void loadVoices(); }
    } catch {
      if (disposed || request !== current) return;
      if (kind === "selection") selectionDirty = false;
      phase = "error";
      message = "settings.outputSaveFailed";
    }
  }
  $effect(() => { if (open) untrack(() => void load()); });
  $effect(() => {
    if (!open || !active) { apiKey = ""; picker = undefined; clearVoices(); }
    else if (phase === "ready" && provider === "elevenlabs" && snapshot?.configured.elevenlabs && voicePhase === "idle") untrack(() => void loadVoices());
  });
  onDestroy(() => { disposed = true; request?.abort(); voiceRequest?.abort(); });
</script>

<svelte:window onkeydown={(event) => { if (event.key === "Escape" && picker) { event.preventDefault(); event.stopPropagation(); picker = undefined; } }} />
{#if phase !== "unsupported"}
  <div class="settings-voice voice-output-settings">
    {#if phase === "loading"}
      <p role="status">{t("models.loading")}</p>
    {:else if phase === "error"}
      <p role="alert">{message ? t(message) : ""}</p>
      <Button tonal type="button" onClick={() => void load()}>{t("models.reload")}</Button>
    {:else if snapshot}
      <List strong inset class="voice-output-list">
        <ListItem link linkComponent="button" linkProps={{ type: "button", id: "tts-provider", disabled: phase === "saving", "aria-haspopup": "dialog", "data-value": provider }} title={t("settings.outputProvider")} after={providerLabel} onClick={() => picker = "provider"} />
      </List>
      {#if provider === "minimax"}
        <p>{t("settings.outputMinimaxHelp")}</p>
      {:else}
        <form onsubmit={(event) => { event.preventDefault(); void save("key"); }}>
          <p>{t(snapshot.configured[provider] ? "settings.outputConfigured" : "settings.outputNotConfigured")}</p>
          <List strong inset class="voice-output-list">
            <ListInput inputId="tts-key" type="password" autocomplete="off" spellcheck="false" value={apiKey} disabled={phase === "saving"} onInput={(event) => { apiKey = event.currentTarget.value; message = undefined; }} >{#snippet label()}<label for="tts-key">{t("settings.outputKey")}</label>{/snippet}</ListInput>
          </List>
          <p>{t(provider === "elevenlabs" ? "settings.outputElevenLabsHelp" : "settings.outputKeyHelp")}</p>
          <Button tonal class="settings-save" type="submit" disabled={phase === "saving" || !apiKey.trim()}>{t("settings.outputSaveKey")}</Button>
        </form>
      {/if}
      <form onsubmit={(event) => { event.preventDefault(); void save("selection"); }}>
        {#if provider === "elevenlabs"}
          <List strong inset class="voice-output-list">
            <ListItem link linkComponent="button" linkProps={{ type: "button", id: "tts-saved-voices", disabled: phase === "saving", "aria-haspopup": "dialog", "data-value": showManualVoice ? "manual" : voice ? `saved:${voice}` : "" }} title={t("settings.outputVoice")} after={voiceLabel} onClick={() => picker = "voice"} />
          </List>
          {#if showManualVoice}
            <List strong inset class="voice-output-list">
              <ListInput inputId="tts-voice" type="text" autocomplete="off" spellcheck="false" value={voice} disabled={phase === "saving"} onInput={(event) => { voiceEdited = true; voice = event.currentTarget.value; markSelectionChanged(); }} >{#snippet label()}<label for="tts-voice">{t("settings.outputVoiceId")}</label>{/snippet}</ListInput>
            </List>
          {/if}
          {#if voicePhase === "loading"}<p role="status">{t("models.loading")}</p>
          {:else if voicePhase === "error"}<p role="alert">{t("settings.outputVoicesFailed")}</p><Button tonal type="button" onClick={() => { clearVoices(); void loadVoices(); }}>{t("models.reload")}</Button>
          {:else if voicePhase === "ready" && voices.length === 0}<p>{t("settings.outputNoVoices")}</p>{/if}
          {#if cursor && voicePhase === "ready"}<Button tonal type="button" onClick={() => void loadVoices(cursor)}>{t("settings.outputMoreVoices")}</Button>{/if}
        {:else}
          <List strong inset class="voice-output-list">
            <ListInput inputId="tts-voice" type="text" autocomplete="off" spellcheck="false" value={voice} disabled={phase === "saving"} onInput={(event) => { voice = event.currentTarget.value; markSelectionChanged(); }} >{#snippet label()}<label for="tts-voice">{t("settings.outputVoiceId")}</label>{/snippet}</ListInput>
          </List>
        {/if}
        {#if provider === "minimax" || provider === "bytedance"}
          <List strong inset class="voice-output-list">
            <ListInput inputId="tts-speed" type="number" min="0.5" max="2" step="0.05" placeholder="1" value={speed} disabled={phase === "saving"} onInput={(event) => { speed = event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber; markSelectionChanged(); }} >{#snippet label()}<label for="tts-speed">{t("settings.outputSpeed")}</label>{/snippet}</ListInput>
          </List>
        {/if}
        <Button class="settings-save" type="submit" disabled={phase === "saving" || !voice.trim()}>{t("settings.save")}</Button>
      </form>
      {#if message}<p role="status">{t(message)}</p>{/if}
    {/if}
  </div>
{/if}
{#if picker}
  <Actions opened onBackdropClick={() => picker = undefined}>
    <div role="dialog" aria-modal="true" aria-label={t(picker === "provider" ? "settings.outputProvider" : "settings.outputVoice")} data-testid="voice-settings-picker" use:pickerFocus>
    <ActionsGroup>
      {#if picker === "provider"}
        {#each providers as item}
          <ActionsButton data-value={item} onClick={() => { changeProvider(item); picker = undefined; }}>{item === "alibaba" ? t("settings.outputAlibaba") : item === "bytedance" ? t("settings.outputBytedance") : item === "minimax" ? "MiniMax" : "ElevenLabs"}</ActionsButton>
        {/each}
      {:else}
        <ActionsButton data-value="" onClick={() => { chooseVoice(""); picker = undefined; }}>{t("settings.outputChooseVoice")}</ActionsButton>
        {#each voices as item (item.id)}<ActionsButton data-value={`saved:${item.id}`} onClick={() => { chooseVoice(`saved:${item.id}`); picker = undefined; }}>{item.name}</ActionsButton>{/each}
        <ActionsButton data-value="manual" onClick={() => { chooseVoice("manual"); picker = undefined; }}>{t("settings.outputManualVoice")}</ActionsButton>
      {/if}
    </ActionsGroup>
    <ActionsGroup><ActionsButton bold onClick={() => picker = undefined}>{t("actions.cancel")}</ActionsButton></ActionsGroup>
    </div>
  </Actions>
{/if}
