import { expect, test } from "bun:test";
import {
  MessageSourceSchema,
  ViewSchema,
  PageSchema,
  validate,
  validateSubmission,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
const source = {
  kind: "post",
  platform: "qq",
  conversationType: "group",
  conversationId: "12345",
  conversationName: "灯火群",
  senderId: "67890",
  senderDisplayName: "Alice",
} as const;
test("Post display source preserves bounded names and exact IDs through public view/history", async () => {
  const view = await fixtureBackend().backend.read();
  for (const platform of ["qq", "matrix"] as const)
    for (const conversationType of ["direct", "group"] as const) {
      const valid = {
        ...source,
        platform,
        conversationType,
        senderDisplayName: "😀".repeat(256),
        conversationName: '<img src=x onerror="alert(1)">\n灯火',
      };
      expect(validate(MessageSourceSchema, valid)).toEqual(valid);
      const message = {
        id: "post",
        role: "user" as const,
        text: "Original\n\nbody",
        createdAt: 123,
        operationId: null,
        turnId: null,
        source: valid,
      };
      expect(
        validate(ViewSchema, { ...view, messages: [message] }).messages,
      ).toEqual([message]);
      expect(
        validate(PageSchema, { messages: [message], before: null }).messages,
      ).toEqual([message]);
    }
  const {
    senderDisplayName: _senderDisplayName,
    conversationName: _conversationName,
    ...unnamed
  } = source;
  expect(validate(MessageSourceSchema, unnamed)).toEqual(unnamed);
  for (const key of ["senderId", "conversationId"]) {
    for (const id of ["x".repeat(256), "😀".repeat(128), " ID\nexact "])
      expect(
        (
          validate(MessageSourceSchema, { ...source, [key]: id }) as Record<
            string,
            unknown
          >
        )[key],
      ).toBe(id);
    for (const id of ["", "x".repeat(257), "😀".repeat(129)])
      expect(() =>
        validate(MessageSourceSchema, { ...source, [key]: id }),
      ).toThrow();
  }
  for (const key of ["senderDisplayName", "conversationName"])
    for (const name of ["", " \n\t", "😀".repeat(257)])
      expect(() =>
        validate(MessageSourceSchema, { ...source, [key]: name }),
      ).toThrow();
  for (const invalid of [
    { ...source, platform: "keet" },
    { ...source, conversationType: "dm" },
    ...["accountId", "deliveryId", "credentials", "context", "rawEvent"].map(
      (key) => ({ ...source, [key]: "private" }),
    ),
  ])
    expect(() => validate(MessageSourceSchema, invalid)).toThrow();
  expect(() =>
    validateSubmission({
      operationId: crypto.randomUUID(),
      text: "web",
      source,
    }),
  ).toThrow();
});
