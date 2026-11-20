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
  test("accepts the paired host extension and rejects incomplete or malformed extensions", () => {
    const extended = {
      ...snapshot,
      reasoningEffort: null,
      availableModels: [
        {
          id: "gpt-6.2-sol",
          name: "6.2 sol",
          reasoningEfforts: ["high", "max"],
        },
      ],
    };
    expect(validateModelSettings(extended)).toEqual(extended);
    for (const value of [
      { ...snapshot, reasoningEffort: null },
      { ...snapshot, availableModels: [] },
      { ...extended, reasoningEffort: "ultra" },
      {
        ...extended,
        availableModels: [
          { id: "gpt-6.2-sol", name: "6.2 sol", reasoningEfforts: [42] },
        ],
      },
    ])
      expect(() => validateModelSettings(value)).toThrow();
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
