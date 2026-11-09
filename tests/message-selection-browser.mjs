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
          id: "sent-selection",
          role: "user",
          text: "短消息",
          createdAt: 2,
          operationId: null,
          turnId: "sent-turn",
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
  if (process.env.APP_GLASS_DARK === "1")
    await context.addInitScript(() => localStorage.setItem("her.companion.appearance", "dark"));
  const page = await context.newPage();
  await page.goto(origin);
  const bubble = page
    .locator(".companion-text-bubble")
    .filter({ hasText: "这是一段需要复制的文字" });
  await expect(bubble).toBeVisible();
  const box = await bubble.boundingBox();
  const glass = bubble.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' companion-glass-bubble ')]");
  await expect(glass).toHaveCount(1);
  expect(await glass.evaluate((node) => getComputedStyle(node).touchAction)).toBe("auto");
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  const menu = page.getByTestId("message-action-menu");
  await page.waitForTimeout(700);
  expect(await glass.evaluate((node) => node.style.scale)).toBe("");
  await expect(glass.locator('span[style*="radial-gradient"]')).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const nativeText = await bubble.evaluate((node) => {
    const style = getComputedStyle(node);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    return {
      selectable: style.userSelect,
      callout: style.webkitTouchCallout,
      allowed: node.dispatchEvent(event),
    };
  });
  expect(nativeText.selectable).toBe("text");
  expect(nativeText.callout).not.toBe("none");
  expect(nativeText.allowed).toBe(true);
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
  expect(await page.evaluate(() => document.getSelection().toString())).toBe("段需要复");
  const sent = page.locator(".companion-text-bubble").filter({ hasText: "短消息" });
  const sentGlass = sent.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' companion-glass-bubble ')]");
  expect(await sentGlass.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(await glass.evaluate((node) => getComputedStyle(node).backgroundColor));
  const sentBox = await sent.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: sentBox.x + sentBox.width / 2, y: sentBox.y + sentBox.height / 2 }],
  });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(menu).toHaveCount(0);
  const image = page.locator(".companion-media-button");
  await expect(image).toBeVisible();
  await expect(
    image.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' companion-glass-bubble ')]"),
  ).toHaveCount(0);
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
  await expect.poll(async () => {
    const imageBox = await image.boundingBox();
    const menuBox = await page.locator(".companion-action-menu").boundingBox();
    const expected = Math.min(imageBox.x, 390 - menuBox.width - 8);
    return Math.abs(menuBox.x - Math.max(8, expected));
  }).toBeLessThanOrEqual(2);
  const menuButtons = await menu
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    );
  await page.screenshot({
    path: process.env.APP_GLASS_DARK === "1"
      ? ".scratch/iphone-composer-touch/glass-image-menu-dark.png"
      : ".scratch/iphone-composer-touch/image-menu.png",
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
  await context.close();
  console.log("native text selection and image actions passed");
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
