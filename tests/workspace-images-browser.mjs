import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { WORKSPACE_IMAGE_PATH } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const evidence = ".scratch/workspace-markdown-images/browser";
await mkdir(evidence, { recursive: true });
const fixture = fixtureBackend();
let enabled = true,
  streaming = false,
  older = false,
  missing = true;
let sessionId = "workspace-fixture";
let streamText = "";
const source = [
  'Before ![relative](plots/relative.png "Relative title") after.',
  "![absolute](/workspace/absolute.jpg)",
  "![encoded][figure]",
  "![gif](plots/moving.gif)",
  "![literal-percent](plots/%2520.png)",
  "![missing](plots/missing.png)",
  "![external](http://external.fixture/image.png)",
  "![shared](/api/chat/media/shared/original)",
  "![invalid](file:/workspace/private.png)",
  "![svg](plots/unsupported.svg)",
  "",
  '[figure]: plots/%E7%81%AF%20%E5%85%89.webp "Encoded title"',
].join("\n\n");
const message = {
  id: "workspace-answer",
  role: "agent",
  text: source,
  thinking: "![private](plots/thinking.png)",
  createdAt: 1,
  operationId: null,
  turnId: "turn",
};
const host = await createChatHost({
  ...fixture.backend,
  async read() {
    return {
      ...(await fixture.backend.read()),
      sessionId,
      capabilities: {
        text: true,
        steer: true,
        stop: true,
        images: false,
        ...(enabled ? { workspaceImages: true } : {}),
      },
      activeTurnId: streaming ? "turn" : null,
      ...(streaming
        ? {
            streamingReply: {
              id: message.id,
              turnId: "turn",
              createdAt: 1,
              text: streamText,
            },
          }
        : {}),
      messages:
        streaming || older
          ? []
          : [
              message,
              {
                ...message,
                id: "user",
                role: "user",
                text: "![user](plots/user.png)",
                thinking: "",
              },
            ],
      before: older ? "older" : null,
    };
  },
  async history() {
    return { messages: [message], before: null };
  },
});
const channels = new Map(),
  requests = [],
  unexpected = [];
const bytes = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/api/chat/socket" && server.upgrade(req)) return;
    if (url.pathname === "/gone")
      return new Response("<p>Left chat</p>", {
        headers: { "Content-Type": "text/html" },
      });
    if (url.pathname === WORKSPACE_IMAGE_PATH) {
      const path = url.searchParams.get("path");
      requests.push({
        path,
        retry: url.searchParams.get("retry"),
        cookie: req.headers.get("cookie"),
      });
      if (!req.headers.get("cookie")?.includes("fixture-owner=1"))
        return new Response(null, { status: 401 });
      if (path === "plots/missing.png" && missing)
        return new Response(null, { status: 404 });
      const ext = path.split(".").at(-1);
      return new Response(bytes.get(ext) ?? fixtureImage, {
        headers: {
          "Content-Type": `image/${ext === "jpg" ? "jpeg" : ext}`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.pathname === "/api/chat/media/shared/original")
      return new Response(fixtureImage, {
        headers: { "Content-Type": "image/png" },
      });
    if (url.pathname === "/plots/user.png")
      return new Response(fixtureImage, {
        headers: { "Content-Type": "image/png" },
      });
    if (
      url.pathname.startsWith("/plots/") &&
      /\.(png|jpg|webp|gif|svg)$/.test(url.pathname)
    )
      unexpected.push(url.pathname);
    return staticAssets(resolve("apps/web/build"), url.pathname, {
      "Set-Cookie": "fixture-owner=1; Path=/; SameSite=Strict",
    });
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
const url = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
const results = [];
try {
  for (const width of [390, 1280, 320]) {
    enabled = true;
    streaming = false;
    older = false;
    missing = true;
    sessionId = `workspace-${width}`;
    await host.refresh();
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: "zh-CN",
    });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const generated = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1200;
      c.height = 180;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#8ab6b1";
      ctx.fillRect(0, 0, 1200, 180);
      return ["png", "jpeg", "webp"].map((ext) => [
        ext === "jpeg" ? "jpg" : ext,
        c.toDataURL(`image/${ext}`).split(",")[1],
      ]);
    });
    for (const [ext, b64] of generated)
      bytes.set(ext, Buffer.from(b64, "base64"));
    bytes.set(
      "gif",
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
    await page.route("http://external.fixture/**", (route) =>
      route.fulfill({
        body: Buffer.from(fixtureImage),
        contentType: "image/png",
      }),
    );
    await page.goto(url);
    const images = page.locator("img.workspace-image");
    const decoded = async (count) => {
      await expect(images).toHaveCount(count);
      await expect
        .poll(() =>
          images.evaluateAll((nodes) =>
            nodes.every((n) => n.complete && n.naturalWidth > 0),
          ),
        )
        .toBe(true);
    };
    await decoded(5);
    await expect(images.first()).toHaveAttribute("title", "Relative title");
    await expect(page.locator('img[alt="encoded"]')).toHaveAttribute(
      "title",
      "Encoded title",
    );
    const retry = page
      .locator(".workspace-image-unavailable")
      .filter({ hasText: "missing" })
      .getByRole("button", { name: "重试", exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({
      path: `${evidence}/unavailable-${width}.png`,
      fullPage: true,
    });
    missing = false;
    await retry.click();
    await decoded(6);
    expect(
      requests.some((r) => r.path === "plots/missing.png" && r.retry === "1"),
    ).toBe(true);
    expect(requests.some((r) => r.path === "plots/灯 光.webp")).toBe(true);
    expect(requests.some((r) => r.path === "plots/%20.png")).toBe(true);
    expect(requests.every((r) => r.cookie?.includes("fixture-owner=1"))).toBe(
      true,
    );
    expect(
      requests.some((r) =>
        /thinking|user|private|unsupported|shared/.test(r.path),
      ),
    ).toBe(false);
    for (const alt of ["external", "shared"]) {
      await page.locator(`img[alt="${alt}"]`).scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          page.locator(`img[alt="${alt}"]`).evaluate((n) => n.naturalWidth),
        )
        .toBeGreaterThan(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await images.evaluateAll((nodes) =>
        nodes.every((n) => n.getBoundingClientRect().right <= innerWidth),
      ),
    ).toBe(true);
    await page
      .locator(".companion-timeline")
      .evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `${evidence}/loaded-${width}.png`,
      fullPage: true,
    });
    // Capability removal destroys current images immediately and cannot request workspace paths.
    enabled = false;
    await host.refresh();
    await expect(images).toHaveCount(0);
    const before = requests.length;
    await expect(
      page
        .locator(".workspace-image-unavailable")
        .filter({ hasText: "relative" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page
        .locator(".workspace-image-unavailable")
        .filter({ hasText: "relative" }),
    ).toBeVisible();
    expect(requests.length).toBe(before);
    // Same paths in a new session are remounted under the new host capability.
    enabled = true;
    sessionId += "-new";
    await host.refresh();
    await decoded(6);
    streaming = true;
    streamText = "![live](plots/live.png)\n";
    sessionId += "-stream";
    await host.refresh();
    await decoded(1);
    streamText = source + "\n";
    await host.refresh();
    await decoded(6);
    await page.screenshot({
      path: `${evidence}/streaming-${width}.png`,
      fullPage: true,
    });
    streaming = false;
    older = true;
    await host.refresh();
    await page.reload();
    await page
      .getByRole("button", { name: "查看更早的消息", exact: true })
      .click();
    await decoded(6);
    await page
      .locator(".companion-timeline")
      .evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `${evidence}/history-${width}.png`,
      fullPage: true,
    });
    // Real route teardown clears image DOM; no retry or stale-host reads after removal.
    await page.goto(new URL("/gone", url).href);
    await expect(images).toHaveCount(0);
    const afterTeardown = requests.length;
    await host.refresh();
    expect(requests.length).toBe(afterTeardown);
    expect(errors).toEqual([]);
    results.push({
      width,
      decodedFormats: ["png", "jpeg", "webp", "gif"],
      retry: true,
      unsupportedRequests: 0,
      streaming: true,
      history: true,
      overflow: false,
      errors,
    });
    await context.close();
  }
  expect(unexpected).toEqual([]);
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify({ results, requests, unexpected }, null, 2) + "\n",
  );
  console.log(
    "Workspace images: decode, relative/absolute/reference/encoded paths, retry, unsupported host, streaming/history, media, session/route lifecycle and mobile passed.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  await server.stop(true);
}
