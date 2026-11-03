import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { resolve } from "node:path";

export async function createSettingsHost() {
  const host = await createChatHost(fixtureBackend().backend);
  const channels = new Map();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/api/chat/socket" && server.upgrade(req)) return;
      return staticAssets(resolve("apps/web/build"), path);
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(ws, async () => true),
        );
      },
      message(ws, raw) {
        void channels.get(ws).receive(String(raw));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  return {
    port: server.port,
    async close() {
      for (const channel of channels.values()) channel.close();
      server.stop(true);
      await host.close();
    },
  };
}
