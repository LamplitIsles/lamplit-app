import { expect, test } from "bun:test";
import { replyChunks } from "../apps/web/src/lib/companion/reply-chunks.ts";

for (const [source, expected] of [
  ["第一句。第二句。", ["第一句。第二句。"]],
  ["first line\nsecond line", ["first line\n", "second line"]],
  ["first line\r\nsecond line", ["first line\r\n", "second line"]],
  ["引导：\n\n- 项目", ["引导：\n\n", "- 项目"]],
] as const)
  test(`source newline policy: ${JSON.stringify(source)}`, () => {
    expect(replyChunks(source).map((c) => c.text)).toEqual([...expected]);
  });

const matrix: [string, string[], string?][] = [
  ["\n\nfirst\n\n\nlast", ["\n\nfirst\n\n\n", "last"]],
  [
    "你好🙂。Hello! Dr. Smith paid 3.14.\r\n下一行",
    ["你好🙂。Hello! Dr. Smith paid 3.14.\r\n", "下一行"],
  ],
  [
    "**bold. same line.**\nafter\nlast",
    ["**bold. same line.**\n", "after\n", "last"],
    "strong",
  ],
  [
    "**across\nlines**\nafter\nlast",
    ["**across\nlines**\n", "after\n", "last"],
    "strong",
  ],
  [
    "[across\nlines](https://example.test)\nafter",
    ["[across\nlines](https://example.test)\n", "after"],
    "link",
  ],
  ["`across\nlines`\nafter", ["`across\nlines`\n", "after"], "codespan"],
  [
    "> first. Same line.\n> second\n>\n> last",
    ["> first. Same line.\n", "> second\n>\n", "> last"],
    "blockquote",
  ],
  ["> > first\n> > second", ["> > first\n", "> > second"], "blockquote"],
  [
    "- One\n  - Nested\n- Two\n\nafter\nlast",
    ["- One\n  - Nested\n- Two\n\n", "after\n", "last"],
    "list",
  ],
  [
    "1. One\n2. Two\n\nafter\nlast",
    ["1. One\n2. Two\n\n", "after\n", "last"],
    "list",
  ],
  [
    "```js\na.b();\nc.d();\n```\n\nafter\nlast",
    ["```js\na.b();\nc.d();\n```\n\n", "after\n", "last"],
    "code",
  ],
  [
    "| A | B |\n|---|---|\n| x.y | z |\n\nafter\nlast",
    ["| A | B |\n|---|---|\n| x.y | z |\n\n", "after\n", "last"],
    "table",
  ],
  ["escaped \\*star\\*\\\nnext", ["escaped \\*star\\*\\\n", "next"]],
  [
    "[link][r]\nnext\n\n[r]: https://example.test",
    ["[link][r]\n", "next\n\n[r]: https://example.test"],
    "link",
  ],
  [
    "[r]: https://example.test\n\n[link][r]\nnext",
    ["[r]: https://example.test\n\n[link][r]\n", "next"],
    "link",
  ],
];
type Token = ReturnType<typeof replyChunks>[number]["tokens"][number];
function types(tokens: Token[]): string[] {
  return tokens.flatMap((t) => [
    t.type,
    ...types("tokens" in t ? (t.tokens ?? []) : []),
    ...types(t.type === "list" ? t.items : []),
  ]);
}
for (const [source, expected, semantic] of matrix)
  test(`lossless newline structure: ${JSON.stringify(source)}`, () => {
    const chunks = replyChunks(source);
    expect(chunks.map((c) => c.text)).toEqual(expected);
    expect(chunks.map((c) => c.text).join("")).toBe(source);
    for (const chunk of chunks)
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
    if (semantic) expect(types(chunks[0].tokens)).toContain(semantic);
    if (semantic === "blockquote")
      for (const chunk of chunks)
        expect(chunk.tokens[0].type).toBe("blockquote");
  });

test("CR and LF arriving separately preserve complete prefixes and exact offsets", () => {
  const stable = replyChunks("stable\r\ncurrent")[0];
  for (const tail of ["current\r", "current\r\n", "current\r\n🙂next"]) {
    const source = "stable\r\n" + tail;
    const chunks = replyChunks(source);
    expect(chunks[0]).toEqual(stable);
    expect(chunks.map((c) => c.text).join("")).toBe(source);
    expect(chunks.at(-1)?.end).toBe(source.length);
  }
});

test("unfinished inline protects its necessary tail, closure resumes subsequent source lines", () => {
  for (const [open, closed] of [
    ["**across\nlines", "**across\nlines**"],
    ["[across\nlines](https://exam", "[across\nlines](https://example.test)"],
    ["`across\nlines", "`across\nlines`"],
  ]) {
    const prefix = "stable\n";
    const stable = replyChunks(prefix)[0];
    for (const tail of [open, closed + "\nafter\nlast"]) {
      const source = prefix + tail;
      const chunks = replyChunks(source);
      expect(chunks[0]).toEqual(stable);
      expect(chunks.map((c) => c.text).join("")).toBe(source);
    }
    expect(
      replyChunks(prefix + closed + "\nafter\nlast").map((c) => c.text),
    ).toEqual([prefix, closed + "\n", "after\n", "last"]);
  }
});

test("literal closed brackets/markers do not protect later unrelated source lines", () => {
  for (const source of [
    "[literal]\nafter",
    "word_with_underscore\nafter",
    "**invalid.**word\nafter",
  ]) {
    expect(replyChunks(source).map((c) => c.text)).toEqual([
      source.split("\n")[0] + "\n",
      "after",
    ]);
  }
});

test("blank-only sources produce no empty rows; unrelated structures stay separate", () => {
  for (const source of ["", "\n\n", "\r\n\r\n", ">\n>"])
    expect(replyChunks(source)).toEqual([]);
  const source = "```js\na();\n```\n\n| A |\n|---|\n| B |\n\nafter";
  const chunks = replyChunks(source);
  expect(chunks).toHaveLength(3);
  expect(chunks.map((c) => c.text).join("")).toBe(source);
  expect(chunks[0].tokens[0].type).toBe("code");
  expect(chunks[1].tokens[0].type).toBe("table");
});

test("source paragraph continuation lines retain their original paragraph semantics", () => {
  for (const source of [
    "before\n    indented continuation\nafter",
    "before\n2. continuation\nafter",
  ]) {
    const chunks = replyChunks(source);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text).join("")).toBe(source);
    for (const chunk of chunks) expect(chunk.tokens[0].type).toBe("paragraph");
    expect(chunks[1].tokens[0]).toMatchObject({ type: "paragraph" });
  }
});

test("single-dollar amounts cannot protect subsequent source lines", () => {
  expect(replyChunks("price $5\nafter\nlast").map((c) => c.text)).toEqual([
    "price $5\n",
    "after\n",
    "last",
  ]);
});

test("paired inline HTML protects only through its closing source tag", () => {
  const prefix = replyChunks("stable\n<span>one\ntwo");
  const closed = replyChunks("stable\n<span>one\ntwo</span>\nafter");
  expect(prefix).toHaveLength(2);
  expect(closed[0]).toEqual(prefix[0]);
  expect(closed).toHaveLength(3);
  for (const body of [
    "<span>one\ntwo</span>",
    "<span class=x>one\r\ntwo</span>",
    "<span>one\n<span>two</span>\nthree</span>",
    "<span>one<br>\n<em>two</em></span>",
  ]) {
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    const source = body + newline + "after";
    expect(replyChunks(source).map((c) => c.text)).toEqual([
      body + newline,
      "after",
    ]);
  }
  const source = "<span>one\ntwo</span>\n<span>three\nfour</span>\nafter";
  expect(replyChunks(source).map((c) => c.text)).toEqual([
    "<span>one\ntwo</span>\n",
    "<span>three\nfour</span>\n",
    "after",
  ]);
});
