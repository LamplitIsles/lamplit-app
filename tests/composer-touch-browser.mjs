import { chromium, devices, expect } from "@playwright/test";
import { createUiTestHost } from "./ui-test-host.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { resolve } from "node:path";

// This fixture never connects to a real voice service or captures microphone audio.
const fixture = fixtureBackend();
const host = await createUiTestHost(fixture.backend);
const channels = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    if (path === "/api/voice/capability")
      return Response.json({ available: true });
    if (path.endsWith("/packs"))
      return Response.json({ packs: [], nextCursor: null });
    if (path.endsWith("/favorites"))
      return Response.json({ stickers: [], nextCursor: null });
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
const origin = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-background-networking", "--disable-sync"],
});
try {
  const scenarios = [
    { name: "tab_hold", selector: ".companion-nav-item", delay: 600 },
    { name: "emoji_tap", selector: ".companion-stickers", delay: 80 },
    { name: "input_tap", selector: "#companion-textarea", delay: 80 },
  ].filter(
    ({ name }) =>
      !process.env.APP_TOUCH_CASE || process.env.APP_TOUCH_CASE === name,
  );
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "zh-CN",
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await context.addInitScript(() => {
      window.__fixtureCaptureCalls = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__fixtureCaptureCalls++;
        throw new DOMException("fixture", "NotAllowedError");
      };
    });
    const page = await context.newPage();
    await page.goto(origin);
    await expect(page.getByRole("button", { name: "开始录音" })).toBeEnabled();
    const target = page.locator(scenario.selector).first();
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const composer = page.locator(".companion-composer");
    const before = await composer.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.waitForTimeout(scenario.delay);
    const during = await composer.boundingBox();
    expect(Math.abs(during.width - before.width), scenario.name).toBeLessThan(
      0.5,
    );
    expect(Math.abs(during.height - before.height), scenario.name).toBeLessThan(
      0.5,
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if (scenario.name === "input_tap") {
      await expect(page.locator("#companion-textarea")).toBeFocused();
      await expect(page.locator(".companion-bottom-nav")).toBeHidden();
      await expect(page.locator(".companion-stickers")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
    if (scenario.name === "emoji_tap")
      await expect(page.getByRole("dialog", { name: "表情" })).toBeVisible();
    await expect(page.locator("[data-voice-hold]")).toHaveCount(0);
    expect(await page.evaluate(() => window.__fixtureCaptureCalls)).toBe(0);
    await cdp.detach();
    await context.close();
    console.log(`${scenario.name}: passed`);
  }
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
