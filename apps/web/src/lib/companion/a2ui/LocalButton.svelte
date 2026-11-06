<script lang="ts">
  import { Button } from "framework7-svelte";
  import { Slot, type A2uiComponentProps } from "svelte-a2ui";
  let { slots, variant = "default", ariaLabel }: A2uiComponentProps = $props();
</script>

<Button
  type="button"
  fill={variant === "primary"}
  outline={variant === "default"}
  aria-label={typeof ariaLabel === "string" ? ariaLabel : undefined}
  ><Slot content={slots.child} /></Button
>
