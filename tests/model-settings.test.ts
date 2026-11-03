import { describe, expect, test } from "bun:test";
import { validateModelSettings } from "../apps/web/src/lib/model-settings.ts";
const snapshot = {
  sessionId: "thread-a",
  currentModel: "gpt-6.1-sol",
  fast: true,
  busy: false,
};
describe("optional model settings response", () => {
  test("accepts selected and legacy model preferences", () => {
    expect(validateModelSettings(snapshot)).toEqual(snapshot);
    expect(
      validateModelSettings({ ...snapshot, currentModel: "legacy-model" })
        .currentModel,
    ).toBe("legacy-model");
  });
  test("rejects malformed identities and host responses", () => {
    for (const value of [
      null,
      {},
      { ...snapshot, busy: "false" },
      { ...snapshot, fast: undefined },
      { ...snapshot, fast: "true" },
      { ...snapshot, sessionId: "" },
      { ...snapshot, currentModel: "" },
      { ...snapshot, currentModel: "bad\nmodel" },
      { ...snapshot, currentModel: " model " },
      { ...snapshot, currentModel: "x".repeat(201) },
    ])
      expect(() => validateModelSettings(value)).toThrow();
  });
});
