<script lang="ts">
  import SvelteMarkdown, {
    buildUnsupportedHTML,
    defaultRenderers,
  } from "@humanspeak/svelte-markdown";
  import { KatexRenderer } from "@humanspeak/svelte-markdown/extensions/katex";

  import { markdownExtensions } from "./markdown-options.js";
  import MarkdownLink from "./MarkdownLink.svelte";

  export let text = "";
  export let tokens: import("marked").Token[] | undefined = undefined;

  // Keep one prior render value per display message. Compare complete parsed
  // semantics (including resolved references), never source text alone.
  let previousTokens: typeof tokens;
  let previousSignature: string | undefined;
  function retainTokens(next: typeof tokens) {
    const signature = next === undefined ? undefined : JSON.stringify(next);
    if (signature !== previousSignature) {
      previousSignature = signature;
      previousTokens = next;
    }
    return previousTokens;
  }
  $: renderTokens = retainTokens(tokens);

  // Matches Sliqs: render Markdown tokens as Svelte nodes, never via
  // browser-parsed HTML strings. Raw HTML remains unsupported.
  const renderers = {
    ...defaultRenderers,
    link: MarkdownLink,
    html: buildUnsupportedHTML(),
    inlineKatex: KatexRenderer,
    blockKatex: KatexRenderer,
  };
  const extensions = markdownExtensions;
</script>

<div class="markdown">
  <SvelteMarkdown source={renderTokens ?? text} {renderers} {extensions} />
</div>
