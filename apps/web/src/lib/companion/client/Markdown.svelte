<script lang="ts">
  import { setContext } from "svelte";
  import SvelteMarkdown, {
    buildUnsupportedHTML,
    defaultRenderers,
  } from "@humanspeak/svelte-markdown";
  import { KatexRenderer } from "@humanspeak/svelte-markdown/extensions/katex";

  import { markdownExtensions } from "./markdown-options.js";
  import MarkdownLink from "./MarkdownLink.svelte";
  import WorkspaceMarkdownImage from "./WorkspaceMarkdownImage.svelte";
  import { english, type CompanionTranslate } from "./locale.js";

  export let text = "";
  export let tokens: import("marked").Token[] | undefined = undefined;
  export let agentReply = false;
  export let workspaceImages = false;
  export let workspaceImageScope: string | undefined = undefined;
  export let t: CompanionTranslate = english;
  setContext("workspaceMarkdown", {
    get enabled() {
      return workspaceImages;
    },
    get t() {
      return t;
    },
  });

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
  $: renderers = {
    ...defaultRenderers,
    link: MarkdownLink,
    image: agentReply ? WorkspaceMarkdownImage : defaultRenderers.image,
    html: buildUnsupportedHTML(),
    inlineKatex: KatexRenderer,
    blockKatex: KatexRenderer,
  };
  const extensions = markdownExtensions;
</script>

<div class="markdown">
  {#key `${workspaceImageScope}:${workspaceImages}`}
    <SvelteMarkdown source={renderTokens ?? text} {renderers} {extensions} />
  {/key}
</div>
