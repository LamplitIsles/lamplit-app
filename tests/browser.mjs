import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const fixture = fixtureBackend();
const host = await createChatHost(fixture.backend);
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    const relative = path.replace(/^\/slice\/?/, "");
    const target = resolve(assets, relative || "index.html");
    if (!target.startsWith(`${assets}/`))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(target);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
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
const browser = await chromium.launch({ headless: true, channel: "chrome" });
await mkdir(".scratch/browser", { recursive: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.port}/slice/`);
    const input = page.locator("#companion-textarea");
    await expect(input).toBeVisible();
    await input.fill(`hello-${width}`);
    await input.press("Enter");
    await expect(
      page.getByText(`hello-${width}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="companion-typing-indicator"]'),
    ).toBeVisible();
    const typingDot = page.locator(".message-typing-indicator > div").first();
    await expect(typingDot).toBeVisible();
    expect(
      await typingDot.evaluate((dot) => getComputedStyle(dot).animationName),
    ).not.toBe("none");
    const reply = `complete reply ${width}`;
    await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
    await context.setOffline(true);
    await fixture.complete(reply);
    await context.setOffline(false);
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(
      page.getByText("回复完成", { exact: true }).last(),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(
      page.getByText("回复完成", { exact: true }).last(),
    ).toBeVisible();
    await input.fill(`stop-${width}`);
    await input.press("Enter");
    const stop = page.locator('[data-testid="companion-stop"]');
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(
      page.getByText("已停止回复", { exact: true }).last(),
    ).toBeVisible();
    // An unconfirmed local send survives reload without automatic execution.
    const operationId = crypto.randomUUID();
    const recoveryText = `recovered-${width}`;
    const beforeRecovery = fixture.executions;
    await page.evaluate(
      ({ operationId, text }) => {
        localStorage.setItem(
          "lamplit.pending:fixture-session",
          JSON.stringify([
            { operationId, text, createdAt: Date.now(), state: "uncertain" },
          ]),
        );
      },
      { operationId, text: recoveryText },
    );
    await page.reload();
    await expect(page.getByText(recoveryText, { exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: "重试未发送消息" });
    await expect(retry).toBeVisible();
    expect(fixture.executions).toBe(beforeRecovery);
    await retry.click();
    await expect.poll(() => fixture.executions).toBe(beforeRecovery + 1);
    await expect(retry).toHaveCount(0);
    await page.reload();
    expect(fixture.executions).toBe(beforeRecovery + 1);
    await fixture.complete(`recovered reply ${width}`);
    await expect(
      page.getByText(`recovered reply ${width}`, { exact: true }),
    ).toBeVisible();
    // Imported CFL interactions must work through the shared completed-message controller.
    await input.fill(`link-${width}`);
    await input.press("Enter");
    await fixture.complete(`[external-${width}](https://example.com/lamplit)`);
    const link = page.getByRole("link", {
      name: `external-${width}`,
      exact: true,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await context.route("https://example.com/**", (route) =>
      route.fulfill({ body: "External page" }),
    );
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://example.com/lamplit");
    await popup.close();
    await expect(input).toBeVisible();
    const bubble = link.locator(
      "xpath=ancestor::div[contains(@class, 'companion-text-bubble')]",
    );
    await bubble.click({ button: "right" });
    const menu = page.locator(".companion-action-menu.modal-in");
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("button", { name: "复制消息", exact: true }),
    ).toBeVisible();
    await menu.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    await bubble.scrollIntoViewIfNeeded();
    const bounds = await bubble.boundingBox();
    await page.mouse.move(bounds.x + 5, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await expect(menu).toBeVisible();
    await page.mouse.up();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    await bubble.focus();
    await bubble.press("Shift+F10");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    await expect(bubble).toBeFocused();
    await bubble.press("ContextMenu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    await expect(bubble).toBeFocused();
    await page.getByRole("button", { name: "外观与语言" }).click();
    const settings = page.locator("#companion-preferences-panel");
    await expect(settings).toBeVisible();
    await settings
      .locator('input[value="dark"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("her.companion.appearance")),
      )
      .toBe("dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(input).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "外观与语言" }).click();
    await expect(settings).toBeVisible();
    await settings
      .locator('input[value="en"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("her.companion.language")),
      )
      .toBe("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await settings
      .locator('input[value="zh"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await settings
      .locator('input[value="system"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await settings
      .locator('input[value="dark"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await page.screenshot({
      path: `.scratch/browser/chat-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Browser acceptance passed at 390px and 1280px: send, completed reply, refresh, stop, explicit pending-send recovery without duplicate execution, external links, anchored right-click/mouse-hold menus, typing motion, theme/language settings, no overflow/errors.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.unref();
  void server.stop(true);
}
