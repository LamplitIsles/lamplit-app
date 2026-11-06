<script lang="ts">
  import { Button, Page, Popup } from "framework7-svelte";
  import { getContext, onMount } from "svelte";
  import type { Popup as PopupTypes } from "framework7/types";
  import { Slot, type A2uiComponentProps } from "svelte-a2ui";
  let { slots, ariaLabel, accessibility, a2ui }: A2uiComponentProps = $props();
  const aria = $derived(
    accessibility as
      | { description?: string; live?: "off" | "polite" | "assertive" }
      | undefined,
  );
  const locale = getContext<() => string>("a2ui-locale") ?? (() => "en");
  let open = $state(false);
  let popup: PopupTypes.Popup | undefined;
  const notifyModal =
    getContext<(id: string, open: boolean) => void>("a2ui-modal-state");
  const register = getContext<(close: () => void) => () => void>(
    "a2ui-modal-registration",
  );
  onMount(() => {
    const close = () => {
      if (popup?.opened) popup.close(false);
      open = false;
      notifyModal?.(a2ui.id, false);
    };
    const unregister = register?.(close);
    return () => {
      close();
      unregister?.();
    };
  });
</script>

<!-- Trigger is the validated, keyboard-operable Button; click bubbles here. -->
<div
  class="a2ui-modal-trigger"
  onclick={() => (open = true)}
  role="presentation"
>
  <Slot content={slots.trigger} />
</div>
<Popup
  opened={open}
  animate={false}
  closeOnEscape
  role="dialog"
  aria-modal="true"
  aria-label={typeof ariaLabel === "string"
    ? ariaLabel
    : locale() === "zh"
      ? "详情"
      : "Details"}
  onPopupOpen={(instance) => {
    popup = instance;
    if (aria?.description)
      instance?.el.setAttribute("aria-description", aria.description);
    if (aria?.live) instance?.el.setAttribute("aria-live", aria.live);
    notifyModal?.(a2ui.id, true);
  }}
  onPopupClosed={() => {
    open = false;
    notifyModal?.(a2ui.id, false);
  }}
>
  <Page
    ><div class="a2ui-modal-content">
      <Slot content={slots.content} /><Button
        type="button"
        outline
        onClick={() => (open = false)}
        >{locale() === "zh" ? "关闭" : "Close"}</Button
      >
    </div></Page
  >
</Popup>

<style>
  .a2ui-modal-content {
    padding: 1rem;
  }
</style>
