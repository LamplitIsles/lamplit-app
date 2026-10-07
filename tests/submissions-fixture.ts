import { imagesFixture } from "./images-fixture.ts";
import type { ChatBackend } from "../packages/contracts/src/server.ts";

/** Test-owned timing/transport controls around the same HTTP/socket fixture. */
export function submissionsFixture() {
  const fixture = imagesFixture();
  let mode = "submitted",
    hidden = false,
    submitCalls = 0,
    lookupCalls = 0;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const view = await fixture.backend.read();
      return { ...view, messages: hidden ? [] : view.messages };
    },
    async submit(input) {
      submitCalls++;
      if (mode === "null")
        throw new Error("Test-owned lost acknowledgement before submission");
      if (mode === "slow") await gate;
      const receipt = await fixture.backend.submit(input);
      if (mode === "publishFirst") await gate;
      if (mode === "lost")
        throw new Error("Test-owned lost acknowledgement after submission");
      return receipt;
    },
    async lookup(id) {
      lookupCalls++;
      return fixture.backend.lookup(id);
    },
  };
  const control = async (input: Record<string, unknown>) => {
    switch (input.action) {
      case "reset":
        release?.();
        gate = undefined;
        release = undefined;
        mode = "submitted";
        hidden = false;
        submitCalls = lookupCalls = 0;
        await fixture.control(input);
        break;
      case "mode": {
        release?.();
        gate = undefined;
        release = undefined;
        mode = String(input.state);
        hidden = input.hidden === true;
        if (mode === "slow" || mode === "publishFirst")
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        await fixture.control({
          action: "mode",
          state: ["failed", "withdrawn"].includes(mode) ? mode : "submitted",
        });
        break;
      }
      case "release":
        release?.();
        gate = undefined;
        release = undefined;
        break;
      case "publish":
        hidden = false;
        break;
      case "replyFailure": {
        // Reply outcomes are notices, never failed submission receipts/recovery.
        await fixture.control({ action: "replyFailure" });
        break;
      }
      case "state":
        break;
      default:
        await fixture.control(input);
    }
    return {
      ...(await fixture.control({ action: "state" })),
      submitCalls,
      lookupCalls,
    };
  };
  return { ...fixture, backend, control };
}
