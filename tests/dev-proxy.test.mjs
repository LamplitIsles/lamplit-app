import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// Vite's development server runs on Node; exercise its real HTTP and WS stack.
test("development proxy forwards HTTP and WebSocket requests", () => {
  const result = spawnSync(
    "node",
    ["--test", fileURLToPath(new URL("./dev-proxy-node.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 25000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}, 30000);
