import { boundA2UIPayload } from "./a2ui.ts";
import {
  HistorySyncResultSchema,
  validate,
  type HistorySyncInput,
  type HistorySyncResult,
} from "./index.ts";
import { isReplySource, validateReplySource } from "./reply-ranges.ts";

/** Validate the response against the request before a consumer commits its cursor. */
export function validateHistorySyncResult(
  input: HistorySyncInput,
  value: unknown,
  projected = true,
): HistorySyncResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (Array.isArray(result.records))
      value = {
        ...result,
        records: result.records.map((record: unknown) => {
          if (!record || typeof record !== "object" || Array.isArray(record))
            return record;
          const item = record as Record<string, unknown>;
          if (
            !item.message ||
            typeof item.message !== "object" ||
            Array.isArray(item.message) ||
            !Object.hasOwn(item.message, "ui")
          )
            return item;
          const message = item.message as Record<string, unknown>;
          return {
            ...item,
            message: { ...message, ui: boundA2UIPayload(message.ui) },
          };
        }),
      };
  }
  const result = validate(HistorySyncResultSchema, value);
  if (
    result.sessionId !== input.sessionId ||
    (result.kind !== input.kind &&
      !(result.kind === "resyncRequired" && input.kind !== "start"))
  )
    throw new Error("Wrong history sync response");
  if (
    (input.kind === "older" &&
      result.kind === "older" &&
      result.before !== null &&
      result.before === input.before) ||
    (input.kind === "newer" &&
      result.kind === "newer" &&
      (result.records.length > 0 || result.hasMore) &&
      result.nextAfter === input.after)
  )
    throw new Error("History sync cursor did not advance");
  const records = result.kind === "resyncRequired" ? [] : result.records;
  const ids = new Set<string>();
  let previous: string | undefined;
  for (const { message, orderKey, wake } of records) {
    if (message.textState === "streaming" || (wake && message.role !== "agent"))
      throw new Error("Invalid history sync message");
    if ((previous !== undefined && orderKey <= previous) || ids.has(message.id))
      throw new Error("Invalid history sync order or duplicate record");
    previous = orderKey;
    ids.add(message.id);
    validateReplySource(message, projected && isReplySource(message));
  }
  return result;
}
