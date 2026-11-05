import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
const { stableReplySegments } = await import("../packages/contracts/src/reply-chunks.ts");

const streaming = (source: string) =>
  stableReplySegments(source, false).map(({ text }) => text);

test("ordinary completed lines stay unchanged when blank lines and later lines arrive", () => {
  expect(streaming("第一🙂\r\n")).toEqual(["第一🙂\r\n"]);
  expect(streaming("第一🙂\r\n\r\n")).toEqual(["第一🙂\r\n"]);
  expect(streaming("第一🙂\r\n\r\nsecond\n")).toEqual([
    "第一🙂\r\n",
    "\r\nsecond\n",
  ]);
});

test("an open fenced block remains hidden until closed", () => {
  expect(streaming("before\n```ts\n")).toEqual(["before\n"]);
  expect(streaming("before\n```ts\nconst x = 1;\n")).toEqual(["before\n"]);
  expect(streaming("before\n```ts\nconst x = 1;\n```\n")).toEqual([
    "before\n",
    "```ts\nconst x = 1;\n```\n",
  ]);
});

test("a possible table remains unpublished until its boundary is known", () => {
  expect(streaming("before\n| A | B |\n")).toEqual(["before\n"]);
  expect(streaming("before\n| A | B |\n|---|---|\n| x | y |\n")).toEqual([
    "before\n",
  ]);
  expect(
    streaming("before\n| A | B |\n|---|---|\n| x | y |\n\nafter\n"),
  ).toEqual(["before\n", "| A | B |\n|---|---|\n| x | y |\n", "\nafter\n"]);
});

test("a normal line containing a pipe is immediate and not reinterpreted as a table", () => {
  expect(streaming("A | B\n")).toEqual(["A | B\n"]);
  expect(streaming("A | B\n--- | ---\n")).toEqual(["A | B\n", "--- | ---\n"]);
});

test("a block-math fence is held as one complete source unit", () => {
  expect(streaming("before\n$$\n")).toEqual(["before\n"]);
  expect(streaming("before\n$$\nx+y\n")).toEqual(["before\n"]);
  expect(streaming("before\n$$\nx+y\n$$\n")).toEqual([
    "before\n", "$$\nx+y\n$$\n",
  ]);
});

test("each published source unit stays identical across later complete lines", () => {
  const source = "起🙂\r\n\r\n```js\r\nx();\r\n```\r\n| A |\r\n|---|\r\n| B |\r\n\r\nend\n";
  let previous: ReturnType<typeof stableReplySegments> = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\n") continue;
    const segments = stableReplySegments(source.slice(0, i + 1), false);
    expect(segments.slice(0, previous.length)).toEqual(previous);
    for (const segment of segments)
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
    previous = segments;
  }
  const final = stableReplySegments(source, true);
  expect(final.slice(0, previous.length)).toEqual(previous);
});

test("later Setext syntax and reference definitions never reinterpret a published line", () => {
  const setext = streaming("hello\n");
  expect(streaming("hello\n---\n").slice(0, 1)).toEqual(setext);
  const reference = streaming("[label][id]\n");
  expect(
    streaming("[label][id]\n\n[id]: https://example.test\n").slice(0, 1),
  ).toEqual(reference);
});

test("final projection preserves every previously visible segment and flushes the exact last line once", () => {
  const source = "你好🙂\r\n\r\nsecond\nlast";
  const observed = streaming(source);
  const finished = stableReplySegments(source, true).map(({ text }) => text);
  expect(observed).toEqual(["你好🙂\r\n", "\r\nsecond\n"]);
  expect(finished).toEqual([...observed, "last"]);
  expect(finished.join("")).toBe(source);
});

test("trailing blank lines do not mutate earlier slices or create empty messages", () => {
  const source = "a\r\n\r\n\r\n";
  const visible = stableReplySegments(source, false);
  const complete = stableReplySegments(source, true);
  expect(complete).toEqual(visible);
  expect(complete.map(({ text }) => text)).toEqual(["a\r\n"]);
  expect(source.slice(complete.at(-1)!.end)).toBe("\r\n\r\n");
});

test("quoted fenced blocks and lists publish only after their boundaries", () => {
  expect(streaming("> ```js\n> x()\n")).toEqual([]);
  expect(streaming("> ```js\n> x()\n> ```\n")).toEqual([
    "> ```js\n> x()\n> ```\n",
  ]);
  expect(streaming("- one\n- two\n")).toEqual([]);
  expect(streaming("- one\n- two\n\nafter\n")).toEqual([
    "- one\n- two\n", "\nafter\n",
  ]);
});

test("complete-line prefixes preserve published segments across block and ordinary boundaries", () => {
  const sources = [
    "> ```js\n> x()\n> ```\nplain\n",
    "- one\n- two\n\nplain\n",
    "A | B\n--- | ---\n| explicit |\n|---|\n| row |\n\nafter\n",
    "😀\r\n$$\r\nx+y\r\n$$\r\n\r\nlast",
  ];
  for (const source of sources) {
    let previous: ReturnType<typeof stableReplySegments> = [];
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "\n") continue;
      const segments = stableReplySegments(source.slice(0, i + 1), false);
      expect(segments.slice(0, previous.length)).toEqual(previous);
      previous = segments;
    }
    expect(stableReplySegments(source, true).slice(0, previous.length)).toEqual(previous);
  }
});

test("ordered end offsets reconstruct published slices without copying or empty rows", () => {
  const source = "\r\n😀 first\r\n\r\n```js\nvalue()\n```\n\nlast\n\n";
  const segments = stableReplySegments(source, true);
  const ends = segments.map(segment => segment.end);
  let start = 0;
  const slices = ends.map(end => {
    const slice = source.slice(start, end);
    start = end;
    return slice;
  });
  expect(slices).toEqual(segments.map(segment => segment.text));
  expect(slices).toEqual(["\r\n😀 first\r\n", "\r\n```js\nvalue()\n```\n", "\nlast\n"]);
  expect(source.slice(start)).toBe("\n");
});
