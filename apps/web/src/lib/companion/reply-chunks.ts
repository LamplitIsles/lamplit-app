import { Lexer, type Token } from "marked";

export interface ReplyChunk {
  start: number;
  end: number;
  /** Exact UTF-16 source span, including original whitespace/quote markers. */
  text: string;
  /** Shared-reference, math-aware render projection; never copied or persisted. */
  tokens: Token[];
}

const hasContent = (raw: string) =>
  raw.replace(/^ {0,3}>[ \t]?/gm, "").trim().length > 0;

export function replyChunks(
  source: string,
  parse: (source: string) => Token[] = (source) =>
    Lexer.lex(source, { gfm: true }),
  clean: (tokens: Token[]) => Token[] = (tokens) => tokens,
  streaming = false,
): ReplyChunk[] {
  // Hold the unfinished source line before parsing, so partial Markdown cannot
  // change the visible structure. Final/history callers retain the exact tail.
  if (streaming) source = source.slice(0, source.lastIndexOf("\n") + 1);
  if (!source) return [];
  // Marked normalizes line endings. Keep a boundary map back to original UTF-16.
  let text = "";
  const original = [0];
  for (let i = 0; i < source.length; i++) {
    text += source[i] === "\r" ? "\n" : source[i];
    if (source[i] === "\r" && source[i + 1] === "\n") i++;
    original.push(i + 1);
  }
  if (!hasContent(text)) return [];
  // Boundary detection and clipping use only pre-cleanup source tokens.
  const parsed = parse(text);
  const starts = [0];
  const leaves: { token: Token; map: number[]; wrappers: Token[] }[] = [];
  const add = (at: number) => {
    const last = starts.at(-1)!;
    if (at <= last || at >= text.length) return;
    const raw = text.slice(last, at);
    if (hasContent(raw)) starts.push(at);
  };
  function prose(raw: string, inlines: Token[], map: number[]) {
    // Newlines inside a complete inline token belong to that local structure.
    // An open delimiter protects only the paragraph's unfinished tail.
    const protectedSpans: [number, number][] = [];
    const html: { tag: string; start: number }[] = [];
    let offset = 0;
    for (const inline of inlines) {
      if (!raw.startsWith(inline.raw, offset)) return;
      // Marked emits inline HTML opens/closes separately. Keep their required
      // source context together so cleanup sees the same pair as whole mode.
      if (inline.type === "html") {
        const tag = inline.raw.match(/^<(\/?)([a-zA-Z][\w-]*)(?=[\s/>])/);
        if (
          tag &&
          !inline.raw.endsWith("/>") &&
          !/^(br|hr|img|input|link|meta|area|base|col|embed|keygen|param|source|track|wbr)$/i.test(
            tag[2],
          )
        ) {
          if (!tag[1]) html.push({ tag: tag[2], start: offset });
          else {
            const open = html.pop();
            if (open?.tag === tag[2])
              protectedSpans.push([open.start, offset + inline.raw.length]);
          }
        }
      }
      if (inline.type !== "text")
        protectedSpans.push([offset, offset + inline.raw.length]);
      else {
        let consumed = 0;
        for (const match of inline.raw.matchAll(
          /\*\*|__|(?<![\p{L}\p{N}])[*_](?=\S)|`+|\[/gu,
        )) {
          if (match.index < consumed) continue;
          const marker = match[0];
          const close = inline.raw.indexOf(
            marker === "[" ? "]" : marker,
            match.index + marker.length,
          );
          if (
            close < 0 ||
            (marker === "[" &&
              inline.raw[close + 1] === "(" &&
              !inline.raw.includes(")", close + 2))
          ) {
            protectedSpans.push([offset + match.index, raw.length]);
            break;
          }
          consumed = close + marker.length;
        }
      }
      offset += inline.raw.length;
    }
    for (const open of html) protectedSpans.push([open.start, raw.length]);
    for (const newline of raw.matchAll(/\n/g)) {
      const end = newline.index + 1;
      if (
        end < raw.length &&
        !protectedSpans.some(([start, stop]) => start < end && end < stop)
      )
        add(map[end]);
    }
  }

  function blocks(
    tokens: Token[],
    raw: string,
    map: number[],
    wrappers: Token[] = [],
  ) {
    let cursor = 0;
    let seenBlock = false;
    for (const token of tokens) {
      const at = raw.indexOf(token.raw, cursor);
      if (at < 0) return; // Unmappable unusual syntax stays in its current block.
      cursor = at + token.raw.length;
      if (token.type === "space" || token.type === "def") continue;
      if (seenBlock) add(map[at]);
      seenBlock = true;
      if (token.type === "paragraph" && token.tokens) {
        leaves.push({ token, map: map.slice(at, cursor + 1), wrappers });
        prose(token.raw, token.tokens, map.slice(at, cursor + 1));
      } else if (token.type === "blockquote" && token.tokens) {
        // Remove one quote level while retaining every source boundary. Lazy
        // continuation lines have no prefix to remove; nested quotes recurse.
        let body = "";
        const bodyMap: number[] = [];
        let lineAt = 0;
        for (const line of token.raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
          const prefix = line.match(/^ {0,3}>[ \t]?/)?.[0].length ?? 0;
          for (let i = prefix; i < line.length; i++) {
            bodyMap.push(map[at + lineAt + (i === prefix ? 0 : i)]);
            body += line[i];
          }
          lineAt += line.length;
        }
        bodyMap.push(map[cursor]);
        if (body.trimEnd() === token.text.trimEnd()) {
          blocks(token.tokens, body, bodyMap, [...wrappers, token]);
        } else leaves.push({ token, map: map.slice(at, cursor + 1), wrappers });
      } else leaves.push({ token, map: map.slice(at, cursor + 1), wrappers });
    }
  }
  blocks(
    parsed,
    text,
    Array.from({ length: text.length + 1 }, (_, i) => i),
  );
  // Blank lines and empty quote lines never open an empty display message.
  if (starts.length > 1 && !hasContent(text.slice(starts.at(-1)!)))
    starts.pop();
  return starts.map((at, index) => {
    const end = starts[index + 1] ?? text.length;
    const tokens = leaves.flatMap(({ token, map, wrappers }) => {
      if (map[0] >= end || map.at(-1)! <= at) return [];
      let projected = token;
      if (token.type === "paragraph" && token.tokens) {
        const from =
          at <= map[0] ? 0 : map.findIndex((position) => position >= at);
        const stop =
          end >= map.at(-1)!
            ? token.raw.length
            : map.findIndex((position) => position >= end);
        const raw = token.raw.slice(from, stop).replace(/\n+$/, "");
        const limit = from + raw.length;
        let offset = 0;
        const inlines = token.tokens.flatMap((inline) => {
          const start = offset;
          offset += inline.raw.length;
          const left = Math.max(from, start),
            right = Math.min(limit, offset);
          if (left >= right) return [];
          if (left === start && right === offset) return [inline];
          const raw = inline.raw.slice(left - start, right - start);
          return [{ ...inline, raw, text: raw }];
        });
        projected = { ...token, raw, text: raw, tokens: inlines };
      }
      for (const wrapper of [...wrappers].reverse()) {
        projected = {
          ...wrapper,
          raw: projected.raw,
          text: projected.raw,
          tokens: [projected],
        };
      }
      return [projected];
    });
    return {
      start: original[at],
      end: original[end],
      text: source.slice(original[at], original[end]),
      tokens: clean(tokens),
    };
  });
}
