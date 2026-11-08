import { chromium, devices, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtureBackend } from "./fixture.ts";
import { createUiTestHost } from "./ui-test-host.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";

const fixture = fixtureBackend();
const companionName = "Mica 与特别特别长的昵称 Long Companion Name";
const message = (id, text, createdAt) => ({
  id,
  text,
  createdAt: Date.parse(createdAt),
  role: "agent",
  operationId: null,
  turnId: id,
});
const earlier = message("earlier", "更早的消息", "2026-10-30T10:15:00+08:00");
const previous = message("previous", "夜里的消息", "2026-11-07T03:59:00+08:00");
const late = message("late", "凌晨三点", "2026-11-08T03:59:00+08:00");
const fresh = {
  ...message("fresh", "凌晨四点", "2026-11-08T04:00:00+08:00"),
  role: "user",
};
const filler = Array.from({ length: 10 }, (_, index) =>
  message(`filler-${index}`, `连续消息 ${index}`, "2026-11-08T03:59:00+08:00"),
);
const backend = {
  ...fixture.backend,
  async read() {
    return {
      ...(await fixture.backend.read()),
      messages: [late, ...filler, fresh],
      before: "older",
    };
  },
  async history() {
    return { messages: [earlier, previous], before: null };
  },
};
const host = await createUiTestHost(backend);
const channels = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/appearance")
      return Response.json({
        companionName,
        userName: "",
        companionAvatar: "/api/test/avatar.png",
      });
    if (path === "/api/test/avatar.png")
      return staticAssets(resolve("apps/web/build"), "/icons/cfl-192.png");
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    return staticAssets(resolve("apps/web/build"), path);
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
try {
  for (const { locale, width, ios } of [
    { locale: "zh-CN", width: 320 },
    { locale: "en-GB", width: 1280 },
    { locale: "zh-CN", width: 390, ios: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale,
      timezoneId: "Asia/Shanghai",
      ...(ios ? { userAgent: devices["iPhone 13"].userAgent } : {}),
    });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2026-11-07T19:59:30Z"));
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const identity = page.getByTestId("companion-identity");
    await expect(identity).toContainText(companionName);
    await expect(identity.locator("img")).toBeVisible();
    await expect(
      page.locator(
        ".companion-row .companion-avatar-crop, .companion-row .message-avatar",
      ),
    ).toHaveCount(0);
    const header = await identity.evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      chip: el
        .querySelector(".companion-identity-chip")
        .getBoundingClientRect()
        .toJSON(),
      actions: document
        .querySelector(".companion-header-actions")
        .getBoundingClientRect()
        .toJSON(),
      actionsLeft: document
        .querySelector(".companion-header-actions")
        .getBoundingClientRect().left,
      avatar: el.querySelector("img").getBoundingClientRect().toJSON(),
    }));
    expect(header.right).toBeLessThanOrEqual(header.actionsLeft);
    expect(Math.abs(header.avatar.width - header.avatar.height)).toBeLessThan(
      1,
    );
    expect(Math.abs(header.chip.height - header.actions.height)).toBeLessThan(
      1,
    );
    expect(Math.abs(header.chip.top - header.actions.top)).toBeLessThan(1);
    expect(header.avatar.left - header.chip.left).toBeGreaterThanOrEqual(4);
    expect(header.avatar.top - header.chip.top).toBeGreaterThanOrEqual(4);
    expect(header.chip.bottom - header.avatar.bottom).toBeGreaterThanOrEqual(4);
    const composer = page.locator(".companion-composer");
    const composerBox = await composer.boundingBox();
    expect(composerBox.y).toBeGreaterThan(844 / 2);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(844);
    if (ios) {
      for (const selector of [
        ".companion-identity-chip",
        ".companion-header-actions",
        ".companion-composer",
      ]) {
        const glass = page.locator(selector);
        await expect(glass).toHaveClass(/\bk-glass\b/);
        expect(
          await glass.evaluate((el) => getComputedStyle(el).backdropFilter),
        ).not.toBe("none");
      }
    }
    const labels = page.locator('[data-testid^="chat-day-"]');
    const zh = locale.startsWith("zh");
    await expect(labels).toHaveText(
      zh ? ["今天", "11月8日"] : ["Today", "8 November"],
    );
    const geometry = await page
      .getByTestId("chat-day-fresh")
      .evaluate((heading) => {
        const chip = heading.querySelector(".k-chip");
        const row = heading.nextElementSibling;
        const bubble = row?.querySelector(".companion-message-body")
          ?.parentElement?.parentElement;
        const time = row?.querySelector(".companion-message-time");
        const range = document.createRange();
        if (!chip || !row || !bubble || !time)
          throw new Error("missing chat day layout");
        range.selectNodeContents(time);
        return {
          background: getComputedStyle(chip).backgroundColor,
          radius: getComputedStyle(chip).borderRadius,
          gap:
            row.getBoundingClientRect().top -
            heading.getBoundingClientRect().bottom,
          timeRight: range.getBoundingClientRect().right,
          bubbleRight: bubble.getBoundingClientRect().right,
        };
      });
    expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(parseFloat(geometry.radius)).toBeGreaterThan(10);
    expect(geometry.gap).toBeGreaterThanOrEqual(8);
    expect(Math.abs(geometry.timeRight - geometry.bubbleRight)).toBeLessThan(2);
    const edges = await page
      .locator(".companion-row .companion-message-body")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.parentElement.parentElement.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
      );
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.left).toBeGreaterThanOrEqual(12);
      expect(edge.right).toBeLessThanOrEqual(width - 12);
    }
    await expect(page.locator(".companion-message-time")).toHaveCount(12);
    const timeline = page.locator(".companion-timeline");
    await timeline.evaluate((node) => {
      node.scrollTop = 0;
    });
    const anchor = page.getByText("凌晨三点", { exact: true });
    const before = (await anchor.boundingBox()).y;
    await page
      .getByRole("button", {
        name: zh ? "查看更早的消息" : "View earlier messages",
      })
      .click();
    await expect(labels).toHaveText(
      zh
        ? ["10月30日", "昨天", "今天", "11月8日"]
        : ["30 October", "Yesterday", "Today", "8 November"],
    );
    await expect(page.locator(".companion-message-time")).toHaveCount(14);
    const after = (await anchor.boundingBox()).y;
    expect(Math.abs(after - before)).toBeLessThan(3);
    await page.clock.setFixedTime(new Date("2026-11-07T20:00:01Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(labels).toHaveText(
      zh
        ? ["10月30日", "11月6日", "昨天", "今天"]
        : ["30 October", "6 November", "Yesterday", "Today"],
    );
    if (zh && width === 390) {
      await mkdir(".scratch/chat-day", { recursive: true });
      await page.getByTestId("chat-day-fresh").scrollIntoViewIfNeeded();
      await page.screenshot({ path: ".scratch/chat-day/timeline-390.png" });
    }
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Chat day: localized headings, 04:00 boundary, older history and message times passed",
  );
} finally {
  await browser.close();
  for (const channel of channels.values()) channel.close();
  host.close();
  server.stop(true);
}
