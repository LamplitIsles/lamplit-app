import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
import { fixtureBackend } from "./fixture.ts";
import { fileLimits } from "./files-fixture.ts";
import { createUiTestHost } from "./ui-test-host.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";

const fixture = fixtureBackend();
const backend = {
  ...fixture.backend,
  async read() {
    const view = await fixture.backend.read();
    return {
      ...view,
      capabilities: { ...view.capabilities, files: fileLimits },
      messages: [{ id: "menu-message", role: "agent", text: "长按测试消息", createdAt: 1, operationId: null, turnId: "menu-turn" }],
    };
  },
};
const host = await createUiTestHost(backend);
const channels = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    return staticAssets(resolve("apps/web/build"), path);
  },
  websocket: {
    open(ws) { channels.set(ws, host.connect(ws, async () => true)); },
    message(ws, raw) { void channels.get(ws).receive(String(raw)); },
    close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
  },
});
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
      hasTouch: width === 390,
      ...(width === 390 ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}),
    });
    await context.addInitScript(denyNativeNotifications);
    await context.addInitScript(() => {
      window.__menuTransitions = [];
      document.addEventListener("transitionrun", (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".companion-composer-overlay")) return;
        if (target.matches(".k-popover, .k-actions")) {
          window.__menuTransitions.push({
            kind: target.matches(".k-popover") ? "popover" : "actions",
            closed: target.classList.contains("pointer-events-none") || target.classList.contains("translate-y-full"),
          });
        }
      }, true);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text) => { window.__copiedText = text; } },
        configurable: true,
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const bubble = page.locator(".companion-text-bubble").filter({ hasText: "长按测试消息" });
    const menu = page.getByTestId("message-action-menu");
    const copy = menu.getByRole("button", { name: "复制", exact: true });
    await expect(bubble).toBeVisible();
    await bubble.focus();
    await bubble.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(copy).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__menuTransitions.some((item) => item.kind === "popover" && !item.closed))).toBe(true);
    if (width === 390) {
      await page.mouse.move(1, 1);
      const background = await copy.evaluate((el) => getComputedStyle(el).backgroundColor);
      await copy.hover();
      await page.waitForTimeout(350);
      const light = menu.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' k-glass ')]").locator('span[style*="radial-gradient"]');
      await expect(light).toHaveCount(1);
      expect(await light.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("radial-gradient");
      await page.mouse.down();
      expect(await copy.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(background);
      await page.mouse.move(1, 1);
      await page.mouse.up();
      await copy.focus();
    }
    await expect(menu.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".companion-message-overlay")).toHaveAttribute("aria-hidden", "true");
    await expect(bubble).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__menuTransitions.some((item) => item.kind === "popover" && item.closed))).toBe(true);
    await bubble.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(700);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu, "closed after Escape").toHaveCount(0);
    await expect(bubble).toBeFocused();

    await bubble.click({ button: "right" });
    await expect(menu).toBeVisible();
    const position = await page.locator(".companion-action-menu.k-popover").boundingBox();
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.x + position.width).toBeLessThanOrEqual(width);
    await page.mouse.click(width - 5, 839);
    await expect(menu, "closed after backdrop click").toHaveCount(0);
    await bubble.click({ button: "right" });
    await expect(menu).toBeVisible();
    await copy.click();
    await expect(menu, "closed after copy").toHaveCount(0);
    expect(await page.evaluate(() => window.__copiedText)).toBe("长按测试消息");
    await bubble.scrollIntoViewIfNeeded();
    const box = await bubble.boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await expect(menu).toBeVisible();
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await expect(menu, "closed after mouse hold cancel").toHaveCount(0);

    if (width === 390) {
      const cdp = await context.newCDPSession(page);
      const bounds = await bubble.boundingBox();
      const point = { x: bounds.x + 8, y: bounds.y + bounds.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await expect(menu).toBeVisible();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.screenshot({ path: ".scratch/konsta-chat/message-menu-ios.png" });
      const outsidePoint = { x: width - 5, y: 5 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [outsidePoint] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(menu, "closed after touch hold cancel").toHaveCount(0);
      await cdp.detach();
      await page.getByRole("button", { name: "添加附件" }).click();
      const attachmentMenu = page.getByTestId("attachment-menu");
      await expect.poll(() => page.evaluate(() => window.__menuTransitions.some((item) => item.kind === "actions" && !item.closed))).toBe(true);
      const file = attachmentMenu.getByRole("button", { name: "上传文件", exact: true });
      await expect(file).toBeVisible();
      await page.mouse.move(1, 1);
      const background = await file.evaluate((el) => getComputedStyle(el).backgroundColor);
      await file.hover();
      await page.waitForTimeout(350);
      const lights = await file.evaluate((el) => el.closest('.k-actions-group').querySelectorAll('span[style*="radial-gradient"]').length);
      expect(lights).toBeGreaterThan(0);
      await page.mouse.down();
      expect(await file.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(background);
      await page.mouse.move(1, 1);
      await page.mouse.up();
      await attachmentMenu.getByRole("button", { name: "取消", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__menuTransitions.some((item) => item.kind === "actions" && item.closed))).toBe(true);
      await expect(attachmentMenu).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await context.close();
  }
  const reduced = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  await reduced.addInitScript(denyNativeNotifications);
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`http://127.0.0.1:${server.port}/`);
  const reducedBubble = reducedPage.locator(".companion-text-bubble").filter({ hasText: "长按测试消息" });
  await reducedBubble.click({ button: "right" });
  const reducedMenu = reducedPage.getByTestId("message-action-menu");
  await expect(reducedMenu).toBeVisible();
  await reducedPage.keyboard.press("Escape");
  await expect(reducedMenu).toHaveCount(0);
  await expect(reducedBubble).toBeFocused();
  await reduced.close();
  console.log("Konsta menus: transitions, reduced motion, focus, keyboard, mouse and touch passed");
} finally {
  await browser.close();
  for (const channel of channels.values()) channel.close();
  host.close();
  server.stop(true);
}
