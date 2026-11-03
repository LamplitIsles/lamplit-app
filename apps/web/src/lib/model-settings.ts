/** Optional host API; independent of the chat socket protocol. */
export const MODELS_PATH = "/api/chat/models";
export const MODEL_CHOICES = [
  { id: "gpt-6.1-sol", name: "6.1 sol", version: "6.1" },
  { id: "gpt-5.6-sol", name: "5.6 sol", version: "5.6" },
  { id: "gpt-6.1-terra", name: "6.1 terra", version: "6.1" },
] as const;
export interface ModelSettings {
  sessionId: string;
  currentModel: string;
  fast: boolean;
  busy: boolean;
}

function isValidIdentifier(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\r\n\u2028\u2029]/u.test(value)
  );
}

export function validateModelSettings(value: unknown): ModelSettings {
  if (!value || typeof value !== "object")
    throw new Error("Invalid model settings");
  const v = value as ModelSettings;
  if (
    !isValidIdentifier(v.sessionId, 300) ||
    !isValidIdentifier(v.currentModel) ||
    typeof v.fast !== "boolean" ||
    typeof v.busy !== "boolean"
  ) {
    throw new Error("Invalid model settings");
  }
  return v;
}
