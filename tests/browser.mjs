import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const fixture = fixtureBackend();
let delayedInput;
const backend = {
  ...fixture.backend,
  async read() {
    const view = await fixture.backend.read();
    return delayedInput
      ? {
          ...view,
          messages: view.messages.filter(
            (m) => m.operationId !== delayedInput.operationId,
          ),
          recovery: [
            {
              sourceId: delayedInput.operationId,
              operationId: delayedInput.operationId,
              text: delayedInput.text,
              images: [],
              state: "uncertain",
              replacementEligible: false,
            },
          ],
        }
      : view;
  },
  async submit(input) {
    if (!input.text.startsWith("hello-")) return fixture.backend.submit(input);
    delayedInput = input;
    await host.refresh();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const receipt = await fixture.backend.submit(input);
    setTimeout(() => {
      if (delayedInput?.operationId === input.operationId)
        delayedInput = undefined;
      void host.refresh();
    }, 1000);
    return receipt;
  },
};
const host = await createChatHost(external ? fixture.backend : backend);
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__test/text") {
          const input = await req.json();
          if (input.action === "reset") fixture.reset();
          if (input.action === "complete") await fixture.complete(input.text);
          return Response.json({
            executions: fixture.executions,
            sessionId: (await fixture.backend.read()).sessionId,
          });
        }
        if (path === "/api/chat/appearance")
          return Response.json({
            companionName: "Mica Display",
            userName: "Neil Display",
            companionAvatar: "/api/test/companion.png",
            userAvatar: "/api/test/user.png",
            backgrounds: {
              landscape: "/api/test/wide.png",
              portrait: "/api/test/tall.png",
            },
          });
        if (path.startsWith("/api/test/") && path.endsWith(".png"))
          return new Response(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
              "base64",
            ),
            { headers: { "content-type": "image/png" } },
          );
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
const linkedPage = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("External page"),
});
const linkUrl = `http://127.0.0.1:${linkedPage.port}/lamplit`;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const url = external ?? `http://127.0.0.1:${server.port}/`;
const controlUrl =
  process.env.APP_ACCEPTANCE_CONTROL_URL ?? new URL("/__test/text", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  ".scratch/default-shared-frontend/text";
await mkdir(evidence, { recursive: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
      httpCredentials: process.env.APP_ACCEPTANCE_USERNAME
        ? {
            username: process.env.APP_ACCEPTANCE_USERNAME,
            password: process.env.APP_ACCEPTANCE_PASSWORD ?? "",
          }
        : undefined,
    });
    const control = async (input) => {
      const response = await context.request.post(controlUrl, { data: input });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const initial = await control({ action: "reset" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    // Validate deployed URLs from the rendered document, not source text.
    const assetPaths = await page
      .locator("script[src], link[href]")
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => node.getAttribute("src") ?? node.getAttribute("href"),
        ),
      );
    for (const path of assetPaths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("/slice/")).toBe(false);
      expect((await context.request.get(new URL(path, url).href)).ok()).toBe(
        true,
      );
    }
    if (!external) {
      const manifest = await context.request.get(
        new URL("/manifest.webmanifest", url).href,
      );
      const pwa = await manifest.json();
      expect([pwa.id, pwa.start_url, pwa.scope]).toEqual(["/", "/", "/"]);
      for (const icon of pwa.icons)
        expect(
          (await context.request.get(new URL(icon.src, url).href)).ok(),
        ).toBe(true);
      const root = await context.request.get(new URL("/", url).href);
      const hosted = await context.request.get(new URL("/chat", url).href);
      expect(await hosted.body()).toEqual(await root.body());
      for (const obsolete of [
        "/slice",
        "/slice/",
        "/slice/manifest.webmanifest",
        "/management",
        "/missing.js",
      ])
        expect(
          (await context.request.get(new URL(obsolete, url).href)).status(),
        ).toBe(404);
    }
    const input = page.locator("#companion-textarea");
    await expect(input).toBeVisible();
    if (!external) {
      await expect(page.locator(".companion-name")).toHaveText("Mica Display");
      await expect(page.locator(".companion-avatar img")).toHaveAttribute(
        "src",
        "/api/test/companion.png",
      );
      await expect(page.locator(".companion-chat-background img")).toHaveCount(
        2,
      );
      for (const image of await page
        .locator(".companion-avatar img, .companion-chat-background img")
        .all())
        await expect
          .poll(() =>
            image.evaluate((img) => img.complete && img.naturalWidth > 0),
          )
          .toBe(true);
      await page
        .getByRole("button", { name: "查看 Companion 关系资料", exact: true })
        .click();
      await expect(
        page.locator(".companion-history-controls button"),
      ).toHaveCount(1);
      await page.locator(".companion-history-controls button").click();
    }
    await input.fill(`hello-${width}`);
    if (!external)
      await page.evaluate(() => {
        window.recoveryFlashed = false;
        window.recoveryObserver = new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes)
              if (
                node instanceof Element &&
                (node.matches('[data-testid="input-recovery"]') ||
                  node.querySelector('[data-testid="input-recovery"]'))
              )
                window.recoveryFlashed = true;
        });
        window.recoveryObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      });
    await input.press("Enter");
    if (!external)
      await expect(
        page.getByText(`hello-${width}`, { exact: true }),
      ).toBeVisible({ timeout: 500 });
    await expect(
      page.getByText(`hello-${width}`, { exact: true }),
    ).toBeVisible();
    if (!external) {
      const avatar = page.locator(".message-sent .message-avatar img").first();
      await expect(avatar).toHaveAttribute("src", "/api/test/user.png");
      await expect
        .poll(() =>
          avatar.evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
    }
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
    await control({ action: "complete", text: reply });
    await context.setOffline(false);
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByText("回复完成", { exact: true })).toHaveCount(0);
    await expect(
      page.locator('[data-testid="companion-typing-indicator"]'),
    ).toHaveCount(0);
    if (!external) {
      expect(
        await page.evaluate(() => {
          window.recoveryObserver.disconnect();
          return window.recoveryFlashed;
        }),
      ).toBe(false);
      await expect(
        page.getByText(`hello-${width}`, { exact: true }),
      ).toBeVisible();
    }
    await page.reload();
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByText("回复完成", { exact: true })).toHaveCount(0);
    await expect(
      page.locator('[data-testid="companion-typing-indicator"]'),
    ).toHaveCount(0);
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
    const beforeRecovery = (await control({ action: "state" })).executions;
    await page.evaluate(
      ({ operationId, text, sessionId }) => {
        localStorage.setItem(
          `lamplit.pending:${sessionId}`,
          JSON.stringify([
            { operationId, text, createdAt: Date.now(), state: "uncertain" },
          ]),
        );
      },
      { operationId, text: recoveryText, sessionId: initial.sessionId },
    );
    await page.reload();
    await expect(page.getByText(recoveryText, { exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: "重试未发送消息" });
    await expect(retry).toBeVisible();
    expect((await control({ action: "state" })).executions).toBe(
      beforeRecovery,
    );
    await retry.click();
    await expect
      .poll(async () => (await control({ action: "state" })).executions)
      .toBe(beforeRecovery + 1);
    await expect(retry).toHaveCount(0);
    await page.reload();
    expect((await control({ action: "state" })).executions).toBe(
      beforeRecovery + 1,
    );
    await control({ action: "complete", text: `recovered reply ${width}` });
    await expect(
      page.getByText(`recovered reply ${width}`, { exact: true }),
    ).toBeVisible();
    // Imported CFL interactions must work through the shared completed-message controller.
    await input.fill(`link-${width}`);
    await input.press("Enter");
    await control({
      action: "complete",
      text: `[external-${width}](${linkUrl})`,
    });
    const link = page.getByRole("link", {
      name: `external-${width}`,
      exact: true,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(linkUrl);
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
    if (!external) {
      await page.goto(new URL("/chat", url).href);
      await expect(input).toBeVisible();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(/dark/);
    }
    await page.screenshot({
      path: `${evidence}/chat-${width}.png`,
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
  linkedPage.stop(true);
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
