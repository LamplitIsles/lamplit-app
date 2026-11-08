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
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
      serviceWorkers: "block",
    });
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
    }
    console.log(`${width}: passed`);
    await context.close();
  }
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
