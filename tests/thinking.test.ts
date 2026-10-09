import { expect, test } from "bun:test";
import {
  MessageSchema,
  PageSchema,
  ViewSchema,
  validate,
} from "../packages/contracts/src/index.ts";
import { thinkingFixture } from "./thinking-fixture.ts";

test("optional thinking survives completed view/history without changing answer", async () => {
  const fixture = thinkingFixture();
  const message = {
    id: "answer",
    role: "agent" as const,
    text: "answer",
    thinking: "first\nsecond",
    createdAt: 1,
    operationId: null,
    turnId: null,
  };
  fixture.control({
    action: "message",
    message: validate(MessageSchema, message),
  });
  const view = validate(ViewSchema, await fixture.backend.read());
  expect(view.messages[0]).toEqual(message);
  fixture.control({
    action: "message",
    message: { ...view.messages[0]!, id: "old" },
    history: true,
  });
  expect(
    validate(PageSchema, await fixture.backend.history("older")).messages[0]
      ?.thinking,
  ).toBe("first\nsecond");
  const { thinking: _, ...without } = message;
  expect(validate(MessageSchema, without)).toEqual(without);
  expect(() => validate(MessageSchema, { ...message, thinking: 12 })).toThrow();
  expect(() =>
    validate(MessageSchema, { ...message, thinkingSignature: "private" }),
  ).toThrow();
});
