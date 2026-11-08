<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";

  let {
    active,
    exitMs,
    onExited,
    children,
  }: {
    active: boolean;
    exitMs: number;
    onExited?: () => void;
    children: Snippet<[boolean]>;
  } = $props();

  let present = $state(false);
  let opened = $state(false);
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function clearPending() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function syncActive(next: boolean) {
    clearPending();
    const current = ++generation;
    if (next) {
      if (present) {
        opened = true;
      } else {
        present = true;
        // Paint the component's closed state before applying Konsta's open state.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (generation === current) opened = true;
          });
        });
      }
    } else if (present) {
      opened = false;
      const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : exitMs;
      timer = setTimeout(() => {
        if (generation === current) {
          present = false;
          onExited?.();
        }
      }, duration);
    }
  }

  $effect(() => {
    const next = active;
    untrack(() => syncActive(next));
  });

  onDestroy(() => {
    generation++;
    clearPending();
  });
</script>

{#if present}
  {@render children(opened)}
{/if}
