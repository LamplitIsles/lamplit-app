import { expect, test } from "bun:test";
import {
  MatrixSourceSchema,
  MessageSourceSchema,
  ViewSchema,
  PageSchema,
  validate,
  validateSubmission,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
const source = {
  kind: "matrix" as const,
  senderId: "@alice:example.test",
  senderDisplayName: "Alice",
  roomId: "!room:example.test",
};
test("Matrix preserves exact labels and enforces gateway UTF-16 capacity in source/view/history", async () => {
  const view = await fixtureBackend().backend.read();
  for (const label of [
    "",
    " \n\t",
    "😀".repeat(127) + "灯",
    '<img src=x onerror="alert(1)">',
  ]) {
    const valid = { ...source, senderDisplayName: label };
    expect(validate(MatrixSourceSchema, valid)).toEqual(valid);
    const message = {
      id: "matrix",
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
  for (const key of ["senderId", "senderDisplayName", "roomId"]) {
    for (const label of ["灯".repeat(256), "😀".repeat(128)])
      expect(() =>
        validate(MessageSourceSchema, { ...source, [key]: label }),
      ).toThrow();
    for (const label of ["😀".repeat(127) + "灯", "x\ny"])
      expect(
        validate(MatrixSourceSchema, { ...source, [key]: label })[
          key as keyof typeof source
        ],
      ).toBe(label);
  }
  for (const invalid of [
    { ...source, senderId: "" },
    { ...source, roomId: "" },
    { ...source, senderDisplayName: undefined },
    ...["context", "credentials", "rawPayload", "eventId", "text"].map(
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
