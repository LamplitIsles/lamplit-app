import { createUiTestHost } from "./ui-test-host.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";

if (process.env.APP_ACCEPTANCE_URL || process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("This test only uses an isolated fixture");
const fixture = fixtureBackend();
for (let i = 0; i < 12; i++) {
  await fixture.backend.submit({
    sessionId: "fixture-session",
    operationId: `inset-${i}`,
    text: `message ${i}`,
  });
  await fixture.complete(`reply ${i}`);
}
const host = await createUiTestHost(fixture.backend);
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    return staticAssets(assets, path);
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
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
  args: ["--disable-background-networking", "--disable-sync"],
});
try {
  for (const { width, ios } of [{ width: 390, ios: false }, { width: 390, ios: true }, { width: 1280, ios: false }]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
      ...(ios ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } : {}),
      serviceWorkers: "block",
    });
    await context.addInitScript((theme) => localStorage.setItem("her.companion.ui-theme", theme), ios ? "ios" : "material");
    await context.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    if (width === 390)
      await context.addInitScript(() => {
        const viewport = new EventTarget();
        Object.assign(viewport, {
          width: 390,
          height: 844,
          offsetTop: 0,
          offsetLeft: 0,
          scale: 1,
        });
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: viewport,
        });
        window.setFixtureKeyboard = (open) => {
          viewport.height = open ? 500 : 844;
          viewport.dispatchEvent(new Event("resize"));
        };
      });
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByText("reply 11").waitFor();
    const timeline = page.locator(".companion-timeline");
    const last = page.locator(".companion-row").last();
    const bar = page.locator(".companion-composer");
    const lastIsAboveBar = async () => {
      const [message, composer] = await Promise.all([
        last.boundingBox(),
        bar.boundingBox(),
      ]);
      return message && composer
        ? message.y + message.height <= composer.y
        : false;
    };
    await timeline.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(lastIsAboveBar).toBe(true);
    if (width === 390) {
      await page.locator("#companion-textarea").focus();
      await page.evaluate(() => window.setFixtureKeyboard(true));
      await expect(page.locator(".companion-bottom-nav")).toBeHidden();
      await page
        .locator("#companion-textarea")
        .fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
      await expect.poll(lastIsAboveBar).toBe(true);
      await page.evaluate(() => window.setFixtureKeyboard(false));
      await expect(page.locator(".companion-bottom-nav")).toBeVisible();
      await expect.poll(lastIsAboveBar).toBe(true);
      await timeline.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(page.locator(".companion-return-latest")).toBeVisible();
      await page.evaluate(() => window.setFixtureKeyboard(true));
      await page.locator("#companion-textarea").fill("short");
      await expect
        .poll(() => timeline.evaluate((el) => el.scrollTop))
        .toBeLessThan(96);
      await page.evaluate(() => window.setFixtureKeyboard(false));
      await expect
        .poll(() => timeline.evaluate((el) => el.scrollTop))
        .toBeLessThan(96);
      const latest = page.locator(".companion-return-latest .k-fab");
      await expect(latest).toBeVisible();
      const fabTheme = await page.evaluate(() => document.documentElement.classList.contains("ios") ? "ios" : "material");
      expect(fabTheme).toBe(ios ? "ios" : "material");
      const fabBounds = await latest.boundingBox();
      expect(fabBounds.width).toBe(fabTheme === "ios" ? 44 : 56);
      expect(fabBounds.height).toBe(fabTheme === "ios" ? 44 : 56);
      await latest.click();
      await expect
        .poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(50);
    }
    console.log(`${width} ${ios ? "ios" : "material"}: passed`);
    await context.close();
  }
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
