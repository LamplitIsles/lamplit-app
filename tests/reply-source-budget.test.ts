import { expect, test } from "bun:test";
import { defineService, replicatedState, RemoteServiceProvider, createServiceStateEncoder } from "../packages/contracts/node_modules/@earendil-works/chord/dist/index.js";
import { BACKGROUND_CONTEXT } from "../packages/contracts/node_modules/@earendil-works/chord/dist/context/index.js";

// A test-only candidate shape: one source string and one ID/range per line.
// This is not a proposed or accepted protocol schema.
function encodedSnapshot(lines: number, mode: "raw" | "ranges" | "ends") {
  const text = "x\n".repeat(lines);
  const message = { id: "answer", text, ...(mode === "ranges" ? { segments: Array.from({ length: lines }, (_, i) => ({ id: `answer:${i * 2}`, start: i * 2, end: i * 2 + 2 })) } : mode === "ends" ? { ends: Array.from({ length: lines }, (_, i) => i * 2 + 2) } : {}) };
  const service = defineService("test.reply.budget");
  const provider = new RemoteServiceProvider([service]);
  provider.provide(service, { view: replicatedState({ messages: [message] }) });
  const subscription = provider.subscribe(service.id, "singleton", () => {});
  const snapshot = createServiceStateEncoder().encodeSnapshot(subscription.snapshot);
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "result", id: "1", result: snapshot })).byteLength;
  subscription.close(); provider.dispose();
  return { bytes, sourceBytes: new TextEncoder().encode(text).byteLength };
}

test("replacing a live source window sends that source and its segment metadata again", () => {
  const lines = 60_000;
  const text = "x\n".repeat(lines);
  const message = { id: "answer", text, segments: Array.from({ length: lines }, (_, i) => ({ id: `answer:${i * 2}`, start: i * 2, end: i * 2 + 2 })) };
  const service = defineService("test.reply.update.budget");
  const provider = new RemoteServiceProvider([service]);
  const view = replicatedState({ messages: [] as typeof message[] });
  provider.provide(service, { view });
  const encoder = createServiceStateEncoder();
  let updateBytes = 0;
  const sub = provider.subscribe(service.id, "singleton", (update) => {
    const frame = { type: "update", subscriptionId: "view-1", update: encoder.encodeUpdate(update) };
    updateBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  });
  encoder.encodeSnapshot(sub.snapshot);
  sub.activate();
  view.change(BACKGROUND_CONTEXT, (draft) => { draft.messages = [message]; });
  expect(updateBytes).toBeGreaterThan(2 * 1024 * 1024);
  console.log(`test-owned live replacement: ${updateBytes} encoded bytes`);
  sub.close(); provider.dispose();
});

test("a source-sized reply can fit while its line metadata exceeds the existing Chord frame budget", () => {
  const raw = encodedSnapshot(60_000, "raw");
  const projected = encodedSnapshot(60_000, "ranges");
  expect(raw.bytes).toBeLessThan(2 * 1024 * 1024);
  expect(projected.bytes).toBeGreaterThan(2 * 1024 * 1024);
  console.log(`test-owned snapshot: source ${raw.sourceBytes} bytes; raw frame ${raw.bytes}; source + 60000 ID/range entries ${projected.bytes}`);
});

test("ordered end offsets reduce the same candidate snapshot and replacement update", () => {
  const lines = 60_000;
  const text = "x\n".repeat(lines);
  const message = { id: "answer", text, ends: Array.from({ length: lines }, (_, i) => i * 2 + 2) };
  const service = defineService("test.reply.ends.budget");
  const provider = new RemoteServiceProvider([service]);
  const view = replicatedState({ messages: [] as typeof message[] });
  provider.provide(service, { view });
  const encoder = createServiceStateEncoder();
  let updateBytes = 0;
  const sub = provider.subscribe(service.id, "singleton", (update) => {
    updateBytes = new TextEncoder().encode(JSON.stringify({ type: "update", subscriptionId: "view-1", update: encoder.encodeUpdate(update) })).byteLength;
  });
  encoder.encodeSnapshot(sub.snapshot);
  sub.activate();
  view.change(BACKGROUND_CONTEXT, draft => { draft.messages = [message]; });
  const snapshot = encodedSnapshot(lines, "ends");
  const extreme = encodedSnapshot(250_000, "ends");
  expect(snapshot.bytes).toBeLessThan(2 * 1024 * 1024);
  expect(updateBytes).toBeLessThan(2 * 1024 * 1024);
  expect(extreme.bytes).toBeGreaterThan(2 * 1024 * 1024);
  console.log(`test-owned ordered ends: 60000-line snapshot ${snapshot.bytes} bytes, replacement ${updateBytes}; 250000-line snapshot ${extreme.bytes}`);
  sub.close(); provider.dispose();
});
