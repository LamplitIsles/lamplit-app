<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { Button, ListItem, Radio, Toggle } from "konsta/svelte";
  import Sun from "lucide-svelte/icons/sun";
  import Earth from "lucide-svelte/icons/earth";
  import {
    MODELS_PATH,
    MODEL_CHOICES,
    REASONING_EFFORTS,
    type ReasoningEffort,
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
  const choices = $derived(snapshot?.availableModels ?? MODEL_CHOICES);
  const currentEfforts = $derived(
    snapshot?.availableModels?.find((model) => model.id === snapshot?.currentModel)
      ?.reasoningEfforts ?? [],
  );
  const legacyModel = $derived(
    snapshot &&
      !choices.some((model) => model.id === snapshot?.currentModel),
  );

  function choose(model: string, event: Event) {
    // Native radios toggle before change; retain the confirmed selection until saved.
    const input = event.target as HTMLInputElement;
    for (const radio of input
      .closest("ul")!
      .querySelectorAll<HTMLInputElement>('input[name="companion-model"]'))
      radio.checked = radio.value === snapshot?.currentModel;
    if (snapshot) {
      const effort = snapshot.reasoningEffort;
      const supported = snapshot.availableModels?.find(
        (choice) => choice.id === model,
      )?.reasoningEfforts;
      let nextEffort = effort;
      if (snapshot.availableModels && effort && !supported?.includes(effort)) {
        nextEffort = null;
      }
      void save(model, snapshot.fast, nextEffort);
    }
  }

  function chooseFast(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const fast = input.checked;
    input.checked = snapshot?.fast === true;
    if (snapshot) void save(snapshot.currentModel, fast);
  }

  function chooseEffort(event: Event) {
    const input = event.currentTarget as HTMLSelectElement;
    const effort = (input.value || null) as ReasoningEffort | null;
    input.value = snapshot?.reasoningEffort ?? "";
    if (snapshot) void save(snapshot.currentModel, snapshot.fast, effort);
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

  async function save(
    model: string,
    fast: boolean,
    effort = snapshot?.reasoningEffort,
  ) {
    if (
      locked ||
      !snapshot ||
      (model === snapshot.currentModel &&
        fast === snapshot.fast &&
        effort === snapshot.reasoningEffort)
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
          ...(snapshot.availableModels && {
            expectedReasoningEffort: snapshot.reasoningEffort,
            reasoningEffort: effort,
          }),
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
  function switchSemantics(node: HTMLElement, state: { phase: string; hasStatus: boolean }) {
    let mounted = true;
    const update = (next: typeof state) => {
      void tick().then(() => {
        if (!mounted) return;
        const input = node.querySelector("input");
        if (!input) return;
        input.setAttribute("role", "switch");
        if (next.hasStatus) input.setAttribute("aria-describedby", "model-status");
        else input.removeAttribute("aria-describedby");
      });
    };
    update(state);
    return { update, destroy() { mounted = false; } };
  }
  function modelDescriptions(node: HTMLElement, hasStatus: boolean) {
    const update = (show: boolean) => {
      for (const input of node.querySelectorAll('input[name="companion-model"]')) {
        if (show) input.setAttribute("aria-describedby", "model-status");
        else input.removeAttribute("aria-describedby");
      }
    };
    update(hasStatus);
    return { update };
  }
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
      use:modelDescriptions={!!status}
    >
      {#each choices as model}
        <Radio class="model-option" title={model.name}
            name="companion-model"
            value={model.id}
            checked={snapshot?.currentModel === model.id}
            disabled={locked}
            onChange={(event: Event) => choose(model.id, event)}>
          {#if model.id.endsWith("-terra")}
            <Earth size={14} strokeWidth={1.8} aria-hidden="true" />
          {:else}
            <Sun size={14} strokeWidth={1.8} aria-hidden="true" />
          {/if}
          <span>{model.name}</span>
        </Radio>
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
          <Button rounded
            type="button"
            class="button button-round"
            disabled={phase === "loading" || phase === "saving"}
            onClick={load}
          >
            {t("models.reload")}
          </Button>
        {/if}
      </div>
    {/if}
  </li>
  {#if snapshot?.availableModels}
    <li class="reasoning-setting">
      <label class="reasoning-row">
        <span>{t("models.reasoning")}</span>
        <select
          value={snapshot.reasoningEffort ?? ""}
          disabled={locked || legacyModel}
          aria-describedby={status ? "model-status" : undefined}
          onchange={chooseEffort}
        >
          <option value="">{t("models.reasoningDefault")}</option>
          {#each REASONING_EFFORTS.filter((effort) => currentEfforts.includes(effort)) as effort}
            <option value={effort}>{t(`models.effort.${effort}`)}</option>
          {/each}
        </select>
      </label>
    </li>
  {/if}
  <li class="fast-setting">
    <div class="fast-row" use:switchSemantics={{ phase, hasStatus: !!status }}>
      <span>Fast</span>
      {#key phase}
        <Toggle
          checked={snapshot?.fast === true}
          disabled={locked || legacyModel}
          onChange={chooseFast}
        ><span class="sr-only">Fast</span></Toggle>
      {/key}
    </div>
  </li>
{/if}

<style>
  .model-settings {
    padding-bottom: 8px;
  }
  .model-options {
    display: flex;
    flex-direction: column;
    padding: 0 16px;
  }
  .fast-row,
  .reasoning-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--companion-list-item-min-height, 44px);
    padding: 0 16px;
    cursor: pointer;
  }
  .fast-row:has(:global(input:disabled)),
  .reasoning-row:has(select:disabled) {
    cursor: default;
    opacity: 0.55;
  }
  .reasoning-row {
    gap: 8px;
  }
  .reasoning-row span {
    min-width: 0;
  }
  .reasoning-row select {
    flex-shrink: 0;
    max-width: 100%;
    min-height: 36px;
    padding: 0 8px;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 6px;
    font: inherit;
  }
  .reasoning-row select:focus-visible {
    outline: 2px solid var(--k-color-primary);
    outline-offset: 2px;
  }
  .model-options :global(.model-option) {
    display: flex;
    position: relative;
    min-width: 0;
    min-height: 44px;
    width: 100%;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    color: inherit;
  }
  .model-options :global(.model-option:has(input:focus-visible)) {
    outline: 2px solid var(--k-color-primary);
    outline-offset: 2px;
  }
  .model-options :global(.model-option:has(input:disabled)) {
    cursor: default;
    opacity: 0.55;
  }
  .model-options :global(.model-option > span) {
    font-size: 16px;
    font-variant-numeric: tabular-nums;
  }
  .model-settings-content {
    padding: 0 16px 12px;
  }
  p {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: inherit;
    overflow-wrap: anywhere;
  }
  #model-status:empty {
    display: none;
  }
  .model-settings-content :global(button) {
    min-height: 40px;
    margin-top: 8px;
  }
  .model-settings-content :global(button:disabled) {
    opacity: 0.45;
    pointer-events: none;
  }
</style>
