import { Lexer } from "marked";

export interface SentenceChunk {
  start: number;
  end: number;
  text: string;
}

// Content policy stays fixed when the UI language changes. Markdown is lexed by
// the same parser version as the renderer; only unformatted prose is divided.
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.\s*$/i;
const hasContent = /[\p{L}\p{N}\p{S}]/u;

export function sentenceChunks(text: string): SentenceChunk[] {
  if (!text) return [];
  const whole = () => [{ start: 0, end: text.length, text }];
  const tokens = Lexer.lex(text, { gfm: true });
  // Reference definitions can affect distant paragraphs; normalized source
  // (e.g. CRLF) also stays together rather than guessing source offsets.
  if (
    Object.keys(tokens.links).length ||
    tokens.map((token) => token.raw).join("") !== text
  )
    return whole();
  const chunks: SentenceChunk[] = [];
  let offset = 0;
  let protectedTail = false;
  const append = (raw: string, start: number, prose: boolean) => {
    if (!raw) return;
    const previous = chunks.at(-1);
    if (
      previous &&
      (!hasContent.test(raw) ||
        !hasContent.test(previous.text) ||
        (!prose && protectedTail) ||
        abbreviation.test(previous.text))
    ) {
      previous.end = start + raw.length;
      previous.text += raw;
    } else chunks.push({ start, end: start + raw.length, text: raw });
    if (raw.trim()) protectedTail = !prose;
  };
  for (const token of tokens) {
    // Only the prefix before the first rich/unfinished inline span is safe.
    // Keep its last sentence with the protected remainder: later Markdown must
    // not swallow completed sentences that were already shown before this tail.
    let safeLength =
      token.type === "paragraph" && token.tokens ? token.raw.length : 0;
    if (token.type === "paragraph" && token.tokens) {
      let inlineOffset = 0;
      for (const inline of token.tokens) {
        if (
          inline.type !== "text" ||
          !token.raw.startsWith(inline.raw, inlineOffset)
        ) {
          safeLength = inlineOffset;
          break;
        }
        inlineOffset += inline.raw.length;
      }
      // Includes unfinished delimiters and the renderer's KaTeX extension.
      const syntax = token.raw.search(/[`*_[\]<>$\\]/);
      if (syntax >= 0) safeLength = Math.min(safeLength, syntax);
    }
    const segments = [...segmenter.segment(token.raw.slice(0, safeLength))];
    const tailStart =
      safeLength < token.raw.length
        ? (segments.at(-1)?.index ?? 0)
        : token.raw.length;
    for (const part of segments) {
      if (part.index >= tailStart) break;
      append(part.segment, offset + part.index, true);
    }
    if (tailStart < token.raw.length)
      append(token.raw.slice(tailStart), offset + tailStart, false);
    offset += token.raw.length;
  }
  return chunks;
}
