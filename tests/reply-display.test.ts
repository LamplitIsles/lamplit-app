import { expect, test } from "bun:test";
import { replySegments, type TimelineText } from "../apps/web/src/lib/companion/projection.ts";

test("renders only host-published reply ranges with stable per-session identities", () => {
  const source: TimelineText = {
    id: "reply-1",
    messageKey: "reply-1",
    kind: "text",
    side: "incoming",
    text: "你好😀\r\nsecond\nunfinished",
    ends: [6, 13],
  };
  const partial = replySegments(source, "session-a");
  expect(partial.map((item) => item.text)).toEqual(["你好😀\r\n", "second\n"]);
  const completed = replySegments({ ...source, ends: [6, 13, source.text.length] }, "session-a");
  expect(completed.map((item) => item.text)).toEqual(["你好😀\r\n", "second\n", "unfinished"]);
  expect(completed.slice(0, 2).map((item) => item.id)).toEqual(partial.map((item) => item.id));
  expect(replySegments(source, "session-b")[0]!.id).not.toBe(partial[0]!.id);
  expect(replySegments({ ...source, ends: [] }, "session-a")).toEqual([]);
});
