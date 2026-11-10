import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { imageHttp, stickerHttp } from "../packages/contracts/src/server.ts";
import { imageLimits } from "./images-fixture.ts";

// This host and browser profile exist only for this test. No app service or account is used.
const version = "a".repeat(64);
const clientVersion = "b".repeat(64);
const agedClientVersion = "c".repeat(64);
const paths = {
  image: "/api/chat/media/cache-test/original",
  sticker: `/api/stickers/media/${version}/original`,
  client: `/api/stickers/media/${clientVersion}/original`,
  agedClient: `/api/stickers/media/${agedClientVersion}/original`,
};
const bytes = {
  image: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
  sticker: Uint8Array.from([71, 73, 70, 56, 57, 97, 1]),
};
const changes = {
  image: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
  sticker: Uint8Array.from([71, 73, 70, 56, 57, 97, 2]),
};
const requests = [];
let authorized = true;
const built = await Bun.build({
  entrypoints: ["./apps/web/src/lib/sticker-client.ts"],
  target: "browser",
});
if (!built.success)
  throw new Error(
    `Could not bundle real StickerClient: ${built.logs.join(", ")}`,
  );
const clientScript = await built.outputs[0].text();
const imageBackend = {
  async upload() {
    throw new Error("Unexpected upload");
  },
  async media() {
    return { bytes: bytes.image, mediaType: "image/png" };
  },
};
const stickerBackend = {
  async media() {
    return { bytes: bytes.sticker, mediaType: "image/gif" };
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/")
      return new Response("<!doctype html><title>Cache fixture</title>", {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      });
    if (url.pathname === "/client.js")
      return new Response(clientScript, {
        headers: {
          "content-type": "text/javascript",
          "cache-control": "no-store",
        },
      });
    const kind = Object.keys(paths).find((key) => paths[key] === url.pathname);
    if (!kind) return new Response(null, { status: 404 });
    const response =
      kind === "image"
        ? await imageHttp(request, imageBackend, async () => ({
            sessionId: "test-session",
            limits: imageLimits,
          }))
        : await stickerHttp(request, stickerBackend, async () =>
            authorized ? { sessionId: "test-session" } : null,
          );
    requests.push({
      kind,
      query: url.search,
      validator: request.headers.get("if-none-match"),
      status: response.status,
    });
    // Model a cached response already 30 days old without changing contract headers.
    if (url.searchParams.has("aged") || kind === "agedClient") {
      const headers = new Headers(response.headers);
      headers.set("Age", "2592000");
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
});
const root = `http://127.0.0.1:${server.port}`;
const profile = await mkdtemp(join(tmpdir(), "lamplit-media-cache-"));
let context;
async function startBrowser() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
  });
  const page = await context.newPage();
  await page.goto(root);
  return page;
}
async function fetchBytes(page, path, cache = "default") {
  return page.evaluate(
    async ({ path, cache }) => {
      const response = await fetch(path, { cache });
      if (!response.ok) throw new Error(`Unexpected HTTP ${response.status}`);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    },
    { path, cache },
  );
}
const count = (kind, query = "") =>
  requests.filter((entry) => entry.kind === kind && entry.query === query)
    .length;
async function loadClient(page, version) {
  return page.evaluate(async (version) => {
    const { StickerClient } = await import("/client.js");
    globalThis.testClient ??= new StickerClient("test-session", () => true);
    let result;
    await globalThis.testClient.loadMedia(version, "original", (blob) => {
      if (blob) result = blob;
    });
    if (!result) throw new Error("StickerClient did not return a blob");
    return Array.from(new Uint8Array(await result.arrayBuffer()));
  }, version);
}
try {
  let page = await startBrowser();
  for (const kind of ["image", "sticker"]) {
    assert.deepEqual(await fetchBytes(page, paths[kind]), [...bytes[kind]]);
    assert.equal(count(kind), 1);
    assert.deepEqual(await fetchBytes(page, paths[kind]), [...bytes[kind]]);
    assert.equal(count(kind), 1, `${kind} fresh reuse must not reach the host`);
  }
  assert.deepEqual(await loadClient(page, clientVersion), [...bytes.sticker]);
  assert.deepEqual(await loadClient(page, clientVersion), [...bytes.sticker]);
  assert.equal(
    count("client"),
    1,
    "StickerClient fresh reload must not reach the host",
  );
  await context.close();
  context = undefined;
  page = await startBrowser();
  assert.deepEqual(await loadClient(page, clientVersion), [...bytes.sticker]);
  assert.equal(
    count("client"),
    1,
    "StickerClient must reuse cache after browser restart",
  );
  bytes.sticker = changes.sticker;
  assert.notDeepEqual(await loadClient(page, clientVersion), [
    ...bytes.sticker,
  ]);
  assert.equal(
    count("client"),
    1,
    "StickerClient keeps fresh bytes after a server change",
  );
  assert.deepEqual(await loadClient(page, agedClientVersion), [
    ...bytes.sticker,
  ]);
  assert.deepEqual(await loadClient(page, agedClientVersion), [
    ...bytes.sticker,
  ]);
  const agedClientRequests = requests.filter(
    (entry) => entry.kind === "agedClient",
  );
  assert.equal(agedClientRequests.length, 2);
  assert.ok(agedClientRequests[1].validator);
  assert.equal(agedClientRequests[1].status, 304);
  bytes.sticker = Uint8Array.from([71, 73, 70, 56, 57, 97, 3]);
  assert.deepEqual(await loadClient(page, agedClientVersion), [
    ...bytes.sticker,
  ]);
  assert.equal(count("agedClient"), 3);
  assert.equal(
    requests.filter((entry) => entry.kind === "agedClient").at(-1).status,
    200,
  );
  authorized = false;
  assert.deepEqual(
    await loadClient(page, clientVersion),
    [71, 73, 70, 56, 57, 97, 1],
  );
  assert.equal(
    count("client"),
    1,
    "fresh cache cannot observe revoked authorization",
  );
  const revoked = await page.evaluate(async (version) => {
    const events = [],
      updates = [];
    globalThis.testClient.onAuthorizationLost((status) => events.push(status));
    await globalThis.testClient.loadMedia(version, "original", (blob) =>
      updates.push(blob === null ? "cleared" : "blob"),
    );
    return { events, updates };
  }, agedClientVersion);
  assert.deepEqual(revoked.events, [401]);
  assert.equal(revoked.updates.at(-1), "cleared");
  assert.equal(
    requests.filter((entry) => entry.kind === "agedClient").at(-1).status,
    401,
  );
  authorized = true;
  bytes.sticker = Uint8Array.from([71, 73, 70, 56, 57, 97, 1]);
  for (const kind of ["image", "sticker"]) {
    assert.deepEqual(await fetchBytes(page, paths[kind]), [...bytes[kind]]);
    assert.equal(
      count(kind),
      1,
      `${kind} should be reused after restarting Chrome`,
    );
    bytes[kind] = changes[kind];
    assert.notDeepEqual([...bytes[kind]], await fetchBytes(page, paths[kind]));
    assert.equal(count(kind), 1, `${kind} remains fresh after a server change`);
    assert.deepEqual(await fetchBytes(page, paths[kind], "no-cache"), [
      ...changes[kind],
    ]);
    assert.equal(count(kind), 2);
    const changed = requests
      .filter((entry) => entry.kind === kind && entry.query === "")
      .at(-1);
    assert.ok(changed.validator);
    assert.equal(changed.status, 200);
    assert.deepEqual(await fetchBytes(page, paths[kind], "no-cache"), [
      ...changes[kind],
    ]);
    const unchanged = requests
      .filter((entry) => entry.kind === kind && entry.query === "")
      .at(-1);
    assert.ok(unchanged.validator);
    assert.equal(unchanged.status, 304);

    const agedPath = `${paths[kind]}?aged=1`;
    assert.deepEqual(await fetchBytes(page, agedPath), [...changes[kind]]);
    assert.deepEqual(await fetchBytes(page, agedPath), [...changes[kind]]);
    const agedRequests = requests.filter(
      (entry) => entry.kind === kind && entry.query === "?aged=1",
    );
    assert.equal(
      agedRequests.length,
      2,
      `${kind} stale entry must reach the host`,
    );
    assert.ok(agedRequests[1].validator);
    assert.equal(agedRequests[1].status, 304);
  }
  console.log(
    "Chrome: image, sticker and real StickerClient fresh reuse, profile restart, forced revalidation, changes and Age-driven expiry passed",
  );
} finally {
  await context?.close();
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
