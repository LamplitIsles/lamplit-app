<script lang="ts">
  import { getContext } from "svelte";
  import type { Component } from "svelte";
  import type { A2uiComponentProps } from "svelte-a2ui";
  let { ...props }: A2uiComponentProps = $props();
  const originals = getContext<Record<string, Component<any>>>(
    "a2ui-original-components",
  );
  const Original = $derived(originals[props.a2ui.component]);
  let wrapper = $state<HTMLDivElement>();
  $effect(() => {
    const accessibility = props.accessibility as
      | {
          label?: string;
          description?: string;
          live?: "off" | "polite" | "assertive";
        }
      | undefined;
    const target = wrapper?.firstElementChild;
    if (!target || !accessibility || props.a2ui.component === "Modal") return;
    if (typeof accessibility.label === "string")
      target.setAttribute("aria-label", accessibility.label);
    if (typeof accessibility.description === "string")
      target.setAttribute("aria-description", accessibility.description);
    if (accessibility.live)
      target.setAttribute("aria-live", accessibility.live);
  });
</script>

<div bind:this={wrapper} style="display: contents"><Original {...props} /></div>
