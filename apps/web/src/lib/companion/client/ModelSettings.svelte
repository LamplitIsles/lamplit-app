<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ListItem } from "framework7-svelte";
  import Sun from "lucide-svelte/icons/sun";
  import Earth from "lucide-svelte/icons/earth";
  import {
    MODELS_PATH,
    MODEL_CHOICES,
    validateModelSettings,
    type ModelSettings,
  } from "../../model-settings.ts";
  import type { CompanionTranslate, CompanionLocaleKey } from "./locale.ts";

  let {
    t,
    busy = false,
    sessionId,
    open,
    onSupportChange = () => {},
  }: {
    t: CompanionTranslate;
    busy?: boolean;
    sessionId: string;
    open: boolean;
    onSupportChange?: (supported: boolean) => void;
  } = $props();
  let snapshot = $state<ModelSettings>();
  let phase = $state<"loading" | "ready" | "saving" | "error" | "unsupported">(
    "loading",
  );
  let message = $state<CompanionLocaleKey>();
  let request: AbortController | undefined;
  let disposed = false;
  const locked = $derived(phase !== "ready" || busy || !!snapshot?.busy);
  const status = $derived(
    message ??
      (phase === "loading"
        ? "models.loading"
        : phase === "saving"
          ? "models.saving"
          : busy || snapshot?.busy
            ? "models.busy"
            : undefined),
  );
  const legacyModel = $derived(
    snapshot &&
      !MODEL_CHOICES.some((model) => model.id === snapshot?.currentModel),
  );

  function choose(model: string, event: Event) {
    // Native radios toggle before change; retain the confirmed selection until saved.
    const input = event.target as HTMLInputElement;
    for (const radio of input
      .closest("ul")!
      .querySelectorAll<HTMLInputElement>('input[name="companion-model"]'))
      radio.checked = radio.value === snapshot?.currentModel;
    if (snapshot) void save(model, snapshot.fast);
  }

  function chooseFast(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const fast = input.checked;
    input.checked = snapshot?.fast === true;
    if (snapshot) void save(snapshot.currentModel, fast);
  }

  async function load() {
    if (phase === "saving") return;
    request?.abort();
    const current = (request = new AbortController());
    phase = "loading";
    message = undefined;
    try {
      const response = await fetch(MODELS_PATH, {
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
      if (!response.ok) throw new Error("Model settings unavailable");
      const value = validateModelSettings(await response.json());
      if (value.sessionId !== sessionId) throw new Error("Session changed");
      if (disposed || request !== current) return;
      snapshot = value;
      onSupportChange(true);
      phase = "ready";
    } catch {
      if (disposed || request !== current || current.signal.aborted) return;
      phase = "error";
      onSupportChange(true);
      message = "models.loadFailed";
    }
  }

  async function save(model: string, fast: boolean) {
    if (
      locked ||
      !snapshot ||
      (model === snapshot.currentModel && fast === snapshot.fast)
    )
      return;
    const current = (request = new AbortController());
    phase = "saving";
    message = undefined;
    try {
      const response = await fetch(MODELS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: current.signal,
        body: JSON.stringify({
          sessionId: snapshot.sessionId,
          expectedModel: snapshot.currentModel,
          expectedFast: snapshot.fast,
          model,
          fast,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        if (disposed) return;
        message =
          body?.error?.code === "stale_model"
            ? "models.stale"
            : body?.error?.code === "model_busy"
              ? "models.busy"
              : "models.saveFailed";
        phase = "error";
        return;
      }
      const value = validateModelSettings(await response.json());
      if (value.sessionId !== sessionId) throw new Error("Session changed");
      if (disposed) return;
      snapshot = value;
      phase = "ready";
    } catch {
      if (disposed) return;
      phase = "error";
      message = "models.saveFailed";
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
  <ListItem groupTitle title={t("models.title")} />
  <li class="model-settings">
    <div
      class="model-options"
      role="radiogroup"
      aria-label={t("models.title")}
      aria-busy={phase === "loading" || phase === "saving"}
    >
      {#each MODEL_CHOICES as model}
        <label class="model-option" title={model.name}>
          <input
            type="radio"
            name="companion-model"
            value={model.id}
            aria-label={model.name}
            aria-describedby={status ? "model-status" : undefined}
            checked={snapshot?.currentModel === model.id}
            disabled={locked}
            onchange={(event) => choose(model.id, event)}
          />
          {#if model.id === "gpt-6.1-terra"}
            <Earth size={14} strokeWidth={1.8} aria-hidden="true" />
          {:else}
            <Sun size={14} strokeWidth={1.8} aria-hidden="true" />
          {/if}
          <span>{model.version}</span>
        </label>
      {/each}
    </div>
    {#if legacyModel || status || phase === "error" || busy || snapshot?.busy}
      <div class="model-settings-content">
        {#if legacyModel && snapshot}
          <p class="model-current">
            {t("models.current", { model: snapshot.currentModel })}
          </p>
          <p>{t("models.chooseSupported")}</p>
        {/if}
        {#if status}<p id="model-status" role="status" aria-live="polite">
            {t(status)}
          </p>{/if}
        {#if phase === "error" || busy || snapshot?.busy}
          <button
            type="button"
            class="button button-round"
            disabled={phase === "loading" || phase === "saving"}
            onclick={load}
          >
            {t("models.reload")}
          </button>
        {/if}
      </div>
    {/if}
  </li>
  <li class="fast-setting">
    <label class="fast-row">
      <span>Fast</span>
      <span class="toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label="Fast"
          aria-describedby={status ? "model-status" : undefined}
          checked={snapshot?.fast === true}
          disabled={locked || legacyModel}
          onchange={chooseFast}
        />
        <span class="toggle-icon"></span>
      </span>
    </label>
  </li>
{/if}

<style>
  .model-settings {
    padding-bottom: 8px;
  }
  .model-options {
    display: flex;
    gap: 8px;
    height: var(--f7-list-item-min-height, 44px);
    padding: 0 16px;
  }
  .fast-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--f7-list-item-min-height, 44px);
    padding: 0 16px;
    cursor: pointer;
  }
  .fast-row .toggle input {
    display: block;
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .fast-row .toggle:has(input:focus-visible) {
    outline: 2px solid var(--f7-theme-color);
    outline-offset: 2px;
  }
  .fast-row:has(input:disabled) {
    cursor: default;
    opacity: 0.55;
  }
  .model-option {
    display: flex;
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 2px;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    color: var(--f7-text-color);
  }
  .model-option input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .model-option:has(input:checked) {
    color: var(--f7-theme-color);
    background: color-mix(in srgb, var(--f7-theme-color) 9%, transparent);
    border-color: color-mix(in srgb, var(--f7-theme-color) 38%, transparent);
  }
  .model-option:has(input:focus-visible) {
    outline: 2px solid var(--f7-theme-color);
    outline-offset: 2px;
  }
  .model-option:has(input:disabled) {
    cursor: default;
    opacity: 0.55;
  }
  .model-option span {
    font-size: 9px;
    line-height: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .model-settings-content {
    padding: 0 16px 12px;
  }
  p {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--f7-list-item-footer-text-color);
    overflow-wrap: anywhere;
  }
  #model-status:empty {
    display: none;
  }
  button {
    min-height: 40px;
    margin-top: 8px;
  }
  button:disabled {
    opacity: 0.45;
    pointer-events: none;
  }
</style>
