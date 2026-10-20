import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { postFixture } from "./post-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Native acceptance requires an owned control URL");
const fixture = postFixture();
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
        const authorized = req.headers
          .get("cookie")
          ?.includes("fixture-owner=1");
        if (path === "/__test/post-source-ui") {
          const result = await fixture.control(await req.json());
          await host.refresh();
          return Response.json(result);
        }
        if (path === "/__test/post-source-ui/disconnect") {
          for (const channel of channels.values()) channel.disconnect();
          return Response.json({ disconnected: true });
        }
        if (path === "/api/chat/media/post-image/original")
          return authorized
            ? new Response(fixtureImage, {
                headers: { "Content-Type": "image/png" },
              })
            : new Response(null, { status: 401 });
        if (path === "/api/chat/socket") {
          if (!authorized) return new Response(null, { status: 401 });
          if (server.upgrade(req)) return;
        }
        return staticAssets(assets, path, {
          "Set-Cookie": "fixture-owner=1; Path=/; SameSite=Strict",
        });
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
  new URL("/__test/post-source-ui", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  ".scratch/post-source-rendering/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280])
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        colorScheme: scheme,
        locale: "zh-CN",
        isMobile: width < 500,
        hasTouch: width < 500,
      });
      await context.addInitScript(denyNativeNotifications);
      const control = async (input) => {
        const response = await context.request.post(controlUrl, {
          data: input,
        });
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const source = {
        kind: "post",
        platform: "qq",
        conversationType: "group",
        conversationId: "12345",
        conversationName: "灯火小组",
        senderId: "67890",
        senderDisplayName: "Alice",
      };
      const authored = 1791320400000;
      const incoming = (id, src = source, extra = {}) =>
        control({
          action: "incoming",
          id,
          source: src,
          text: `${id} 原文\n\n第二段 **灯火**`,
          createdAt: authored,
          ...extra,
        });
      await control({ action: "reset" });
      await incoming("initial");
      const unnamed = {
        kind: "post",
        platform: "qq",
        conversationType: "direct",
        conversationId: "exact-chat-id",
        senderId: "exact-sender-id",
      };
      await incoming("older", unnamed, {
        history: true,
        createdAt: authored - 3600000,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url);
      const input = page.locator("#companion-textarea");
      const row = (id) =>
        page
          .locator(".companion-row-post")
          .filter({ has: page.getByText(`${id} 原文`, { exact: true }) });
      const headers = page.locator(".companion-post-source");
      const assertMessage = async (id, src, time = authored) => {
        const message = row(id);
        await expect(message).toHaveClass(/message-received/);
        await expect(message.locator(".companion-avatar-crop")).toHaveText(
          src.platform === "qq" ? "Q" : "M",
        );
        const header = message.locator(".companion-post-source");
        await expect(header).toHaveCount(1);
        await expect(header.locator(".badge")).toHaveText(
          `${src.platform === "qq" ? "QQ" : "Matrix"} ${src.conversationType === "group" ? "群聊" : "私聊"}`,
        );
        expect(
          await header
            .locator(".badge")
            .evaluate((el) => el.scrollHeight <= el.clientHeight),
        ).toBe(true);
        await expect(header.locator(".companion-post-sender")).toHaveText(
          src.senderDisplayName ?? src.senderId,
        );
        await expect(header.locator(".companion-post-conversation")).toHaveText(
          src.conversationName ?? src.conversationId,
        );
        if (src.senderDisplayName)
          await expect(header).not.toContainText(src.senderId);
        if (src.conversationName)
          await expect(header).not.toContainText(src.conversationId);
        await expect(message.locator(".message-text p")).toHaveText([
          `${id} 原文`,
          "第二段 灯火",
        ]);
        await expect(message.locator("time")).toHaveAttribute(
          "datetime",
          new Date(time).toISOString(),
        );
        expect(
          await message
            .locator(".message-bubble")
            .evaluate((el) => getComputedStyle(el).borderInlineStartWidth),
        ).toBe("3px");
      };
      await expect(input).toBeVisible();
      await page.screenshot({
        path: `${evidence}/initial-${scheme}-${width}.png`,
      });
      await assertMessage("initial", source);
      const direct = {
        ...source,
        conversationType: "direct",
        conversationName: "小明",
        senderDisplayName: "小明",
      };
      await incoming("direct", direct);
      await assertMessage("direct", direct);
      await incoming("fallback", unnamed);
      await assertMessage("fallback", unnamed);
      const matrix = {
        ...source,
        platform: "matrix",
        conversationName: "花园房间",
        senderDisplayName: "Bob",
      };
      await incoming("matrix", matrix);
      await assertMessage("matrix", matrix);
      const hostile = {
        ...source,
        senderDisplayName: '<img src=x onerror="window.postUnsafe=1">',
        conversationName: "<script>unsafe</script>\n" + "😀".repeat(220),
      };
      const image = {
        attachmentId: "post-image",
        mediaType: "image/png",
        name: "original.png",
        availability: "available",
      };
      await incoming("hostile", hostile, { images: [image] });
      // Image is the first body part; the source header occurs only there.
      const imageRow = page.locator(".companion-row-post").filter({
        has: page.locator(".companion-post-source", {
          hasText: hostile.senderDisplayName,
        }),
      });
      await expect(imageRow.locator(".message-image img")).toBeVisible();
      expect(
        await imageRow
          .locator(".message-image img")
          .evaluate((el) => el.naturalWidth),
      ).toBeGreaterThan(0);
      await expect(
        row("hostile").locator(".companion-post-source"),
      ).toHaveCount(0);
      await expect(headers.locator("img,script")).toHaveCount(0);
      expect(await page.evaluate(() => window.postUnsafe)).toBeUndefined();
      const unicode = {
        ...source,
        senderDisplayName: "😀".repeat(256),
        conversationName: "灯火".repeat(128),
      };
      await incoming("unicode", unicode);
      await assertMessage("unicode", unicode);
      for (const [id, src] of [
        ["sender-fallback", { ...direct, senderDisplayName: undefined }],
        ["chat-fallback", { ...matrix, conversationName: undefined }],
      ]) {
        await incoming(id, src);
        await assertMessage(id, src);
      }
      await input.fill("普通网页消息");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await control({ action: "complete" });
      await control({ action: "reminder" });
      await expect(
        page.locator(".companion-row").filter({ hasText: "普通网页消息" }),
      ).toHaveClass(/message-sent/);
      await expect(
        page.locator(".companion-row").filter({ hasText: "普通回复" }),
      ).toHaveClass(/message-received/);
      await expect(page.locator(".companion-alarm-source")).toBeVisible();
      await page.reload();
      await expect(headers).toHaveCount(8);
      await assertMessage("matrix", matrix);
      await input.fill("保留草稿");
      expect(
        (await context.request.post(`${controlUrl}/disconnect`)).ok(),
      ).toBe(true);
      await incoming("reconnect");
      await expect(headers).toHaveCount(9, { timeout: 10000 });
      await expect(input).toHaveValue("保留草稿");
      await page
        .getByRole("button", { name: "查看更早的消息", exact: true })
        .click();
      await expect(headers).toHaveCount(10);
      await assertMessage("older", unnamed, authored - 3600000);
      for (const id of [
        "initial",
        "direct",
        "fallback",
        "matrix",
        "hostile",
        "unicode",
      ]) {
        await row(id).scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await headers.evaluateAll((nodes) =>
            nodes.every(
              (el) =>
                el.scrollWidth <= el.clientWidth + 1 &&
                el.getBoundingClientRect().right <= innerWidth,
            ),
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${evidence}/${id}-${scheme}-${width}.png`,
        });
      }
      expect((await control({ action: "state" })).submissions).toEqual([
        "普通网页消息",
      ]);
      expect(errors).toEqual([]);
      await context.close();
    }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        acceptance: "passed",
        backend: external ? "actual-host" : "owned display fixture",
        viewports: [390, 1280],
        schemes: ["light", "dark"],
        nativeAcceptance:
          "pending CFL receiver/store/public-source/exact-asset verification",
      },
      null,
      2,
    ),
  );
  console.log(
    "Post browser passed: QQ group/direct, Matrix, names/fallback, literal labels, original body/image, reload/reconnect/history, no replay, web/reminder, responsive palettes",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  void server?.stop(true);
}
