import { expect, test } from "bun:test";
import { sentenceChunks } from "../apps/web/src/lib/companion/sentence-replies.ts";
import {
  StreamingReplySchema,
  ViewSchema,
  validate,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

const cases: [string, string[]][] = [
  ["\n\nFirst. Next.", ["\n\nFirst. ", "Next."]],
  ["你好。下一句！尾巴", ["你好。", "下一句！", "尾巴"]],
  ["她说：“你好。”下一句。", ["她说：“你好。”", "下一句。"]],
  [
    "Dr. Smith paid 3.14 dollars. Next sentence.",
    ["Dr. Smith paid 3.14 dollars. ", "Next sentence."],
  ],
  ["你好🙂。Hello! Tail", ["你好🙂。", "Hello! ", "Tail"]],
  ["没有标点的尾巴", ["没有标点的尾巴"]],
  ["第一段。\n\n第二段。还有。", ["第一段。\n\n", "第二段。", "还有。"]],
];
for (const [source, expected] of cases)
  test(`lossless prose: ${source}`, () => {
    const chunks = sentenceChunks(source);
    expect(chunks.map((c) => c.text)).toEqual(expected);
    expect(chunks.map((c) => c.text).join("")).toBe(source);
    for (const chunk of chunks)
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });
for (const source of [
  "Visit https://example.com/a.b. Then continue.",
  "**Bold. Still bold.** Tail.",
  "[Link. Text.](https://example.com) Tail.",
  "`code. code.` Tail.",
  "```js\na.b();\nc.d();\n```",
  "```js\na.b();\n```\n\n| A | B |\n|---|---|\n| x | y |",
  "- One. Two.\n- Three.",
  "> One. Two.",
  "| A | B |\n|---|---|\n| x.y | z |",
  "Math $x.y + z$ here. Next.",
  "$$\nx.y\n$$",
  "Incomplete **bold. Next.",
  "[Reference][r]. Next.\n\n[r]: https://example.com",
  "One.\r\n\r\nTwo.",
])
  test(`protected Markdown: ${source}`, () => {
    expect(sentenceChunks(source).map((c) => c.text)).toEqual([source]);
  });
test("growing tail is visible and closing punctuation never gets its own bubble", () => {
  for (const text of [
    "你好",
    "你好。",
    "你好。”",
    "你好。”下",
    "你好。”下一句。",
  ]) {
    const chunks = sentenceChunks(text);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.every((c) => /[\p{L}\p{N}\p{S}]/u.test(c.text))).toBe(true);
  }
  expect(sentenceChunks("你好。”下一句。")).toHaveLength(2);
});
test("preview uses existing scalar conventions and rejects private or malformed fields", async () => {
  const preview = {
    id: "attempt",
    turnId: null,
    createdAt: 123,
    text: "partial",
  };
  const view = await fixtureBackend().backend.read();
  expect(
    validate(ViewSchema, { ...view, streamingReply: preview }).streamingReply,
  ).toEqual(preview);
  expect(validate(ViewSchema, view).streamingReply).toBeUndefined();
  for (const invalid of [
    { ...preview, id: "" },
    { ...preview, id: "x".repeat(1000) },
    { ...preview, createdAt: "123" },
    { ...preview, text: null },
    { ...preview, thinking: "secret" },
    { ...preview, tool: {} },
  ])
    expect(() => validate(StreamingReplySchema, invalid)).toThrow();
});

test("later rich inline syntax preserves completed safe sentences and the lossless tail", () => {
  expect(
    sentenceChunks("First. Dr. Smith **bold**").map((chunk) => chunk.text),
  ).toEqual(["First. ", "Dr. Smith **bold**"]);
  const prefix = "第一句。第二句";
  const first = sentenceChunks(prefix)[0];
  for (const suffix of [
    "**粗体**",
    "[链接](https://exam",
    "[链接](https://example.test)",
    "`a.b",
    "`a.b`",
    "$x.",
    "$x.y$",
    "**粗体。仍是粗体**。后续句子。",
  ]) {
    const source = prefix + suffix;
    const chunks = sentenceChunks(source);
    expect(chunks[0]).toEqual(first);
    expect(chunks[1]).toEqual({
      start: 4,
      end: source.length,
      text: "第二句" + suffix,
    });
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(source);
  }
});
