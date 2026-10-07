import { expect, test } from "bun:test";
import {
  KeetSourceSchema,
  MessageSourceSchema,
  MessageSchema,
  validate,
  validateSubmission,
} from "../packages/contracts/src/index.ts";

const source = {
  kind: "keet",
  channel: "dm",
  senderLabel: "Alice",
  destination: "Peer",
} as const;
test("minimal bounded Keet source union retains reminders and ordinary messages", () => {
  for (const channel of ["dm", "group"] as const)
    expect(validate(MessageSourceSchema, { ...source, channel })).toEqual({
      ...source,
      channel,
    });
  expect(
    validate(MessageSourceSchema, { kind: "reminder", reminderId: "r" }),
  ).toEqual({ kind: "reminder", reminderId: "r" });
  for (const name of [
    "灯".repeat(512),
    "😀".repeat(512),
    '<img src=x onerror="alert(1)">',
  ])
    expect(
      validate(KeetSourceSchema, {
        ...source,
        senderLabel: name,
        destination: name,
      }).senderLabel,
    ).toBe(name);
  const message = {
    id: "m",
    role: "user",
    text: "Original visible body",
    createdAt: 1,
    operationId: null,
    turnId: null,
  } as const;
  expect(validate(MessageSchema, message)).toEqual(message);
  expect(validate(MessageSchema, { ...message, source }).source).toEqual(
    source,
  );
});
test("rejects malformed source, hidden context duplication and client-supplied provenance", () => {
  for (const invalid of [
    { ...source, channel: "broadcast" },
    { ...source, kind: "unknown" },
    { ...source, senderLabel: undefined },
    { ...source, destination: 3 },
    ...[
      "",
      " \t",
      "x\ny",
      "x\ry",
      "x\u2028y",
      "x\u2029y",
      "灯".repeat(513),
      "😀".repeat(513),
    ].flatMap((name) => [
      { ...source, senderLabel: name },
      { ...source, destination: name },
    ]),
    ...["context", "text", "messageId", "localTime", "timestamp"].map(
      (key) => ({ ...source, [key]: "private" }),
    ),
  ])
    expect(() => validate(MessageSourceSchema, invalid)).toThrow();
  const input = { operationId: crypto.randomUUID(), text: "Web input" };
  expect(validateSubmission(input)).toEqual(input);
  for (const provenance of [source, { kind: "reminder", reminderId: "r" }])
    expect(() =>
      validateSubmission({ ...input, source: provenance }),
    ).toThrow();
});
