import { denyNativeNotifications } from "./notification-permission.mjs";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { keetFixture } from "./keet-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const imageProfile = process.env.APP_ACCEPTANCE_KEET_IMAGE_PROFILE ?? "dm";
if (!["dm", "text-only"].includes(imageProfile))
  throw new Error("APP_ACCEPTANCE_KEET_IMAGE_PROFILE must be dm or text-only");
const fixture = keetFixture(imageProfile);
const dmImage =
  imageProfile === "dm"
    ? {
        images: [
          {
            attachmentId: "keet-image",
            mediaType: "image/png",
            name: "keet-original.png",
            availability: "available",
          },
        ],
      }
    : {};
const host = await createChatHost(fixture.backend, (e) => console.error(e));
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        const authorized =
          req.headers.get("cookie")?.includes("fixture-owner=1") === true;
        if (path === "/__test/keet-source-restoration") {
          const result = await fixture.control(await req.json());
          // Acknowledge only after the shared view has published the owned fixture change.
          await host.refresh();
          return Response.json(result);
        }
        if (path === "/api/chat/media/keet-image/original")
          return authorized && imageProfile === "dm"
            ? new Response(fixtureImage, {
                headers: { "Content-Type": "image/png" },
              })
            : new Response(null, { status: 401 });
        if (path === "/api/chat/socket") {
          if (!authorized) return new Response(null, { status: 401 });
          if (server.upgrade(req)) return;
        }
        if (path === "/__test/keet-source-restoration/disconnect") {
          for (const channel of channels.values()) channel.disconnect();
          return Response.json({ disconnected: true });
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
  new URL("/__test/keet-source-restoration", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  ".scratch/keet-source-restoration/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280, 320])
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        locale: "zh-CN",
        colorScheme: scheme,
      });
      const control = async (input) => {
        const response = await context.request.post(controlUrl, {
          data: input,
        });
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const incoming = (id, channel, extra = {}) =>
        control({
          action: "incoming",
          id,
          channel,
          senderLabel: "Alice",
          destination: channel === "dm" ? "Peer" : "Room",
          text: `${id} 原文 **灯火** <script>window.keetUnsafe=1</script>`,
          ...extra,
        });
      await control({ action: "reset" });
      // Already persisted native input is read on first open; hidden context never enters this DTO.
      const initial = await incoming("initial-dm", "dm", {
        hasImage: true,
        ...dmImage,
      });
      const olderGroup = await incoming("older-group", "group", {
        history: true,
        text: "历史群组原文",
        hasImage: true,
      });
      const olderDm = await incoming("older-dm", "dm", {
        history: true,
        text: "历史私聊原文",
        hasImage: true,
        ...dmImage,
      });
      const assertImageContent = async (row, original, result, available) => {
        const body = available
          ? row.locator("xpath=following-sibling::*[1]")
          : row;
        await expect(body).toContainText(original);
        await expect(body).toHaveClass(/companion-row-keet/);
        await expect(body).toHaveClass(/message-received/);
        if (available) {
          await expect(row.locator("img").first()).toBeVisible();
          await expect
            .poll(() =>
              row
                .locator("img")
                .first()
                .evaluate((img) => img.naturalWidth),
            )
            .toBeGreaterThan(0);
        } else {
          expect(typeof result.imageNote).toBe("string");
          expect(result.imageNote.trim().length).toBeGreaterThan(0);
          await expect(row).toContainText(result.imageNote);
          await expect(row.locator("img")).toHaveCount(0);
        }
      };
      await context.addInitScript(denyNativeNotifications);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url);
      const input = page.locator("#companion-textarea");
      const send = page.getByRole("button", { name: "发送消息", exact: true });
      const sources = page.locator(".companion-keet-source");
      const dm = page
        .locator(".companion-row")
        .filter({ has: sources.filter({ hasText: "Keet DM" }) });
      const group = page
        .locator(".companion-row")
        .filter({ has: sources.filter({ hasText: "Keet Group" }) });
      const dmBody =
        imageProfile === "dm"
          ? dm.locator("xpath=following-sibling::*[1]")
          : dm;
      await expect(input).toBeVisible();
      await expect(dm).toHaveClass(/message-received/);
      await expect(dm.locator(".companion-avatar-crop")).toHaveText("K");
      await expect(dm.locator(".companion-keet-source")).toHaveText(
        "Keet DMAlice · Peer",
      );
      await expect(dmBody.locator("strong")).toHaveText("灯火");
      await expect(page.locator(".companion-row script")).toHaveCount(0);
      expect(await page.evaluate(() => window.keetUnsafe)).toBeUndefined();
      await assertImageContent(
        dm,
        "initial-dm 原文",
        initial,
        imageProfile === "dm",
      );
      // A real composer send and complete reply retain their existing direction/style.
      await input.fill("普通网页消息");
      await send.click();
      await expect(input).toHaveValue("");
      const web = page
        .locator(".companion-row")
        .filter({ hasText: "普通网页消息" });
      await expect(web).toHaveClass(/message-sent/);
      expect((await control({ action: "state" })).submissions).toEqual([
        "普通网页消息",
      ]);
      await control({ action: "complete" });
      const agent = page
        .locator(".companion-row")
        .filter({ hasText: "普通回复" });
      await expect(agent).toHaveClass(/message-received/);
      await control({ action: "reminder" });
      const reminder = page.locator(".companion-row-alarm");
      await expect(reminder).toHaveClass(/message-received/);
      await expect(reminder.locator(".companion-alarm-source")).toBeVisible();
      await expect(reminder.locator(".companion-keet-source")).toHaveCount(0);
      // Preserve hostile labels as literal text and image-bearing original content.
      const liveGroup = await incoming("live-group", "group", {
        senderLabel: '<img src=x onerror="window.keetUnsafe=2">',
        destination: "房间" + "很长的名字".repeat(40),
        hasImage: true,
        text: "图片原文与可见说明",
      });
      await expect(group.locator(".companion-keet-source")).toContainText(
        '<img src=x onerror="window.keetUnsafe=2">',
      );
      await expect(sources.locator("img")).toHaveCount(0);
      await expect(group.locator(".companion-avatar-crop")).toHaveText("K");
      await assertImageContent(group, "图片原文与可见说明", liveGroup, false);
      await expect(
        page
          .locator(".companion-row-keet")
          .filter({ hasText: "图片原文与可见说明" }),
      ).toHaveClass(/message-received/);
      const style = (locator) =>
        locator
          .locator(".message-bubble")
          .first()
          .evaluate((el) => {
            const css = getComputedStyle(el);
            return {
              background: css.backgroundColor,
              border: css.borderInlineStartWidth,
              accent: css.borderInlineStartColor,
              color: css.color,
            };
          });
      const keetStyle = await style(dm);
      const normalStyle = await style(agent);
      expect(keetStyle.border).toBe("3px");
      expect(keetStyle.background).not.toBe(normalStyle.background);
      expect(keetStyle.color).toBe(normalStyle.color);
      for (const ordinary of [web, agent, reminder])
        expect((await style(ordinary)).border).toBe("0px");
      expect(await dm.evaluate((el) => getComputedStyle(el).direction)).toBe(
        "ltr",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await sources.evaluateAll((nodes) =>
          nodes.every((el) => el.getBoundingClientRect().right <= innerWidth),
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${evidence}/sources-${scheme}-${width}.png`,
        fullPage: true,
      });
      // Reload and reconnect preserve original bodies and provenance without re-submitting.
      await page.reload();
      await expect(sources).toHaveCount(2);
      await assertImageContent(group, "图片原文与可见说明", liveGroup, false);
      await assertImageContent(
        dm,
        "initial-dm 原文",
        initial,
        imageProfile === "dm",
      );
      await expect(dmBody.locator("strong")).toHaveText("灯火");
      await input.fill("保留草稿");
      const disconnected = await context.request.post(
        `${controlUrl}/disconnect`,
      );
      expect(disconnected.ok()).toBe(true);
      await incoming("reconnected-dm", "dm", {
        senderLabel: "Bob",
        text: "重连原文",
      });
      await expect(sources).toHaveCount(3, { timeout: 10000 });
      await expect(input).toHaveValue("保留草稿");
      await expect(
        page.locator(".companion-row-keet").filter({ hasText: "重连原文" }),
      ).toHaveClass(/message-received/);
      await page
        .getByRole("button", { name: "查看更早的消息", exact: true })
        .click();
      await expect(sources).toHaveCount(5);
      const historyRow = (text) =>
        page.locator(".companion-row-keet").filter({ hasText: text });
      const historySource = (text, available) =>
        available
          ? historyRow(text).locator("xpath=preceding-sibling::*[1]")
          : historyRow(text);
      for (const [text, label] of [
        ["历史群组原文", "Keet GroupAlice · Room"],
        ["历史私聊原文", "Keet DMAlice · Peer"],
      ]) {
        await expect(
          historySource(
            text,
            text === "历史私聊原文" && imageProfile === "dm",
          ).locator(".companion-keet-source"),
        ).toHaveText(label);
        await expect(
          historyRow(text).locator(".companion-avatar-crop"),
        ).toHaveText("K");
        await expect(historyRow(text)).toHaveClass(/message-received/);
      }
      await assertImageContent(
        historyRow("历史群组原文"),
        "历史群组原文",
        olderGroup,
        false,
      );
      await assertImageContent(
        historySource("历史私聊原文", imageProfile === "dm"),
        "历史私聊原文",
        olderDm,
        imageProfile === "dm",
      );
      await page.reload();
      await expect(sources).toHaveCount(3);
      await page
        .getByRole("button", { name: "查看更早的消息", exact: true })
        .click();
      await expect(sources).toHaveCount(5);
      await assertImageContent(
        historyRow("历史群组原文"),
        "历史群组原文",
        olderGroup,
        false,
      );
      await assertImageContent(
        historySource("历史私聊原文", imageProfile === "dm"),
        "历史私聊原文",
        olderDm,
        imageProfile === "dm",
      );
      await expect(page.locator(".companion-timeline")).not.toContainText(
        "native-only context sentinel",
      );
      await expect(
        page.locator(".companion-row-keet").filter({ hasText: "历史群组原文" }),
      ).toHaveClass(/message-received/);
      expect((await control({ action: "state" })).submissions).toEqual([
        "普通网页消息",
      ]);
      expect(await page.evaluate(() => window.keetUnsafe)).toBeUndefined();
      expect(errors).toEqual([]);
      await context.close();
    }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        backend: external ? "actual-host" : "fixture",
        viewports: [390, 1280, 320],
        schemes: ["light", "dark"],
        acceptance: "passed",
        imageProfile,
        keetImageByteCoverage:
          imageProfile === "dm"
            ? "DM decode/reload/history"
            : "none; native explanations only",
        actualJointAcceptance: "pending Orc",
      },
      null,
      2,
    ),
  );
  console.log(
    "Keet browser acceptance passed: incoming DM/group, safe original text/labels/native explanations and profile-specific DM images, light/dark emphasis, composer/regressions, reload/reconnect/history.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
