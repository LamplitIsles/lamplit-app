import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { sentenceFixture } from "./sentence-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error(
    "Native acceptance requires a test-owned semantic control URL",
  );
const fixture = external ? undefined : sentenceFixture();
const host = fixture ? await createChatHost(fixture.backend) : undefined;
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__test/sentence-replies/disconnect") {
          for (const channel of channels.values()) channel.disconnect();
          return Response.json({ disconnected: true });
        }
        if (path === "/__test/sentence-replies") {
          const result = fixture.control(await req.json());
          await host.refresh();
          return Response.json(result);
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
  new URL("/__test/sentence-replies", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/sentence-replies/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
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
    const control = async (action, text) => {
      const response = await context.request.post(controlUrl, {
        data: { action, ...(text === undefined ? {} : { text }) },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await control("reset");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url);
    const bubbles = page.locator(".companion-text-bubble");
    await expect(bubbles.filter({ hasText: "历史第一句。" })).toHaveCount(1);
    await expect(bubbles.filter({ hasText: "历史第二句。" })).toHaveCount(1);
    await expect(page.locator(".companion-thinking")).toHaveCount(1);
    await page
      .getByRole("button", { name: "查看更早的消息", exact: true })
      .click();
    await expect(bubbles.filter({ hasText: "更早第一句。" })).toHaveCount(1);
    await expect(bubbles.filter({ hasText: "更早第二句。" })).toHaveCount(1);
    // An inline span arriving in the current sentence cannot regroup earlier
    // plain sentences. The same semantic controls work with a held native SSE.
    for (const [name, label, suffix, completed, rendered] of [
      ["bold", "粗体", "**粗体**", "**粗体**", "strong"],
      [
        "link",
        "链接",
        "[链接](https://exam",
        "[链接](https://example.test)",
        "a",
      ],
      ["code", "代码", "`a.b", "`a.b`", "code"],
      ["math", "公式", "$x.", "$x.y$", ".katex"],
    ]) {
      const prefix = `${label}第一句。${label}第二句`;
      expect((await control("start", prefix)).held).toBe(true);
      const first = bubbles.filter({
        hasText: new RegExp(`^${label}第一句。$`),
      });
      const tail = bubbles.filter({ hasText: new RegExp(`^${label}第二句$`) });
      await expect(first).toHaveCount(1);
      await expect(tail).toHaveCount(1);
      await first.evaluate((el, id) => {
        el.dataset.richIdentity = id;
      }, `${name}:first`);
      await tail.evaluate((el, id) => {
        el.dataset.richIdentity = id;
      }, `${name}:tail`);
      await page.screenshot({
        path: `${evidence}/rich-${name}-before-${width}.png`,
      });
      expect((await control("advance", prefix + suffix)).held).toBe(true);
      const stableTail = page.locator(`[data-rich-identity="${name}:tail"]`);
      await expect(stableTail).toContainText(
        `${label}第二句${name === "bold" ? "粗体" : suffix}`,
      );
      await expect(first).toHaveAttribute(
        "data-rich-identity",
        `${name}:first`,
      );
      await page.screenshot({
        path: `${evidence}/rich-${name}-after-${width}.png`,
      });
      // Completion uses the same partition policy, with the rich span intact.
      const source = prefix + completed;
      await control("complete", source);
      await expect(first).toHaveCount(1);
      const finalTail = bubbles.filter({ hasText: `${label}第二句` });
      await expect(finalTail).toHaveCount(1);
      await expect(finalTail.locator(rendered)).toBeVisible();
      await finalTail.click({ button: "right" });
      await page.getByRole("button", { name: "复制消息", exact: true }).click();
      expect(await page.evaluate(() => window.fixtureCopied)).toBe(source);
      await expect(page.locator(".companion-action-menu")).toBeHidden();
    }
    const started = await control("start", "正在");
    expect(started.held).toBe(true);
    expect(typeof started.generationId).toBe("string");
    expect(started.generationId.length).toBeGreaterThan(0);
    expect(started.executions).toBeGreaterThan(0);
    await expect(bubbles.filter({ hasText: /^正在$/ })).toHaveCount(1);
    await control("advance", "正在生成第一句");
    await expect(bubbles.filter({ hasText: /^正在生成第一句$/ })).toHaveCount(
      1,
    );
    const first = bubbles.filter({ hasText: /^正在生成第一句$/ });
    await first.evaluate((el) => {
      el.dataset.streamIdentity = "preserved";
    });
    const answer = "正在生成第一句。第二句仍在增长";
    expect((await control("advance", answer)).held).toBe(true);
    await expect(
      bubbles.filter({ hasText: /^正在生成第一句。$/ }),
    ).toHaveAttribute("data-stream-identity", "preserved");
    await expect(bubbles.filter({ hasText: /^第二句仍在增长$/ })).toHaveCount(
      1,
    );
    // Provider is still open: screenshot and copy are before the terminal control.
    await page.screenshot({ path: `${evidence}/held-${width}.png` });
    await bubbles
      .filter({ hasText: /^第二句仍在增长$/ })
      .click({ button: "right" });
    await page.getByRole("button", { name: "复制消息", exact: true }).click();
    expect(await page.evaluate(() => window.fixtureCopied)).toBe(answer);
    const choose = async (value) => {
      await page
        .getByRole("button", { name: "外观与语言", exact: true })
        .click();
      await page
        .locator("#companion-preferences-panel")
        .locator(`input[name=companion-reply-display][value="${value}"]`)
        .locator("xpath=ancestor::label[1]")
        .click();
      await page.keyboard.press("Escape");
      await expect(
        page.locator("#companion-preferences-panel"),
      ).not.toHaveClass(/modal-in/);
    };
    await choose(false);
    await expect(bubbles.filter({ hasText: answer })).toHaveCount(1);
    await control("advance", `${answer}。第三句`);
    await expect(bubbles.filter({ hasText: `${answer}。第三句` })).toHaveCount(
      1,
    );
    await page.reload();
    await expect(bubbles.filter({ hasText: `${answer}。第三句` })).toHaveCount(
      1,
    );
    await choose(true);
    await expect(bubbles.filter({ hasText: /^第三句$/ })).toHaveCount(1);
    expect((await context.request.post(`${controlUrl}/disconnect`)).ok()).toBe(
      true,
    );
    await expect(bubbles.filter({ hasText: /^第三句$/ })).toHaveCount(0);
    await expect(bubbles.filter({ hasText: /^第三句$/ })).toHaveCount(1, {
      timeout: 15000,
    });
    const reconnected = await control("status");
    expect(reconnected.held).toBe(true);
    expect(reconnected.generationId).toBe(started.generationId);
    expect(reconnected.executions).toBe(started.executions);
    const final = `${answer}。第三句完成。`;
    expect((await control("complete", final)).completed).toBe(true);
    await expect(bubbles.filter({ hasText: /^第三句完成。$/ })).toHaveCount(1);
    await expect(bubbles.filter({ hasText: /^第二句仍在增长。$/ })).toHaveCount(
      1,
    );
    await bubbles
      .filter({ hasText: /^第三句完成。$/ })
      .click({ button: "right" });
    await page.getByRole("button", { name: "复制消息", exact: true }).click();
    expect(await page.evaluate(() => window.fixtureCopied)).toBe(final);
    await expect(bubbles.filter({ hasText: /^正在生成第一句。$/ })).toHaveCount(
      1,
    );
    await expect(page.locator('[data-testid^="message-preview:"]')).toHaveCount(
      0,
    );
    if (!external) {
      await control("update", "历史替换第一句。历史替换第二句。");
      await expect(
        bubbles.filter({ hasText: /^历史替换第一句。$/ }),
      ).toHaveCount(1);
      await expect(bubbles.filter({ hasText: /^历史第一句。$/ })).toHaveCount(
        0,
      );
    }
    await page.screenshot({ path: `${evidence}/complete-${width}.png` });
    if (!external) {
      await control("excluded");
      for (const text of [
        "用户第一句。用户第二句。",
        "Keet第一句。Keet第二句。",
        "Matrix第一句。Matrix第二句。",
        "提醒第一句。提醒第二句。",
      ]) {
        await expect(bubbles.filter({ hasText: text })).toHaveCount(1);
      }
      await expect(
        page
          .locator(".companion-notice")
          .filter({ hasText: "提示第一句。提示第二句。" }),
      ).toHaveCount(1);
      await expect(bubbles.filter({ hasText: /^普通第一句。$/ })).toHaveCount(
        1,
      );
      await expect(
        bubbles
          .locator("strong")
          .filter({ hasText: "粗体第一句。粗体第二句。" }),
      ).toHaveCount(1);
      await expect(bubbles.locator("pre code")).toContainText("a.b();");
    }
    // Real text growth follows at bottom, but leaves earlier reading anchored.
    await control("start", "滚动句子。".repeat(120));
    const timeline = page.locator(".companion-timeline");
    await expect
      .poll(() =>
        timeline.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(100);
    await timeline.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(100); // let native scroll listeners settle before measuring
    const top = await timeline.evaluate((el) => el.scrollTop);
    await control("advance", "滚动句子。".repeat(125));
    await expect(bubbles.filter({ hasText: /^滚动句子。$/ })).toHaveCount(125);
    expect(
      Math.abs((await timeline.evaluate((el) => el.scrollTop)) - top),
    ).toBeLessThan(5);
    await control("stop");
    await expect(
      page
        .locator(".companion-notice")
        .filter({ hasText: "已停止回复" })
        .last(),
    ).toBeVisible();
    await expect(bubbles.filter({ hasText: /^滚动句子。$/ })).toHaveCount(0);
    await control("start", "失败前的临时正文");
    await expect(bubbles.filter({ hasText: "失败前的临时正文" })).toHaveCount(
      1,
    );
    await control("fail");
    await expect(
      page.locator(".companion-notice").filter({ hasText: "回复失败" }).last(),
    ).toBeVisible();
    await expect(bubbles.filter({ hasText: "失败前的临时正文" })).toHaveCount(
      0,
    );
    await control("start", "切换前的临时正文");
    await expect(bubbles.filter({ hasText: "切换前的临时正文" })).toHaveCount(
      1,
    );
    await control("session");
    await expect(bubbles.filter({ hasText: "切换前的临时正文" })).toHaveCount(
      0,
    );
    await expect(bubbles.filter({ hasText: /^正在生成第一句。$/ })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        backend: external
          ? "external semantic host; native provenance supplied by host"
          : "App DTO fixture",
        acceptance: "passed",
        widths: [390, 1280],
        heldBeforeTerminal: true,
        jointAcceptance: "pending Orc",
      },
      null,
      2,
    ),
  );
  console.log("Sentence replies browser acceptance passed");
} finally {
  await browser.close();
  host?.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.stop(true);
}
