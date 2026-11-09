<script lang="ts">
  import { Button, Page, Popup } from "konsta/svelte";
  import { getContext, onMount, tick } from "svelte";
  import { overlayOpening, overlayOpened, overlayClosed, overlayIsTop } from "../client/overlay-focus.ts";
  import { Slot, type A2uiComponentProps } from "svelte-a2ui";
  let { slots, ariaLabel, accessibility, a2ui }: A2uiComponentProps = $props();
  const aria = $derived(
    accessibility as
      | { description?: string; live?: "off" | "polite" | "assertive" }
      | undefined,
  );
  const locale = getContext<() => string>("a2ui-locale") ?? (() => "en");
  let open = $state(false);
  let dialog = $state<HTMLElement>();
  const notifyModal =
    getContext<(id: string, open: boolean) => void>("a2ui-modal-state");
  const register = getContext<(close: () => void) => () => void>(
    "a2ui-modal-registration",
  );
  onMount(() => {
    const unregister = register?.(close);
    return () => {
      close();
      unregister?.();
    };
  });
  async function show() {
    open = true;
    notifyModal?.(a2ui.id, true);
    await tick();
    if (open && dialog) {
      if (aria?.description) dialog.setAttribute("aria-description", aria.description);
      overlayOpening({ el: dialog });
      overlayOpened({ el: dialog });
    }
  }
  function close() {
    if (!open) return;
    if (dialog) overlayClosed({ el: dialog });
    open = false;
    notifyModal?.(a2ui.id, false);
  }
  function keydown(event: KeyboardEvent) {
    if (open && dialog && overlayIsTop(dialog) && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={keydown} />
<!-- Trigger is the validated, keyboard-operable Button; click bubbles here. -->
<div
  class="a2ui-modal-trigger"
  onclick={() => void show()}
  role="presentation"
>
  <Slot content={slots.trigger} />
</div>
{#if open}
<Popup
  opened
  onBackdropClick={close}
  class="a2ui-modal"
>
  <div bind:this={dialog}
  role="dialog"
  aria-modal="true"
  aria-live={aria?.live}
  aria-label={typeof ariaLabel === "string"
    ? ariaLabel
    : locale() === "zh"
      ? "详情"
      : "Details"}>
  <Page
    ><div class="a2ui-modal-content">
      <Slot content={slots.content} /><Button
        type="button"
        outline
        onClick={close}
        >{locale() === "zh" ? "关闭" : "Close"}</Button
      >
    </div></Page
  ></div>
</Popup>
{/if}

<style>
  .a2ui-modal-content {
    padding: 1rem;
  }
</style>
