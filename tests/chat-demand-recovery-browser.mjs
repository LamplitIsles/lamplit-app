import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";

const fixture = fixtureBackend();
const host = await createChatHost(fixture.backend);
const sockets = new Map();
const allSockets = new Set();
let calls = 0,
  opens = 0,
  rejectOpen = false,
  authorized = false;
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    if (path.startsWith("/api/")) return new Response(null, { status: 404 });
    return staticAssets(assets, path);
  },
  websocket: {
    open(ws) {
      opens++;
      allSockets.add(ws);
      if (rejectOpen) {
        ws.close(1011, "test-owned unavailable");
        return;
      }
      sockets.set(
        ws,
        host.connect(ws, async () => authorized),
      );
    },
    message(ws, raw) {
      calls++;
      void sockets.get(ws).receive(String(raw));
    },
    close(ws) {
      allSockets.delete(ws);
      sockets.get(ws)?.close();
      sockets.delete(ws);
    },
  },
});
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(denyNativeNotifications);
  await page.goto(`http://127.0.0.1:${server.port}`);
  const reconnect = page.getByRole("button", {
    name: "Reconnect",
    exact: true,
  });
  await expect(reconnect).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(16000);
  authorized = true;
  await page.evaluate(() => {
    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
  });
  expect(opens).toBe(1);
  await reconnect.click();
  await expect.poll(() => opens).toBe(2);
  await expect(page.locator("#companion-textarea")).toBeVisible();
  await page.locator("#companion-textarea").fill("retained recovery draft");
  // Let initialization and panel reads settle, then advance beyond the old heartbeat.
  await page.waitForTimeout(150);
  const initial = calls;
  await page.clock.fastForward(16000);
  await page.evaluate(() => document.title);
  expect(calls).toBe(initial);
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
  });
  expect(opens).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect.poll(() => opens).toBe(3);
  await expect(page.locator("#companion-textarea")).toHaveValue(
    "retained recovery draft",
  );
  await fixture.backend.submit({
    operationId: crypto.randomUUID(),
    text: "fresh live update",
  });
  await host.refresh();
  await page.clock.runFor(100);
  await expect(
    page.getByText("fresh live update", { exact: true }),
  ).toBeVisible();
  // A failed immediate reconnect leaves a backoff timer; actual typing interrupts it.
  rejectOpen = true;
  for (const ws of sockets.keys()) ws.close(1011, "test-owned disconnect");
  await expect.poll(() => opens).toBe(4);
  await page.waitForTimeout(50);
  rejectOpen = false;
  await page.locator("#companion-textarea").press("ArrowRight");
  await expect.poll(() => opens).toBe(5);
  await expect(page.locator("#companion-textarea")).toHaveValue(
    "retained recovery draft",
  );
  for (const ws of sockets.keys()) ws.close(1008, "test-owned policy denial");
  await expect(page.locator(".companion-status").locator("..")).toContainText(
    "Offline",
  );
  await page.locator("#companion-textarea").press("ArrowRight");
  await page.evaluate(() => {
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("online"));
  });
  expect(opens).toBe(5);
  await page.close();
  console.log(
    "Compiled browser lifecycle passed: idle zero RPC, coalesced hints, foreground replacement, draft and live update retained.",
  );
} finally {
  await browser.close();
  for (const socket of allSockets) socket.terminate();
  host.close();
  server.unref();
  void server.stop(true);
}
