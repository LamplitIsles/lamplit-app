<script lang="ts">
  import { onMount } from "svelte";
  import Markdown from "./Markdown.svelte";
  import type { CompanionTranslate } from "./locale.js";

  export let text: string;
  export let id: string;
  export let t: CompanionTranslate;
  let expanded = false;
  let truncated = false;
  let content: HTMLDivElement;

  function stopHold(node: HTMLButtonElement) {
    const stop = (event: Event) => event.stopPropagation();
    node.addEventListener("taphold", stop);
    return { destroy: () => node.removeEventListener("taphold", stop) };
  }

  onMount(() => {
    const observer = new ResizeObserver(() => {
      truncated =
        content.getBoundingClientRect().height >
        2 * parseFloat(getComputedStyle(content).lineHeight) + 1;
    });
    observer.observe(content);
    return () => observer.disconnect();
  });
</script>

<div
  id={`reminder-body-${encodeURIComponent(id)}`}
  class="companion-reminder-body"
  class:collapsed={!expanded}
>
  <div bind:this={content}><Markdown {text} /></div>
</div>
{#if truncated}
  <button
    type="button"
    class="button companion-reminder-toggle"
    aria-expanded={expanded}
    aria-controls={`reminder-body-${encodeURIComponent(id)}`}
    on:pointerdown|stopPropagation
    on:touchstart|stopPropagation
    use:stopHold
    on:contextmenu|stopPropagation|preventDefault
    on:keydown|stopPropagation
    on:click|stopPropagation={() => (expanded = !expanded)}
    >{t(expanded ? "reminder.collapse" : "reminder.expand")}</button
  >
{/if}
