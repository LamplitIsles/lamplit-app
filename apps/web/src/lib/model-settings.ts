/** Optional host API; independent of the chat socket protocol. */
export const MODELS_PATH = "/api/chat/models";
export const MODEL_CHOICES = [
  { id: "gpt-6.1-sol", name: "6.1 sol", version: "6.1" },
  { id: "gpt-5.6-sol", name: "5.6 sol", version: "5.6" },
  { id: "gpt-6.1-terra", name: "6.1 terra", version: "6.1" },
] as const;
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export interface AvailableModel {
  id: string;
  name: string;
  reasoningEfforts: string[];
}
export interface ModelSettings {
  sessionId: string;
  currentModel: string;
  fast: boolean;
  busy: boolean;
  reasoningEffort?: ReasoningEffort | null;
  availableModels?: AvailableModel[];
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
  const extended = "reasoningEffort" in v || "availableModels" in v;
  if (
    extended &&
    (!(
      v.reasoningEffort === null ||
      REASONING_EFFORTS.some((effort) => effort === v.reasoningEffort)
    ) ||
      !Array.isArray(v.availableModels) ||
      !v.availableModels.every(
        (model) =>
          model &&
          isValidIdentifier(model.id) &&
          isValidIdentifier(model.name) &&
          Array.isArray(model.reasoningEfforts) &&
          model.reasoningEfforts.every((effort) => isValidIdentifier(effort)),
      ))
  )
    throw new Error("Invalid model settings");
  return v;
}
