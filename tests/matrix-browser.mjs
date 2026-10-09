import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { matrixFixture } from "./matrix-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Native acceptance requires a test-owned control URL");
const fixture = matrixFixture();
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
        if (path === "/__test/matrix-source-ui") {
          const result = await fixture.control(await req.json());
          await host.refresh();
          return Response.json(result);
        }
        if (path === "/__test/matrix-source-ui/disconnect") {
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
  new URL("/__test/matrix-source-ui", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/matrix-source-ui/browser";
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
      const control = async (input) => {
        const response = await context.request.post(controlUrl, {
          data: input,
        });
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const authored = 1791320400000;
      const roomId = "!room:example.test";
      const incoming = (id, extra = {}) =>
        control({
          action: "incoming",
          id,
          senderId: "@alice:example.test",
          senderDisplayName: "Alice",
          roomId,
          text: `${id} 原文\n\n第二段 **灯火**`,
          createdAt: authored,
          ...extra,
        });
      await control({ action: "reset" });
      await incoming("initial");
      await incoming("older", {
        history: true,
        senderDisplayName: "",
        senderId: "@older:example.test",
        createdAt: authored - 3600000,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url);
      const input = page.locator("#companion-textarea");
      const sources = page.locator(".companion-matrix-source");
      const row = (text) =>
        page.locator(".companion-row-matrix").filter({ hasText: text });
      const assertMessage = async (text, name, id, room, time = authored) => {
        const message = row(text);
        await expect(message).toHaveClass(/message-received/);
        await expect(message.locator(".companion-avatar-crop")).toHaveText("M");
        await expect(
          message.getByRole("group", { name: "Matrix", exact: true }),
        ).toBeVisible();
        await expect(message.locator(".companion-matrix-sender")).toHaveText(
          name || id,
        );
        await expect(message.locator(".companion-matrix-room")).toHaveText(
          room,
        );
        if (name)
          await expect(
            message.locator(".companion-matrix-sender-id"),
          ).toHaveText(id);
        else
          await expect(
            message.locator(".companion-matrix-sender-id"),
          ).toHaveCount(0);
        await expect(message.locator("time")).toHaveAttribute(
          "datetime",
          new Date(time).toISOString(),
        );
        await expect(message.locator(".message-text p")).toHaveText([
          text,
          "第二段 灯火",
        ]);
        expect(
          await message
            .locator(".message-bubble")
            .evaluate((el) => getComputedStyle(el).borderInlineStartWidth),
        ).toBe("3px");
      };
      await expect(input).toBeVisible();
      await assertMessage(
        "initial 原文",
        "Alice",
        "@alice:example.test",
        roomId,
      );
      await expect(row("initial 原文").locator("strong")).toHaveText("灯火");
      await page.screenshot({
        path: `${evidence}/matrix-initial-${scheme}-${width}.png`,
      });
      await incoming("fallback", {
        senderDisplayName: "",
        senderId: "@bob:example.test",
      });
      await assertMessage("fallback 原文", "", "@bob:example.test", roomId);
      await page.screenshot({
        path: `${evidence}/matrix-fallback-${scheme}-${width}.png`,
      });
      const hostile = '<img src=x onerror="window.matrixUnsafe=1">';
      const longId = "@" + "😀".repeat(120) + ":test";
      const longRoom = "!" + "灯".repeat(240) + ":test";
      await incoming("hostile", {
        senderDisplayName: hostile,
        senderId: longId,
        roomId: longRoom,
      });
      await assertMessage("hostile 原文", hostile, longId, longRoom);
      await incoming("unicode", {
        senderDisplayName: "😀灯".repeat(80),
        senderId: longId,
      });
      await assertMessage("unicode 原文", "😀灯".repeat(80), longId, roomId);
      for (const label of ["hostile", "unicode"]) {
        await row(`${label} 原文`).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${evidence}/matrix-${label}-${scheme}-${width}.png`,
        });
      }
      await expect(sources.locator("img,script")).toHaveCount(0);
      expect(await page.evaluate(() => window.matrixUnsafe)).toBeUndefined();
      await input.fill("普通网页消息");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await control({ action: "complete" });
      await control({ action: "reminder" });
      await expect(
        page.locator(".companion-row-alarm .companion-alarm-source"),
      ).toBeVisible();
      await expect(
        page.locator(".companion-row").filter({ hasText: "普通网页消息" }),
      ).toHaveClass(/message-sent/);
      await page.reload();
      await expect(sources).toHaveCount(4);
      await assertMessage(
        "initial 原文",
        "Alice",
        "@alice:example.test",
        roomId,
      );
      await input.fill("保留草稿");
      expect(
        (await context.request.post(`${controlUrl}/disconnect`)).ok(),
      ).toBe(true);
      await incoming("reconnect", {
        senderId: "@carol:example.test",
        senderDisplayName: "Carol",
      });
      await expect(sources).toHaveCount(5, { timeout: 10000 });
      await expect(input).toHaveValue("保留草稿");
      await assertMessage(
        "reconnect 原文",
        "Carol",
        "@carol:example.test",
        roomId,
      );
      await page
        .getByRole("button", { name: "查看更早的消息", exact: true })
        .click();
      await expect(sources).toHaveCount(6);
      await assertMessage(
        "older 原文",
        "",
        "@older:example.test",
        roomId,
        authored - 3600000,
      );
      await row("hostile 原文").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await sources.evaluateAll((nodes) =>
          nodes.every(
            (el) =>
              el.scrollWidth <= el.clientWidth + 1 &&
              el.getBoundingClientRect().right <= innerWidth,
          ),
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/matrix-${scheme}-${width}.png`,
        fullPage: true,
      });
      await expect(page.locator(".companion-timeline")).not.toContainText(
        "native-only context sentinel",
      );
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
        backend: external ? "actual-host" : "fixture",
        acceptance: "passed",
        viewports: [320, 390, 1280],
        schemes: ["light", "dark"],
        actualJointAcceptance: "pending Orc",
      },
      null,
      2,
    ),
  );
  console.log(
    "Matrix browser acceptance passed: initial/reload/reconnect/history, exact labels/body/time, Unicode/hostile/fallback, responsive source and ordinary/reminder behavior.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
