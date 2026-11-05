import type { ChatBackend } from "../packages/contracts/src/server.ts";
import { createDirectTestHost } from "./direct-test-host.ts";

/** Project controlled browser-fixture state into the same updates a provider sends. */
export async function createUiTestHost(
  backend: ChatBackend,
  observer: (error: unknown) => void = () => {},
) {
  const host = await createDirectTestHost(backend, observer);
  let closed = false;
  let pending = Promise.resolve();
  const publish = () => {
    const next = pending.then(() => (closed ? undefined : host.publish()));
    pending = next.catch(() => {});
    return next;
  };
  const subscription = backend.subscribe(() => {
    void publish().catch(observer);
  });
  return {
    ...host,
    publish,
    close() {
      closed = true;
      subscription.close();
      host.close();
    },
  };
}
