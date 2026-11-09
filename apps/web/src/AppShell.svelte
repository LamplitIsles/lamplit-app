<script lang="ts">
  import type { Snippet } from "svelte";
  import Partner from "./Partner.svelte";
  let { children }: { children?: Snippet } = $props();
</script>

<Partner />
{@render children?.()}
