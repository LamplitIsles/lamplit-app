import { imagesFixture } from "./images-fixture.ts";
import {
  validate,
  ContextUsageSchema,
  type ContextUsage,
  type Compaction,
} from "../packages/contracts/src/index.ts";
/** Test-owned fake native engine. The controls are also the actual-host runner interface. */
export function compactFixture() {
  const images = imagesFixture();
  let sessionId = "fixture-session";
  let contextUsage: ContextUsage = { tokens: null, capacity: null };
  let compaction: Compaction = null;
  let busy = false,
    refuse = false,
    executions = 0,
    calls = 0,
    hold = false;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  const begin = () => {
    compaction = { id: `compact-${++executions}`, status: "running" };
    changed();
  };
  const backend = {
    ...images.backend,
    async read() {
      return {
        ...(await images.backend.read()),
        sessionId,
        contextUsage: { ...contextUsage },
        compaction: compaction && { ...compaction },
        activeTurnId: busy ? "native-busy" : null,
      };
    },
    async compact(input: { sessionId: string }) {
      calls++;
      if (input.sessionId !== sessionId) throw new Error("Wrong session");
      if (busy || refuse || compaction?.status === "running")
        return { sessionId: input.sessionId, accepted: false };
      begin();
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { sessionId: input.sessionId, accepted: true };
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      const off = images.backend.subscribe(fn);
      return () => {
        listeners.delete(fn);
        off();
      };
    },
  };
  const control = async (input: Record<string, unknown>) => {
    switch (input.action) {
      case "reset":
        release?.();
        release = undefined;
        await images.control({ action: "reset" });
        sessionId = "fixture-session";
        contextUsage = { tokens: null, capacity: null };
        compaction = null;
        busy = refuse = hold = false;
        executions = calls = 0;
        break;
      case "usage":
        contextUsage = validate(ContextUsageSchema, {
          tokens: input.tokens,
          capacity: input.capacity,
        });
        break;
      case "busy":
        busy = input.enabled === true;
        break;
      case "refuse":
        refuse = input.enabled === true;
        break;
      case "hold":
        hold = input.enabled === true;
        break;
      case "release":
        release?.();
        release = undefined;
        hold = false;
        break;
      case "auto":
        begin();
        break;
      case "finish":
        if (!compaction) throw new Error("No compaction");
        compaction = {
          ...compaction,
          status: input.failed ? "failed" : "complete",
        };
        if (!input.failed) contextUsage = { ...contextUsage, tokens: null };
        break;
      case "session":
        sessionId = String(input.sessionId);
        compaction = null;
        contextUsage = { tokens: null, capacity: null };
        busy = false;
        break;
      case "state":
        break;
      default:
        throw new Error("Unknown compact control");
    }
    changed();
    return {
      sessionId,
      contextUsage,
      compaction,
      calls,
      executions,
      submissions: (await images.control({ action: "state" })).submissions,
    };
  };
  return { backend, control };
}
