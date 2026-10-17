import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { sentenceFixture } from "./sentence-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Owned DTO authority, real socket → controller → Partner → Companion DOM.
const fixture = sentenceFixture();
const host = await createChatHost(fixture.backend);
const channels = new Map();
const assets = resolve("apps/web/build");
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/reply-body-typing/browser";
await mkdir(evidence, { recursive: true });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/__test/control") {
      const result = fixture.control(await req.json());
      await host.refresh();
      return Response.json(result);
    }
    if (path === "/__test/disconnect") {
      for (const ws of channels.keys()) ws.close();
      return Response.json({ disconnected: true });
    }
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      window.replyObservations = [];
      window.replyFrames = 0;
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", () => window.replyFrames++);
        }
      };
      new MutationObserver(() => {
        if (
          ["unfinished final tail", "Whole tail final"].some((text) =>
            document.body?.textContent.includes(text),
          )
        )
          window.replyObservations.push({
            typing: !!document.querySelector(
              '[data-testid="companion-typing-indicator"]',
            ),
            stop: !!document.querySelector('[data-testid="companion-stop"]'),
          });
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    const control = async (action, text) => {
      const observing = page.url().startsWith("http:");
      const frames = observing
        ? await page.evaluate(() => window.replyFrames)
        : 0;
      const result = await context.request.post(
        `http://127.0.0.1:${server.port}/__test/control`,
        { data: { action, text } },
      );
      expect(result.ok()).toBe(true);
      if (observing) {
        await page.waitForFunction(
          (frames) => window.replyFrames > frames,
          frames,
        );
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      return result.json();
    };
    await control("session");
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const bubbles = page.locator(".message-received .companion-text-bubble");
    const typing = page.getByTestId("companion-typing-indicator");
    const stop = page.getByTestId("companion-stop");
    await control("start", "");
    await expect(typing).toBeVisible();
    await expect(bubbles).toHaveCount(0);
    await control("advance", "First line\r\nSecond line\nunfinished");
    await expect(bubbles).toHaveText(["First line", "Second line"]);
    await expect(typing).toBeVisible();
    await expect(stop).toBeVisible();
    await page.screenshot({ path: `${evidence}/held-${width}.png` });
    await control(
      "body-complete",
      "First line\r\nSecond line\nunfinished final tail",
    );
    await expect(bubbles).toHaveText([
      "First line",
      "Second line",
      "unfinished final tail",
    ]);
    await expect(stop).toBeVisible();
    await page.screenshot({ path: `${evidence}/final-${width}.png` });
    console.log(
      "held final body",
      JSON.stringify({
        width,
        typing: await typing.count(),
        stop: await stop.count(),
        body: await bubbles.allTextContents(),
        authority: await fixture.backend.read(),
      }),
    );
    await expect(typing).toHaveCount(0, { timeout: 1500 });
    expect(
      await page.evaluate(() => window.replyObservations.length),
    ).toBeGreaterThan(0);
    expect(
      await page.evaluate(() =>
        window.replyObservations.every((s) => !s.typing && s.stop),
      ),
    ).toBe(true);
    // Execution still permits queued/steered input while the final body is held.
    await page.locator("#companion-textarea").fill("Test-owned queued input");
    await expect(page.locator(".companion-send")).toBeEnabled();
    await page.locator("#companion-textarea").fill("");
    const finishedTurn = (await fixture.backend.read()).activeTurnId;
    await context.request.post(
      `http://127.0.0.1:${server.port}/__test/disconnect`,
    );
    await expect(page.locator(".companion-presence")).toContainText("离线");
    await expect(typing).toHaveCount(0);
    await expect(page.locator(".companion-presence")).not.toContainText(
      "离线",
      { timeout: 6000 },
    );
    await expect(typing).toHaveCount(0);
    await expect(stop).toBeVisible();
    await control("finish-execution");
    await expect(stop).toHaveCount(0);
    await expect(typing).toHaveCount(0);
    await control("start", "Non-final item");
    await expect(typing).toBeVisible();
    await control("item-complete", "Non-final item");
    await expect(bubbles.last()).toHaveText("Non-final item");
    await expect(typing).toBeVisible();
    await control("evidence", finishedTurn);
    await expect(typing).toBeVisible();
    await control("evidence"); // omission must delete the previous snapshot field
    await expect(typing).toBeVisible();
    await control("stop");
    await expect(stop).toHaveCount(0);
    await expect(typing).toHaveCount(0);
    // Whole mode uses the same final-body decision, without source-line buffering.
    await page.getByRole("button", { name: "外观与语言", exact: true }).click();
    await page
      .locator(
        '#companion-preferences-panel input[name=companion-reply-display][value="false"]',
      )
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#companion-preferences-panel")).toBeHidden();
    await control("session");
    await expect(bubbles).toHaveCount(0);
    await page.evaluate(() => {
      window.replyObservations = [];
    });
    await control("start", "Whole first\nWhole tail");
    await expect(bubbles).toHaveCount(1);
    await expect(bubbles).toContainText("Whole tail");
    await expect(typing).toBeVisible();
    await control("body-complete", "Whole first\nWhole tail final");
    await expect(bubbles).toContainText("Whole tail final");
    await expect(typing).toHaveCount(0);
    await expect(stop).toBeVisible();
    expect(
      await page.evaluate(() => window.replyObservations.length),
    ).toBeGreaterThan(0);
    expect(
      await page.evaluate(() =>
        window.replyObservations.every((s) => !s.typing && s.stop),
      ),
    ).toBe(true);
    await control("evidence");
    await expect(typing).toBeVisible(); // proves removal, rather than merge/caching
    await control("evidence", (await fixture.backend.read()).activeTurnId);
    await expect(typing).toHaveCount(0);
    await stop.click(); // targeted real socket Stop still works after final body
    await expect(stop).toHaveCount(0);
    await expect(typing).toHaveCount(0);
    await control("session");
    await expect(stop).toHaveCount(0);
    await expect(bubbles).toHaveCount(0);
    await control("start", "Fresh session tail");
    await expect(typing).toBeVisible();
    await control("fail");
    await expect(typing).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        scope:
          "App DTO fixture, real socket and built Partner/Companion DOM; not native proof",
        widths: [390, 1280],
        acceptance: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.stop(true);
}
