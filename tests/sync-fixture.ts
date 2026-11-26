import type { ChatMessage } from "../packages/contracts/src/index.ts";

/** Construct a deterministic older page for test-owned backends. */
export function olderResult(
  sessionId: string,
  messages: ChatMessage[],
  before: string | null,
  first = 0,
) {
  return {
    kind: "older" as const,
    sessionId,
    historyId: "fixture-history",
    records: messages.map((message, index) => ({
      message,
      orderKey: String(first + index).padStart(12, "0"),
    })),
    before,
  };
}

/** Read an older page, failing the test on cursor expiration. */
export async function readOlder(
  client: Awaited<
    ReturnType<typeof import("../packages/contracts/src/client.ts").openChat>
  >,
  sessionId: string,
  before: string,
) {
  const result = await client.historySync({ kind: "older", sessionId, before });
  if (result.kind !== "older") throw new Error("Expected an older page");
  return result;
}
