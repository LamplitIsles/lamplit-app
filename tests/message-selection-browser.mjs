import { chromium, devices, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fixtureBackend } from "./fixture.ts";
import { createUiTestHost } from "./ui-test-host.ts";
import { staticAssets } from "./static-assets.mjs";
import { fixtureImage } from "./panels-fixture.ts";

const fixture = fixtureBackend();
const host = await createUiTestHost({
  ...fixture.backend,
  async read() {
    return {
      ...(await fixture.backend.read()),
      messages: [
        {
          id: "selection",
          role: "agent",
          text: "这是一段**需要复制**的文字",
          createdAt: 1,
          operationId: null,
          turnId: "selection-turn",
        },
        {
          id: "image-selection",
          role: "agent",
          text: "",
          images: [
            {
              attachmentId: "selection-image",
              name: "sample.png",
              mediaType: "image/png",
              availability: "available",
            },
          ],
          createdAt: 2,
          operationId: null,
          turnId: "image-turn",
        },
      ],
    };
  },
});
const channels = new Map();
const favorites = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(request)) return;
    if (path === "/api/stickers/favorites/image") {
      favorites.push(await request.json());
      return Response.json({
        favorite: true,
        sticker: {
          id: "fixture-sticker",
          version: "a".repeat(64),
          name: "sample",
          tags: [],
          mediaType: "image/png",
          available: true,
        },
      });
    }
    if (path.startsWith("/api/chat/media/selection-image/"))
      return new Response(fixtureImage, {
        headers: { "content-type": "image/png" },
      });
    return staticAssets(resolve("apps/web/build"), path);
  },
  websocket: {
    open(ws) {
      channels.set(
        ws,
        host.connect(ws, async () => true),
      );
    },
    message(ws, data) {
      void channels.get(ws).receive(String(data));
    },
    close(ws) {
      channels.get(ws)?.close();
      channels.delete(ws);
    },
  },
});
const origin = `http://127.0.0.1:${server.port}/`;
await mkdir(".scratch/iphone-composer-touch", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__copiedText = value;
        },
      },
    }),
  );
  const page = await context.newPage();
  await page.goto(origin);
  const bubble = page
    .locator(".companion-text-bubble")
    .filter({ hasText: "这是一段需要复制的文字" });
  await expect(bubble).toBeVisible();
  const box = await bubble.boundingBox();
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  const menu = page.getByTestId("message-action-menu");
  await expect(
    menu.getByRole("button", { name: "复制", exact: true }),
  ).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.screenshot({
    path: ".scratch/iphone-composer-touch/text-selection.png",
  });
  expect(
    await bubble.evaluate((node) => {
      const selection = document.getSelection();
      return (
        !!selection &&
        node.contains(selection.anchorNode) &&
        node.contains(selection.focusNode) &&
        selection.toString()
      );
    }),
  ).toBe("这是一段需要复制的文字");
  await expect(menu.getByRole("button", { name: "取消" })).toHaveCount(0);
  expect(
    await page
      .locator(".companion-message-overlay")
      .evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe("none");
  await bubble.evaluate((node) => {
    const text = [...node.querySelector(".markdown p").childNodes].find(
      (child) =>
        child.nodeType === Node.TEXT_NODE &&
        child.textContent.includes("这是一段"),
    );
    const bold = [...node.querySelector(".markdown strong").childNodes].find(
      (child) =>
        child.nodeType === Node.TEXT_NODE &&
        child.textContent.includes("需要复制"),
    );
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(bold, 3);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.waitForTimeout(500);
  const copyBox = await menu
    .getByRole("button", { name: "复制", exact: true })
    .boundingBox();
  const copyPoint = {
    x: copyBox.x + copyBox.width / 2,
    y: copyBox.y + copyBox.height / 2,
  };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [copyPoint],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => page.evaluate(() => window.__copiedText))
    .toBe("段需要复");
  await expect(menu).toHaveCount(0);
  const image = page.locator(".companion-media-button");
  await expect(image).toBeVisible();
  const imageBox = await image.boundingBox();
  const imagePoint = {
    x: imageBox.x + imageBox.width / 2,
    y: imageBox.y + imageBox.height / 2,
  };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [imagePoint],
  });
  await expect(
    menu.getByRole("button", { name: "保存图片", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("button", { name: "收藏为表情", exact: true }),
  ).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const menuButtons = await menu
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    );
  await page.screenshot({
    path: ".scratch/iphone-composer-touch/image-menu.png",
  });
  expect(Math.abs(menuButtons[0].top - menuButtons[1].top)).toBeLessThan(2);
  await expect(menu.getByRole("button", { name: "取消" })).toHaveCount(0);
  const saveBox = await menu
    .getByRole("button", { name: "保存图片" })
    .boundingBox();
  const savePoint = {
    x: saveBox.x + saveBox.width / 2,
    y: saveBox.y + saveBox.height / 2,
  };
  const downloaded = page.waitForEvent("download", { timeout: 10000 });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [savePoint],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const download = await downloaded;
  expect(await readFile(await download.path())).toEqual(
    Buffer.from(fixtureImage),
  );
  await expect(menu).toHaveCount(0);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [imagePoint],
  });
  await expect(
    menu.getByRole("button", { name: "收藏为表情", exact: true }),
  ).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const favoriteBox = await menu
    .getByRole("button", { name: "收藏为表情" })
    .boundingBox();
  const favoritePoint = {
    x: favoriteBox.x + favoriteBox.width / 2,
    y: favoriteBox.y + favoriteBox.height / 2,
  };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [favoritePoint],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(() => favorites.length).toBe(1);
  expect(favorites[0]).toMatchObject({
    sessionId: "fixture-session",
    imageId: "selection-image",
  });
  await expect(menu).toHaveCount(0);
  await bubble.focus();
  await bubble.press("Shift+F10");
  await expect(
    menu.getByRole("button", { name: "复制", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(bubble).toBeFocused();
  await bubble.press("Shift+F10");
  await menu.getByRole("button", { name: "复制", exact: true }).press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__copiedText))
    .toBe("这是一段需要复制的文字");
  await expect(menu).toHaveCount(0);
  await context.close();
  console.log("message selection: bounded selection and partial copy passed");
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
