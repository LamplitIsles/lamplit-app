import { IncrementalParser } from "@humanspeak/svelte-markdown";
import { Lexer, Marked, type Token } from "marked";
import { markedKatex } from "@humanspeak/svelte-markdown/extensions/katex";

export const markdownExtensions = [markedKatex({ singleDollarInline: true })];
export const markdownOptions = new Marked(...markdownExtensions).defaults;

// Source spelling and shared references belong to this full semantic tree.
export function lexMarkdown(source: string) {
  return Lexer.lex(source, markdownOptions);
}

export function cleanMarkdownProjection(tokens: Token[]): Token[] {
  if (!tokens.length) return [];
  let next = 0;
  // Feed the already projected semantic blocks through the public parser's
  // cleanup, without block-lexing isolated continuation lines a second time.
  // HTML normalization may change raw spelling, lengths and tree shape here;
  // none of those render changes participates in source mapping.
  return new IncrementalParser({
    ...markdownOptions,
    extensions: {
      renderers: {},
      childTokens: {},
      ...markdownOptions.extensions,
      block: [() => tokens[next++]],
    },
  }).update(tokens.map((token) => token.raw).join("")).tokens;
}
