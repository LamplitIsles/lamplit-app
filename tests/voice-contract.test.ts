import { expect, test } from "bun:test";
// Exercise the public compiled export consumed by both backend repositories.
import {
  validateVoiceCapability,
  parseVoiceControl,
  parseVoiceServerEvent,
  validateVoiceServerEvent,
  validateVoiceFrameBytes,
  VOICE_ERROR_CODES,
  MAX_VOICE_PCM_BYTES,
  MAX_VOICE_FRAME_BYTES,
} from "../packages/contracts/dist/voice.js";
import { ViewSchema, validate } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

test("strict portable voice capability, controls, events and code-point bounds", () => {
  expect(validateVoiceCapability({ available: false })).toEqual({
    available: false,
  });
  for (const value of [
    { available: 1 },
    { available: true, key: "secret" },
    {},
  ])
    expect(() => validateVoiceCapability(value)).toThrow();
  for (const type of ["finish", "cancel"] as const)
    expect(parseVoiceControl(JSON.stringify({ type }))).toEqual({ type });
  for (const raw of [
    '{"type":"finish","extra":true}',
    '{"type":"start"}',
    "null",
    "{",
    " ".repeat(129),
  ])
    expect(() => parseVoiceControl(raw)).toThrow();
  expect(parseVoiceServerEvent('{"type":"ready"}')).toEqual({ type: "ready" });
  for (const code of VOICE_ERROR_CODES)
    expect(validateVoiceServerEvent({ type: "error", code })).toEqual({
      type: "error",
      code,
    });
  const text = "😀".repeat(20_000);
  expect(
    parseVoiceServerEvent(JSON.stringify({ type: "result", text })),
  ).toEqual({ type: "result", text });
  for (const value of [
    { type: "ready", extra: true },
    { type: "interim", text: "hello" },
    { type: "error", code: "unknown" },
    { type: "result", text: " " },
    { type: "result", text: text + "a" },
  ])
    expect(() => validateVoiceServerEvent(value)).toThrow();
  expect(() => parseVoiceServerEvent(" ".repeat(128 * 1024 + 1))).toThrow();
});
test("PCM frame limits admit even bounded frames and cap total raw bytes", () => {
  expect(validateVoiceFrameBytes(3200, 0)).toBe(3200);
  expect(
    validateVoiceFrameBytes(
      MAX_VOICE_FRAME_BYTES,
      MAX_VOICE_PCM_BYTES - MAX_VOICE_FRAME_BYTES,
    ),
  ).toBe(MAX_VOICE_PCM_BYTES);
  for (const [bytes, total] of [
    [0, 0],
    [3, 0],
    [2, 1],
    [2, -2],
    [2, NaN],
    [Infinity, 0],
    [MAX_VOICE_FRAME_BYTES + 2, 0],
    [2, MAX_VOICE_PCM_BYTES],
  ])
    expect(() => validateVoiceFrameBytes(bytes!, total!)).toThrow();
});
test("chat snapshot has no competing voice availability", async () => {
  const view = await fixtureBackend().backend.read();
  expect(validate(ViewSchema, view)).toEqual(view);
  expect(() =>
    validate(ViewSchema, {
      ...view,
      capabilities: { ...view.capabilities, voice: false },
    }),
  ).toThrow();
});
