<script lang="ts">
  import Markdown from "./Markdown.svelte";
  export let text: string;
</script>

<details class="companion-thinking">
  <summary>不许你看的小想法</summary>
  <Markdown {text} />
</details>
