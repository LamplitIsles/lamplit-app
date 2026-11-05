import { expect, test } from "bun:test";
const { validateReplyEnds } = await import("../packages/contracts/src/reply-ranges.ts");

test("source ends are increasing valid UTF-16 boundaries", () => {
  const source = "😀 a\r\nlast\n\n";
  expect(validateReplyEnds(source, [6, 11])).toEqual([6, 11]);
  expect(validateReplyEnds(source, [])).toEqual([]);
  for (const invalid of [[1], [0], [6, 6], [6, 5], [source.length + 1], [1.5], [NaN]])
    expect(() => validateReplyEnds(source, invalid)).toThrow();
});
