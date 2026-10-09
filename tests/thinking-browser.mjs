import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { thinkingFixture } from "./thinking-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Native acceptance requires a test-owned control URL");
const fixture = thinkingFixture();
const host = await createChatHost(fixture.backend, console.error);
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__test/collapsed-thinking") {
          const result = fixture.control(await req.json());
          await host.refresh();
          return Response.json(result);
        }
        if (path === "/__test/collapsed-thinking/disconnect") {
          for (const channel of channels.values()) channel.disconnect();
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
const url = external ?? `http://127.0.0.1:${server.port}/`;
const controlUrl =
  process.env.APP_ACCEPTANCE_CONTROL_URL ??
  new URL("/__test/collapsed-thinking", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/collapsed-thinking/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [320, 390, 1280])
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        colorScheme: scheme,
        locale: "zh-CN",
        isMobile: width < 500,
        hasTouch: width < 500,
      });
      await context.addInitScript(denyNativeNotifications);
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text) => {
              window.fixtureCopied = text;
            },
          },
        });
      });
      const control = async (data) => {
        const r = await context.request.post(controlUrl, { data });
        expect(r.ok()).toBe(true);
        return r.json();
      };
      const message = (id, text, extra = {}, history = false) =>
        control({
          action: "message",
          history,
          message: {
            id,
            role: "agent",
            text,
            createdAt: 1791320400000,
            operationId: null,
            turnId: null,
            ...extra,
          },
        });
      await control({ action: "reset" });
      await message("answer", "独立答案 **灯火**", {
        thinking:
          "思考第一段\n\n思考第二段 **顺序** <script>window.thinkingUnsafe=1</script>",
      });
      await message("absent", "没有思考的答案");
      await message("empty", "空思考答案", { thinking: "" });
      await message("user", "用户正文", {
        role: "user",
        thinking: "错误角色思考",
      });
      await message("only", "", { thinking: "仅思考，保持原来的空记录处理" });
      await message("failure", "回复失败", { role: "notice" });
      await message("older", "历史答案", { thinking: "历史思考" }, true);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(url);
      const details = page.locator(".companion-thinking");
      const summary = details.locator("summary");
      await expect(details).toHaveCount(1);
      await expect(summary).toHaveText("不许你看的小想法");
      await expect(details.first()).not.toHaveAttribute("open", "");
      await expect(details.locator(".markdown")).toBeHidden();
      const failures = page
        .locator(".companion-notice")
        .filter({ hasText: /^回复失败$/ });
      await expect(failures).toHaveCount(2);
      for (let index = 0; index < 2; index++)
        await expect(failures.nth(index)).toBeVisible();
      await expect(
        page
          .locator(".companion-row")
          .filter({ hasText: "仅思考，保持原来的空记录处理" }),
      ).toHaveCount(0);
      await expect(
        details.filter({ hasText: "仅思考，保持原来的空记录处理" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `${evidence}/collapsed-${scheme}-${width}.png`,
        fullPage: true,
      });
      await summary.focus();
      await summary.press("Enter");
      await expect(details.first()).toHaveAttribute("open", "");
      await expect(details.locator("strong")).toHaveText("顺序");
      expect(await details.innerText()).toContain("思考第一段");
      expect(
        await summary.evaluate((el) => el.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: `${evidence}/expanded-${scheme}-${width}.png`,
        fullPage: true,
      });
      // Copy via the existing answer context menu; the disclosure has no copy action.
      const answer = page
        .locator(".companion-text-bubble")
        .filter({ hasText: "独立答案" });
      await answer.click({ button: "right" });
      await page.getByRole("button", { name: "复制消息", exact: true }).click();
      expect(await page.evaluate(() => window.fixtureCopied)).toBe(
        "独立答案 **灯火**",
      );
      await expect(page.locator(".companion-action-menu")).toBeHidden();
      await summary.press("Space");
      await expect(details.first()).not.toHaveAttribute("open", "");
      await summary.click();
      await page.reload();
      await expect(details).toHaveCount(1);
      await expect(details.first()).not.toHaveAttribute("open", "");
      await page
        .getByRole("button", { name: "查看更早的消息", exact: true })
        .click();
      await expect(details).toHaveCount(2);
      await expect(details.first()).not.toHaveAttribute("open", "");
      const input = page.locator("#companion-textarea");
      await input.fill("保留草稿");
      expect(
        (await context.request.post(`${controlUrl}/disconnect`)).ok(),
      ).toBe(true);
      await message("reconnect", "重连答案", { thinking: "重连思考" });
      await expect(details).toHaveCount(3, { timeout: 15000 });
      await expect(details.last()).not.toHaveAttribute("open", "");
      await expect(input).toHaveValue("保留草稿");
      await message("grouped", "图文答案", {
        thinking: "分组只出现一次",
        images: [
          {
            attachmentId: "missing-image",
            mediaType: "image/png",
            name: "不可用图片",
            availability: "missing",
          },
        ],
      });
      await expect(details).toHaveCount(4);
      await expect(
        page
          .locator(".companion-thinking")
          .filter({ hasText: "分组只出现一次" }),
      ).toHaveCount(1);
      await message("long", "长思考答案", {
        thinking: ("长思考 **内容**\n\n" + "x".repeat(250) + "\n\n").repeat(30),
      });
      await expect(details).toHaveCount(5);
      await details.last().locator("summary").click();
      await expect(details.last().locator(".markdown")).toBeVisible();
      expect(
        await details.last().evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.overflowY, el.scrollHeight > 844];
        }),
      ).toEqual(["visible", true]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/long-${scheme}-${width}.png`,
      });
      expect(await page.evaluate(() => window.thinkingUnsafe)).toBeUndefined();
      expect(errors).toEqual([]);
      await context.close();
    }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        backend: external ? "native-host" : "fixture",
        widths: [320, 390, 1280],
        schemes: ["light", "dark"],
        acceptance: "passed",
        jointAcceptance: "pending Orc",
      },
      null,
      2,
    ),
  );
  console.log("Collapsed thinking browser acceptance passed");
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.stop(true);
}
