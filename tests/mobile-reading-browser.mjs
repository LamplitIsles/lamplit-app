import { chromium, expect, devices } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { thinkingFixture } from "./thinking-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

if (process.env.APP_ACCEPTANCE_URL || process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("This runner supports only the isolated App fixture");
const fixture = thinkingFixture();
const host = await createChatHost(fixture.backend, console.error);
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/__test/mobile-reading-layout") {
      const result = fixture.control(await req.json());
      await host.refresh();
      return Response.json(result);
    }
    if (path === "/__test/mobile-reading-layout/disconnect") {
      for (const channel of channels.values()) channel.disconnect();
      return Response.json({ disconnected: true });
    }
    if (path === "/api/chat/appearance")
      return Response.json({
        companionName: "Mica",
        userName: "You",
        companionAvatar: "/api/test/avatar.png",
        userAvatar: "/api/test/avatar.png",
      });
    if (path === "/api/test/avatar.png")
      return staticAssets(assets, "/icons/cfl-192.png");
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
const url = `http://127.0.0.1:${server.port}/`;
const controlUrl = new URL("/__test/mobile-reading-layout", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  `.scratch/mobile-reading-layout/browser-${Date.now()}`;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const theme of ["md", "ios"])
    for (const width of [320, 390, 1280])
      for (const scheme of ["light", "dark"]) {
        const context = await browser.newContext({
          ...(theme === "ios"
            ? { userAgent: devices["iPhone 13"].userAgent }
            : {}),
          viewport: { width, height: 844 },
          colorScheme: scheme,
          locale: "zh-CN",
          isMobile: width < 500,
          hasTouch: width < 500,
        });
        await context.addInitScript(denyNativeNotifications);
        await context.addInitScript(() =>
          Object.defineProperty(navigator, "clipboard", {
            value: {
              writeText: async (text) => {
                window.fixtureCopied = text;
              },
            },
          }),
        );
        const control = async (data) => {
          const r = await context.request.post(controlUrl, { data });
          expect(r.ok()).toBe(true);
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
        const reminder = {
          role: "user",
          source: { kind: "reminder", reminderId: "once" },
        };
        const long = "提醒：阅读完整正文，保留原始内容与时间。".repeat(40);
        const code = "const original = '" + "x".repeat(500) + "';";
        await control({ action: "reset" });
        await message(
          "code",
          "```js\n" +
            code +
            "\n```\n\n| " +
            Array(40).fill("column").join(" | ") +
            " |\n| " +
            Array(40).fill("---").join(" | ") +
            " |\n| " +
            Array(40).fill("value").join(" | ") +
            " |",
          { thinking: "思考\n\n```\n" + code + "\n```" },
        );
        await message("long", long);
        await message("short", "好");
        await message("outgoing", long, { role: "user" });
        await message("reminder", long, reminder);
        await message("reminder2", long, reminder);
        await message("short-reminder", "短提醒", reminder);
        await message("empty-reminder", "", reminder);
        await message(
          "resize-reminder",
          "提醒内容随着窗口宽度变化，短屏幕需要展开，桌面不必展开。".repeat(2),
          reminder,
        );
        await message(
          "sources",
          "https://example.test/" +
            "path".repeat(100) +
            " `" +
            "inline".repeat(100) +
            "`",
          {
            role: "user",
            source: {
              kind: "keet",
              channel: "dm",
              senderLabel: "Sender",
              destination: "Chat",
            },
          },
        );
        await message("matrix", "Matrix正文 " + long, {
          role: "user",
          source: {
            kind: "matrix",
            senderId: "@sender:test",
            senderDisplayName: "Sender",
            roomId: "!room:test",
          },
        });
        await message("image", "![图片](/icons/cfl-192.png)");
        await message("ordinary", "应用提醒 " + long, { role: "user" });
        await message("older", "更早消息", {}, true);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(url);
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`\\b${theme}\\b`),
        );
        const row = (id) => page.getByTestId(`message-${id}`);
        const pre = row("code").locator(".companion-text-bubble pre");
        await expect(pre).toBeVisible();
        await pre.scrollIntoViewIfNeeded();
        const geometry = await pre.evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
          viewport: innerWidth,
          touch: getComputedStyle(el.closest(".companion-text-bubble"))
            .touchAction,
        }));
        console.log({ theme, width, scheme, geometry });
        await page.screenshot({
          path: `${evidence}/code-${theme}-${scheme}-${width}.png`,
        });
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.scroll).toBeGreaterThan(geometry.client);
        await expect(pre.locator("code")).toHaveText(code);
        const cdp = await context.newCDPSession(page);
        const pan = async (target, dx, dy) => {
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();
          const x = box.x + box.width * 0.75,
            y = box.y + Math.min(box.height / 2, 60);
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          for (let i = 1; i <= 10; i++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }],
            });
            await page.waitForTimeout(20);
          }
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        };
        // Code and table now occupy independent display rows from one source.
        for (const target of [
          pre,
          page.locator(".companion-text-bubble table"),
        ]) {
          expect(
            await target.evaluate((el) => el.scrollWidth > el.clientWidth),
            "local scroll extent",
          ).toBe(true);
          if (width < 500) await pan(target, -100, 0);
          else
            await target.evaluate((el) => {
              el.scrollLeft = 100;
            });
          await expect
            .poll(() => target.evaluate((el) => el.scrollLeft))
            .toBeGreaterThan(20);
        }
        const timeline = page.locator(".companion-timeline");
        await pre.scrollIntoViewIfNeeded();
        const top = await timeline.evaluate((el) => el.scrollTop);
        if (width < 500) {
          await pan(pre, 0, -100);
          await expect
            .poll(() => timeline.evaluate((el) => el.scrollTop))
            .toBeGreaterThan(top + 20);
        }
        const measure = async (id) =>
          row(id).evaluate((el) => {
            const avatar = el
                .querySelector(".message-avatar")
                .getBoundingClientRect(),
              bubble = el
                .querySelector(".message-bubble")
                .getBoundingClientRect();
            return {
              avatarLeft: avatar.left,
              avatarRight: avatar.right,
              avatarWidth: avatar.width,
              bubbleLeft: bubble.left,
              bubbleRight: bubble.right,
              bubbleWidth: bubble.width,
            };
          });
        for (const id of ["long", "outgoing"])
          await expect(row(id).locator(".message-avatar img")).toBeVisible();
        const bounds = await measure("long"),
          outgoing = await measure("outgoing");
        const gap = outgoing.avatarLeft - outgoing.bubbleRight;
        console.log({ theme, width, scheme, bounds, outgoing, gap });
        expect(bounds.avatarWidth).toBeGreaterThan(0);
        expect(bounds.avatarRight).toBeLessThanOrEqual(bounds.bubbleLeft);
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(bounds.bubbleRight).toBeLessThanOrEqual(
          outgoing.bubbleRight + 2,
        );
        if (width < 500) {
          expect(
            Math.abs(bounds.bubbleRight - outgoing.bubbleRight),
          ).toBeLessThanOrEqual(2);
          expect(
            Math.abs(
              outgoing.avatarRight -
                bounds.bubbleRight -
                (outgoing.avatarWidth + gap),
            ),
          ).toBeLessThanOrEqual(2);
        } else expect(bounds.bubbleWidth).toBeLessThan(800);
        await row("long").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${evidence}/alignment-${theme}-${scheme}-${width}.png`,
        });
        expect(
          (await row("short").locator(".message-bubble").boundingBox()).width,
        ).toBeLessThan(bounds.bubbleWidth / 2);
        const body = row("reminder").locator(".companion-reminder-body");
        const toggle = row("reminder").getByRole("button", {
          name: "展开",
          exact: true,
        });
        await expect(toggle).toBeVisible();
        expect(
          await body.evaluate(
            (el) =>
              el.clientHeight <=
              parseFloat(getComputedStyle(el).lineHeight) * 2 + 1,
          ),
        ).toBe(true);
        await expect(row("short-reminder").locator("button")).toHaveCount(0);
        await expect(row("empty-reminder")).toHaveCount(0);
        for (const id of ["sources", "matrix"])
          await expect(row(id).locator(".companion-reminder-body")).toHaveCount(
            0,
          );
        await expect(row("image").locator("img[alt=图片]")).toBeVisible();
        await expect(
          row("ordinary").locator(".companion-reminder-body"),
        ).toHaveCount(0);
        await expect(
          row("long").locator(".companion-reminder-body"),
        ).toHaveCount(0);
        await expect(
          row("reminder").locator(".companion-alarm-source"),
        ).toHaveText("应用提醒");
        await expect(row("reminder").locator("time")).toHaveCount(1);
        await row("reminder").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${evidence}/collapsed-${theme}-${scheme}-${width}.png`,
        });
        await row("reminder")
          .locator(".companion-text-bubble")
          .click({ button: "right" });
        const copy = page.getByRole("button", {
          name: "复制消息",
          exact: true,
        });
        await expect(copy).toBeFocused();
        if (width < 500) await copy.tap();
        else await copy.click();
        await expect
          .poll(() => page.evaluate(() => window.fixtureCopied))
          .toBe(long);
        await page.keyboard.press("Tab");
        await toggle.focus();
        expect(
          await toggle.evaluate((el) => getComputedStyle(el).outlineStyle),
        ).toBe("solid");
        expect(
          await toggle.evaluate((el) => el.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(44);
        await toggle.press("Enter");
        const collapse = row("reminder").getByRole("button", {
          name: "收起",
          exact: true,
        });
        await expect(collapse).toHaveAttribute("aria-expanded", "true");
        expect(
          await body.evaluate(
            (el) =>
              el.clientHeight > parseFloat(getComputedStyle(el).lineHeight) * 2,
          ),
        ).toBe(true);
        await expect(
          row("reminder2").getByRole("button", { name: "展开", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".companion-action-menu")).toBeHidden();
        await page.screenshot({
          path: `${evidence}/expanded-${theme}-${scheme}-${width}.png`,
        });
        await collapse.press("Space");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        if (theme === "md" && width === 320 && scheme === "light") {
          await toggle.scrollIntoViewIfNeeded();
          const box = await toggle.boundingBox();
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [
              { x: box.x + box.width / 2, y: box.y + box.height / 2 },
            ],
          });
          await page.waitForTimeout(550);
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          await expect(page.locator(".companion-action-menu")).toBeHidden();
        }
        if (width < 500) await toggle.tap();
        else await toggle.click();
        // Same stable ID with refreshed DTO objects, then paging and reconnect.
        await message("reminder", long, reminder);
        const earlier = page.getByRole("button", {
          name: "查看更早的消息",
          exact: true,
        });
        if (width < 500) await earlier.tap();
        else await earlier.click();
        await expect(row("older")).toHaveCount(1);
        await expect(collapse).toBeVisible();
        await page.locator("#companion-textarea").fill("保留草稿");
        await context.request.post(`${controlUrl}/disconnect`);
        await message("reconnected", "重连标记");
        await expect(row("reconnected")).toHaveCount(1, { timeout: 15000 });
        await expect(page.getByText("在线· 愉快", { exact: true })).toBeVisible(
          {
            timeout: 15000,
          },
        );
        await expect(collapse).toBeVisible();
        await expect(page.locator("#companion-textarea")).toHaveValue(
          "保留草稿",
        );
        await page.setViewportSize({ width: 1280, height: 844 });
        await expect(row("resize-reminder").locator("button")).toHaveCount(0);
        await page.setViewportSize({ width: 320, height: 844 });
        await expect(
          row("resize-reminder").getByRole("button", {
            name: "展开",
            exact: true,
          }),
        ).toBeVisible();
        await expect(collapse).toBeVisible();
        await page.setViewportSize({ width, height: 844 });
        await row("code").locator("summary").click();
        const thinkingPre = row("code").locator(".companion-thinking pre");
        await expect(thinkingPre).toBeVisible();
        expect(
          await thinkingPre.evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(true);
        // Inspect every relevant outer box, not just document.scrollWidth (the page already clips).
        expect(
          await page
            .locator(
              ".companion-row, .message-bubble, .companion-timeline, .markdown",
            )
            .evaluateAll((els) =>
              els.every((el) => {
                const r = el.getBoundingClientRect();
                return r.left >= -1 && r.right <= innerWidth + 1;
              }),
            ),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.reload();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(errors).toEqual([]);
        await context.close();
      }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        acceptance: "passed",
        jointAcceptance: "unverified",
        physicalDevices: "unverified",
        themes: ["md", "ios"],
        widths: [320, 390, 1280],
        schemes: ["light", "dark"],
        touch:
          "Chromium CDP touch events, horizontal code/table and vertical timeline",
      },
      null,
      2,
    ),
  );
  console.log(`Mobile reading acceptance passed; evidence ${evidence}`);
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.stop(true);
}
