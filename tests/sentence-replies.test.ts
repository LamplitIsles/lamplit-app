import { expect, test } from "bun:test";
import {
  StreamingReplySchema,
  ViewSchema,
  validate,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

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
