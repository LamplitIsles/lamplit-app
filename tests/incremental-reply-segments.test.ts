import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
import * as marked from "../packages/contracts/node_modules/marked";
const { createReplySegmenter, stableReplySegments } = await import("../packages/contracts/src/reply-chunks.ts");

const key = { sessionId: "s", sourceId: "answer", attemptId: "attempt" };

test("unpublished source may be rewritten before final publication", () => {
  const segmenter = createReplySegmenter();
  expect(segmenter.update(key, "unfinished final answer", false).segments).toEqual([]);
  const final = segmenter.update(key, "completed final answer", true);
  expect(final.status).toBe("ok");
  expect(final.segments.map(segment => segment.text)).toEqual(["completed final answer"]);
});

test("rewriting an unpublished multiline block preserves already published segments", () => {
  const segmenter = createReplySegmenter();
  const old = "😀 published\r\n\n```js\nold line\n";
  const changed = "😀 published\r\n\n```ts\nnew line\n";
  const initial = segmenter.update(key, old, false);
  expect(initial.segments.map(segment => segment.text)).toEqual(["😀 published\r\n"]);
  const rewritten = segmenter.update(key, changed, false);
  expect(rewritten.status).toBe("ok");
  expect(rewritten.segments).toEqual(initial.segments);
  const finalSource = changed + "```\nlast";
  const final = segmenter.update(key, finalSource, true);
  expect(final.status).toBe("ok");
  expect(final.segments).toEqual(stableReplySegments(finalSource, true));
  expect(final.segments.slice(0, initial.segments.length)).toEqual(initial.segments);
});

test("rewrites rescan a held table and partial UTF-16/CRLF without altering prior lines", () => {
  const segmenter = createReplySegmenter();
  const first = "safe\r\n";
  expect(segmenter.update(key, first + "| Old |\n|---|\n| x |\n", false).segments.map(item => item.text)).toEqual([first]);
  expect(segmenter.update(key, first + "| New |\n|---|\n| y |\n", false).segments.map(item => item.text)).toEqual([first]);
  const complete = first + "| New |\n|---|\n| y |\n\nnext\n";
  expect(segmenter.update(key, complete, true).segments).toEqual(stableReplySegments(complete, true));

  const unicode = createReplySegmenter();
  expect(unicode.update(key, first + "\ud83d", false).segments.map(item => item.text)).toEqual([first]);
  expect(unicode.update(key, first + "🙂\r", false).segments.map(item => item.text)).toEqual([first]);
  expect(unicode.update(key, first + "🙂\r\n", false).segments.map(item => item.text)).toEqual([first, "🙂\r\n"]);
});

test("growing source only lexes newly completed units, including a held block", () => {
  const original = marked.Lexer.lex;
  let calls = 0;
  marked.Lexer.lex = function (...args) { calls++; return original(...args); };
  try {
    const segmenter = createReplySegmenter();
    let source = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join("");
    const initial = segmenter.update(key, source, false);
    expect(initial.status).toBe("ok");
    expect(initial.segments.length).toBe(200);
    expect(calls).toBe(200);
    for (const delta of ["tail", " grows", " more"]) {
      source += delta;
      expect(segmenter.update(key, source, false).segments).toEqual(initial.segments);
    }
    expect(calls).toBe(200);
    source += "\n```js\n";
    const open = segmenter.update(key, source, false);
    expect(open.segments.length).toBe(201);
    expect(calls).toBe(201);
    for (const line of ["one\n", "two\n", "three\n"]) {
      source += line;
      expect(segmenter.update(key, source, false).segments).toEqual(open.segments);
    }
    expect(calls).toBe(201);
    source += "```\n";
    expect(segmenter.update(key, source, false).segments.length).toBe(202);
    expect(calls).toBe(202);
  } finally { marked.Lexer.lex = original; }
});

test("incremental slices match the existing projection at every source prefix", () => {
  const source = "\r\n😀 line\r\nA | B\n--- | ---\n| A |\n|---|\n| row |\n\n- a\n- b\n\n```js\n🙂\n```\nlast\n\n";
  const segmenter = createReplySegmenter();
  let previous: ReturnType<typeof stableReplySegments> = [];
  for (let i = 0; i <= source.length; i++) {
    const next = segmenter.update(key, source.slice(0, i), false);
    expect(next.status).toBe("ok");
    expect(next.segments).toEqual(stableReplySegments(source.slice(0, i), false));
    expect(next.segments.slice(0, previous.length)).toEqual(previous);
    let end = 0;
    for (const segment of next.segments) {
      expect(segment.start).toBe(end);
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
      if (segment.end < source.length) {
        const a = source.charCodeAt(segment.end - 1), b = source.charCodeAt(segment.end);
        expect(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff).toBe(false);
      }
      end = segment.end;
    }
    previous = next.segments;
  }
  expect(segmenter.update(key, source, true).segments).toEqual(stableReplySegments(source, true));
});

test("rewrites conflict and new identities require a fresh projection", () => {
  const segmenter = createReplySegmenter();
  const initial = segmenter.update(key, "first\n", false);
  const conflict = segmenter.update(key, "changed\n", false);
  expect(conflict.status).toBe("conflict");
  expect(conflict.segments).toEqual(initial.segments);
  expect(segmenter.update(key, "first\nlast", true).segments.map(s => s.text)).toEqual(["first\n", "last"]);
  expect(segmenter.update(key, "first\nlast", true).status).toBe("ok");
  expect(segmenter.update(key, "first\nlast", false).status).toBe("conflict");
  expect(segmenter.update(key, "first\nlast more", true).status).toBe("conflict");
  for (const other of [
    { ...key, attemptId: "retry" },
    { ...key, sessionId: "other" },
    { ...key, sourceId: "other-source" },
  ]) {
    expect(segmenter.update(other, "new\n", false)).toEqual({ status: "identity-changed", segments: [] });
    const fresh = createReplySegmenter().update(other, "new\n", false);
    expect(fresh.status).toBe("ok");
    expect(fresh.segments.map(s => s.text)).toEqual(["new\n"]);
  }
  expect(segmenter.update(key, "first\nlast", true).segments.map(s => s.text)).toEqual(["first\n", "last"]);
});

test("independent callers retain separate sessions and incomplete UTF-16 and CRLF tails", () => {
  const first = createReplySegmenter(), second = createReplySegmenter();
  expect(first.update(key, "😀\r", false).segments).toEqual([]);
  expect(second.update({ ...key, sessionId: "other" }, "other\n", false).segments.map(s => s.text)).toEqual(["other\n"]);
  expect(first.update(key, "😀\r\n\ud83d", false).segments.map(s => s.text)).toEqual(["😀\r\n"]);
  expect(first.update(key, "😀\r\n🙂\n", false).segments.map(s => s.text)).toEqual(["😀\r\n", "🙂\n"]);
  expect(second.update({ ...key, sessionId: "other" }, "other\n", true).segments.map(s => s.text)).toEqual(["other\n"]);
});

test("completion flushes an unfinished block and trailing source once", () => {
  const segmenter = createReplySegmenter();
  const source = "intro\r\n```js\r\nvalue🙂";
  expect(segmenter.update(key, source, false).segments.map(s => s.text)).toEqual(["intro\r\n"]);
  const final = segmenter.update(key, source, true);
  expect(final.segments.map(s => s.text)).toEqual(["intro\r\n", "```js\r\nvalue🙂"]);
  expect(segmenter.update(key, source, true)).toEqual(final);
});

test("a caller cannot mutate a previously published segment in the projection", () => {
  const segmenter = createReplySegmenter();
  const first = segmenter.update(key, "safe\n", false);
  Reflect.set(first.segments[0]!, "text", "changed");
  first.segments.length = 0;
  expect(segmenter.update(key, "safe\nnext\n", false).segments.map(s => s.text)).toEqual(["safe\n", "next\n"]);
});

test("100 growing snapshots covering 2000 lines lex each line only once", () => {
  const original = marked.Lexer.lex;
  let calls = 0;
  marked.Lexer.lex = function (...args) { calls++; return original(...args); };
  try {
    const segmenter = createReplySegmenter();
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ordinary 🙂 text\n`);
    for (let i = 20; i <= 2000; i += 20)
      expect(segmenter.update(key, lines.slice(0, i).join(""), false).status).toBe("ok");
    expect(calls).toBe(2000);
  } finally { marked.Lexer.lex = original; }
});
