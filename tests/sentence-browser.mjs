import { createUiTestHost } from "./ui-test-host.ts";
import { chromium, expect } from "@playwright/test";
import { sentenceFixture, SENTENCE_PROMPT } from "./sentence-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Exercise the real socket → Partner → Companion → Markdown DOM path.
async function atomicStreamingChecks(page, control) {
  await control("session");
  const bubbles = page.locator(".k-message.incoming .companion-text-bubble");
  await expect(bubbles).toHaveCount(0);
  const previewDelivered = async (text) => {
    // Wait for this exact authoritative preview to reach the browser before
    // checking absence: a count of zero before socket delivery proves nothing.
    await page.waitForFunction(
      (text) =>
        window.atomicPreviewFrames?.some((raw) =>
          raw.includes(JSON.stringify(text)),
        ),
      text,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  for (const [action, text] of [
    ["start", "正"],
    ["advance", "正在"],
    ["advance", "正在生成。同行第二句。"],
  ]) {
    const held = await control(action, text);
    expect(held.held).toBe(true);
    await previewDelivered(text);
    console.log(
      "atomic held observation",
      JSON.stringify({ text, visible: await bubbles.allTextContents() }),
    );
    await expect(bubbles).toHaveCount(0);
  }
  await control("advance", "正在生成。同行第二句。\r");
  await previewDelivered("正在生成。同行第二句。\r");
  await expect(bubbles).toHaveCount(0);
  await control("advance", "正在生成。同行第二句。\r\n第二行");
  await expect(bubbles).toHaveText(["正在生成。同行第二句。"]);
  await bubbles.first().evaluate((node) => { node.dataset.segmentIdentity = "preserved"; });
  await control("advance", "正在生成。同行第二句。\r\n第二行完成\n最后尾巴");
  await expect(bubbles).toHaveText(["正在生成。同行第二句。", "第二行完成"]);
  await expect(bubbles.first()).toHaveAttribute("data-segment-identity", "preserved");
  expect((await control("status")).held).toBe(true);
  await control("complete", "正在生成。同行第二句。\r\n第二行完成\n最后尾巴");
  await expect(bubbles).toHaveText([
    "正在生成。同行第二句。",
    "第二行完成",
    "最后尾巴",
  ]);
  await expect(bubbles.first()).toHaveAttribute("data-segment-identity", "preserved");
  await expect(page.locator('[data-testid^="message-preview:"]')).toHaveCount(
    0,
  );
}

const profile = process.env.APP_ACCEPTANCE_PROFILE ?? "default";
if (profile !== "default" && profile !== "cfl")
  throw new Error(`Unknown APP_ACCEPTANCE_PROFILE: ${profile}`);
const thinkingCount = profile === "cfl" ? 0 : 1;
const external = process.env.APP_ACCEPTANCE_URL;
if (process.argv.includes("--gap-only") && (external || process.env.APP_ACCEPTANCE_CONTROL_URL))
  throw new Error("Gap checks require the local test-owned fixture");
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error(
    "Native acceptance requires a test-owned semantic control URL",
  );
const fixture = external ? undefined : sentenceFixture(profile);
const host = fixture ? await createUiTestHost(fixture.backend) : undefined;
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
          await host.publish();
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
      window.atomicPreviewFrames = [];
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (event) =>
            window.atomicPreviewFrames.push(String(event.data)),
          );
        }
      };
    });
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
    if (process.argv.includes("--gap-only")) await control("gap-seed");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url);
    const bubbles = page.locator(".k-message.incoming .companion-text-bubble");
    const userBubbles = page.locator(".k-message.outgoing .companion-text-bubble");
    if (process.argv.includes("--gap-only")) {
      await expect(bubbles.filter({ hasText: /^消息 64$/ })).toHaveCount(1);
      await page.getByRole("button", { name: "查看更早的消息", exact: true }).click();
      await expect(bubbles.filter({ hasText: /^消息 5$/ })).toHaveCount(1);
      expect((await control("status")).gapHistoryCalls).toBe(1);
      await context.request.post(new URL("/__test/sentence-replies/disconnect", url).href);
      await control("gap-advance");
      await expect(bubbles.filter({ hasText: /^消息 124$/ })).toHaveCount(1);
      const marker = page.locator('[data-testid^="history-gap-"]');
      await expect(marker).toHaveCount(1);
      expect((await control("status")).gapHistoryCalls).toBe(1);
      await control("gap-fail-next");
      await marker.scrollIntoViewIfNeeded();
      await expect(marker).toContainText("中间的消息加载失败。");
      expect((await control("status")).gapHistoryCalls).toBe(2);
      await marker.getByRole("button", { name: "重试" }).click();
      await expect(bubbles.filter({ hasText: /^消息 65$/ })).toHaveCount(1);
      expect((await control("status")).gapHistoryCalls).toBe(3);
      await marker.getByRole("button", { name: "加载中间的消息" }).click();
      await expect(marker).toHaveCount(0);
      expect((await control("status")).gapHistoryCalls).toBe(4);
      await expect(bubbles.filter({ hasText: /^消息 5$/ })).toHaveCount(1);
      await control("media-captions");
      await expect(bubbles.filter({ hasText: /^图片附带文字$/ })).toHaveCount(1);
      await expect(bubbles.filter({ hasText: /^语音附带文字$/ })).toHaveCount(1);
      expect(errors).toEqual([]);
      await context.close();
      continue;
    }
    const expectPrompt = async () => {
      await expect(userBubbles).toHaveCount(1);
      await expect(userBubbles).toHaveText([SENTENCE_PROMPT]);
      await expect(userBubbles).toBeVisible();
    };
    if (process.argv.includes("--atomic-only")) {
      await atomicStreamingChecks(page, control);
      await context.close();
      continue;
    }
    await expect(
      bubbles.filter({ hasText: /^历史第一行。同行第二句。$/ }),
    ).toHaveCount(1);
    await expect(bubbles.filter({ hasText: /^历史第二行。$/ })).toHaveCount(1);
    const expectPrivacy = async () => {
      if (profile === "cfl") {
        await expect(page.locator(".companion-thinking")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(
          "CFL_REASONING_PRIVATE_SENTINEL",
        );
      }
    };
    await expect(page.locator(".companion-thinking")).toHaveCount(
      thinkingCount,
    );
    await expectPrivacy();
    await page
      .getByRole("button", { name: "查看更早的消息", exact: true })
      .click();
    await expect(bubbles.filter({ hasText: /^更早第一行。$/ })).toHaveCount(1);
    await expect(bubbles.filter({ hasText: /^更早第二行。$/ })).toHaveCount(1);
    const rowFor = (bubble) =>
      bubble.locator(
        "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' companion-row ')][1]",
      );
    const independent = async (bubble) => {
      const row = rowFor(bubble);
      await expect(row).toHaveClass(/companion-message-first/);
      await expect(row).toHaveClass(/companion-message-last/);
      await expect(row.locator(".companion-chat-avatar")).toHaveCount(0);
      const el = row.locator("time");
      await expect(el).toBeVisible();
      expect(await el.evaluate((node) => {
        for (let p = node; p; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (Number(style.opacity) === 0 || style.visibility !== "visible") return false;
        }
        return node.getBoundingClientRect().width > 0;
      })).toBe(true);
    };
    const copyBubble = async (bubble) => {
      await bubble.evaluate((el) =>
        el.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      let previousY;
      let stable = 0;
      await expect
        .poll(
          async () => {
            const y = await bubble.evaluate(
              (el) => el.getBoundingClientRect().top,
            );
            stable =
              previousY !== undefined && Math.abs(y - previousY) < 0.5
                ? stable + 1
                : 0;
            previousY = y;
            return stable;
          },
          { intervals: [100], timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(3);
      const { x, y, hit } = await bubble.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 40);
        const y =
          (Math.max(r.top, 90) + Math.min(r.bottom, innerHeight - 140)) / 2;
        return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
      });
      expect(hit, "stationary hold starts on visible message content").toBe(
        true,
      );
      if (width < 500) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        await page.waitForTimeout(700);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.detach();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(700);
        await page.mouse.up();
      }
      const copy = page.getByRole("button", { name: "复制", exact: true });
      await expect(copy).toBeVisible();
      if (width < 500) await copy.tap();
      else await copy.click();
      await expect(page.locator(".companion-action-menu")).toBeHidden();
      return page.evaluate(() => window.fixtureCopied);
    };

    // Reconstructed source line breaks, not the unknown screenshot Markdown.
    const screenshotSource =
      "> **一个222米的新坑，2025年才发现**。同行的说明不再按句号拆开。\n> 发现办法是比对照片。\n> 发现后又拍了半年。\n\n两处「没想到」：\n\n1. 它在**一百多公里以外**留下痕迹；\n2. **喷出角度更大**，而且至少两波。\n\n按模型，平均**132年**才形成一个。赶上一回是一辈子的事。\n它落在**两种岩石的交界**上。只有挖深才翻出材料。\n名字是 **McGetchin**。这个坑三样都齐了。";
    await control("start", screenshotSource + "\n");
    await expect(
      bubbles.filter({ has: page.locator("blockquote") }),
    ).toHaveCount(3);
    await expect(bubbles.filter({ hasText: /^两处「没想到」：$/ })).toHaveCount(
      1,
    );
    const list = bubbles.filter({ has: page.locator("ol") });
    await expect(list).toHaveCount(1);
    await expect(list).not.toContainText("两处「没想到」");
    await expect(list).not.toContainText("按模型");
    const shape = bubbles.filter({
      hasText:
        /222米|发现办法|发现后|两处「没想到」|一百多公里|按模型|它落在|名字是/,
    });
    await expect(shape).toHaveCount(8);
    const sourceTime = await rowFor(shape.first())
      .locator("time")
      .getAttribute("datetime");
    for (const bubble of await shape.all()) {
      await independent(bubble);
      expect(
        await rowFor(bubble).locator("time").getAttribute("datetime"),
      ).toBe(sourceTime);
    }
    await expect(
      bubbles.filter({
        hasText: /^按模型，平均132年才形成一个。赶上一回是一辈子的事。$/,
      }),
    ).toHaveCount(1);
    expect(
      await copyBubble(
        bubbles.filter({ hasText: /^历史第一行。同行第二句。$/ }),
      ),
    ).toBe("历史第一行。同行第二句。");
    expect(
      await copyBubble(bubbles.filter({ hasText: /^历史第二行。$/ })),
    ).toBe("历史第二行。");
    const quote = bubbles.filter({ hasText: /^发现办法是比对照片。$/ });
    expect(await copyBubble(quote)).toBe("发现办法是比对照片。");
    await page.screenshot({ path: `${evidence}/quote-${width}.png` });
    await shape.last().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/screenshot-shape-${width}.png`,
    });
    const shapeTexts = await shape.allTextContents();
    await control("complete", screenshotSource + "\n");
    await page.reload();
    await expect(shape).toHaveCount(8);
    expect(await shape.allTextContents()).toEqual(shapeTexts);
    for (const [label, partial, closed, selector] of [
      ["list", "- one\n  - nested", "- one\n  - nested\n- two", "ul"],
      ["fence", "```js\na.b();", "```js\na.b();\nc.d();\n```", "pre code"],
      ["table", "| A | B |\n|--", "| A | B |\n|---|---|\n| x | y |", "table"],
      ["blockmath", "$$\nx.y", "$$\nx.y\n$$", ".katex-display"],
    ]) {
      const prefix = `${label}前缀\n\n`;
      await control("start", prefix + partial);
      const stable = bubbles.filter({ hasText: new RegExp(`^${label}前缀$`) });
      await stable.evaluate((el, label) => {
        el.dataset.blockIdentity = label;
      }, label);
      const source = prefix + closed + `\n\n${label}后行\n${label}末行`;
      await control("advance", source);
      await expect(stable).toHaveAttribute("data-block-identity", label);
      await expect(bubbles.locator(selector).last()).toBeVisible();
      await expect(
        bubbles.filter({ hasText: new RegExp(`^${label}后行$`) }),
      ).toHaveCount(1);
      await control("complete", source);
    }
    for (const [source, selector, marker] of [
      [
        "[危险链接](javascript:alert(1))\n安全后行",
        "a:not([href])",
        "安全后行",
      ],
    ]) {
      await control("start", source + "\n");
      await expect(bubbles.locator(selector).last()).toBeVisible();
      await expect(bubbles.filter({ hasText: marker })).toHaveCount(1);
      await control("complete", source + "\n");
    }
    const started = await control("start", "正在第一句。同行第二句。\r");
    expect(started.held).toBe(true);
    expect(started.generationId).toBeTruthy();
    expect(started.executions).toBeGreaterThan(0);
    await expect(
      bubbles.filter({ hasText: /^正在第一句。同行第二句。$/ }),
    ).toHaveCount(0);
    await control("advance", "正在第一句。同行第二句。\r\n");
    const first = bubbles.filter({ hasText: /^正在第一句。同行第二句。$/ });
    await expect(first).toHaveCount(1);
    await first.evaluate((el) => {
      el.dataset.crIdentity = "stable";
    });

    await expect(first).toHaveAttribute("data-cr-identity", "stable");
    const answer = "正在第一句。同行第二句。\r\n第二行增长";
    await control("advance", answer);
    await expect(first).toHaveAttribute("data-cr-identity", "stable");
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(0);
    expect(await copyBubble(first)).toBe("正在第一句。同行第二句。");
    await page.screenshot({ path: `${evidence}/held-${width}.png` });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#companion-preferences-panel")
      .getByRole("button", { name: "外观", exact: true }).click();
    await expect(page.locator('input[name="companion-reply-display"]')).toHaveCount(0);
    await page.locator("#companion-preferences-panel")
      .getByRole("button", { name: "返回" }).click();
    await page.locator("#companion-preferences-panel")
      .getByRole("button", { name: "返回" }).click();
    await expect(page.locator("#companion-preferences-panel")).toBeHidden();
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(0);
    expect((await context.request.post(`${controlUrl}/disconnect`)).ok()).toBe(
      true,
    );
    await expect(first).toHaveCount(0);
    await expect(first).toHaveCount(1, {
      timeout: 15000,
    });
    const reconnected = await control("status");
    expect(reconnected.held).toBe(true);
    expect(reconnected.generationId).toBe(started.generationId);
    expect(reconnected.executions).toBe(started.executions);
    const final = answer + "完成\n第三行";
    expect((await control("complete", final)).completed).toBe(true);
    await expect(bubbles.filter({ hasText: /^第二行增长完成$/ })).toHaveCount(
      1,
    );
    await expect(bubbles.filter({ hasText: /^第三行$/ })).toHaveCount(1);
    await expect(page.locator('[data-testid^="message-preview:"]')).toHaveCount(
      0,
    );
    if (!external) {
      await control("excluded");
      await expect(
        userBubbles.filter({ hasText: "用户第一行。\n用户第二行。" }),
      ).toHaveCount(1);
      for (const text of [
        "Keet第一行。\nKeet第二行。",
        "Matrix第一行。\nMatrix第二行。",
        "提醒第一行。\n提醒第二行。",
      ])
        await expect(bubbles.filter({ hasText: text })).toHaveCount(1);
      await expect(
        page
          .locator(".companion-notice")
          .filter({ hasText: "提示第一行。\n提示第二行。" }),
      ).toHaveCount(1);
      await expect(
        bubbles
          .locator("strong")
          .filter({ hasText: "粗体第一句。粗体第二句。" }),
      ).toHaveCount(1);
      await expect(
        bubbles.locator("pre code").filter({ hasText: "a.b();" }).last(),
      ).toBeVisible();
      expect(
        await copyBubble(bubbles.filter({ hasText: /^普通第二行。$/ })),
      ).toBe("普通第二行。");
      await expect(
        page.locator('[data-testid="message-rich"] .companion-thinking'),
      ).toHaveCount(thinkingCount);
      await expect(page.locator(".companion-thinking")).toHaveCount(
        2 * thinkingCount,
      );
      await expectPrivacy();
      const images = page.locator(".companion-image-entry");
      await expect(images).toHaveCount(2);
      expect(await images.nth(0).getAttribute("data-testid")).toBe(
        "image-rich:sentence-image-1",
      );
      expect(await images.nth(1).getAttribute("data-testid")).toBe(
        "image-rich:sentence-image-2",
      );
    }
    await page.screenshot({ path: `${evidence}/complete-${width}.png` });
    const scrollText = Array(120).fill("滚动行").join("\n") + "\n";
    const timeline = page.locator(".companion-timeline");
    // Copying an older selection leaves the reader at that message; explicitly
    // return to the latest message before testing following-mode streaming.
    await timeline.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    await control("start", scrollText);
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
    await page.waitForTimeout(100);
    const top = await timeline.evaluate((el) => el.scrollTop);
    await control(
      "advance",
      scrollText + Array(5).fill("滚动行").join("\n") + "\n",
    );
    await expect(bubbles.filter({ hasText: /^滚动行$/ })).toHaveCount(125);
    expect(
      Math.abs((await timeline.evaluate((el) => el.scrollTop)) - top),
    ).toBeLessThan(5);
    await control("stop");
    await expect(bubbles.filter({ hasText: /^滚动行$/ })).toHaveCount(0);
    await expect(
      page
        .locator(".companion-notice")
        .filter({ hasText: "已停止回复" })
        .last(),
    ).toBeVisible();
    await control("start", "失败临时行\n隐藏尾巴");
    await expect(bubbles.filter({ hasText: "失败临时行" })).toHaveCount(1);
    await control("fail");
    await expect(
      page.locator(".companion-notice").filter({ hasText: "回复失败" }).last(),
    ).toBeVisible();
    await expect(bubbles.filter({ hasText: "失败临时行" })).toHaveCount(0);
    await control("start", "切换临时行\n隐藏尾巴");
    await expect(bubbles.filter({ hasText: "切换临时行" })).toHaveCount(1);
    await control("session");
    await expect(bubbles.filter({ hasText: "切换临时行" })).toHaveCount(0);
    // Preserve full-source Markdown semantics when projecting source lines.
    for (const [source, expected] of [
      [
        "before\n    indented continuation\nafter",
        ["before", "indented continuation\n", "after"],
      ],
      [
        "before\n2. continuation\nafter",
        ["before", "continuation", "after"],
      ],
      ["price $5\nafter\nlast", ["price $5", "after", "last"]],
      ["<div>visible text</div>", ["<div>visible text</div>"]],
      [
        "before <span>visible inline</span> after\nlast",
        ["before <span>visible inline</span> after", "last"],
      ],
    ]) {
      await control("session");
      await expect(bubbles).toHaveCount(0);
      await control("start", source);
      await control("complete", source);
      await expectPrompt();
      await expect(bubbles).toHaveCount(expected.length);
      expect(await bubbles.allTextContents()).toEqual(expected);
      if (!source.startsWith("before\n"))
        await expect(bubbles.locator("pre, ol, ul")).toHaveCount(0);
      await expect(
        bubbles.locator(".markdown > div, .markdown p > span"),
      ).toHaveCount(0);
      if (source.startsWith("before\n"))
        expect(await copyBubble(bubbles.nth(1))).toBe(
          expected[1].trimEnd(),
        );
    }
    // HTML cleanup may rewrite raw spelling; only source tokens own offsets.
    for (const source of [
      "<hr>\n\nafter\nlast",
      "<br>\n\nafter\nlast",
      "before<br>after\nlast",
      "<div class=x>visible text</div>\n\nafter\nlast",
      " <div class=x>visible text</div>\n\nafter\nlast",
      "🙂before<br>after\r\nlast",
    ]) {
      await control("session");
      await expect(bubbles).toHaveCount(0);
      await control("start", source);
      await control("complete", source);
      await expectPrompt();
      const inline = source.includes("before");
      await expect(bubbles).toHaveCount(inline ? 2 : 3);
      const split = await bubbles.allTextContents();
      expect(split[0].length).toBeGreaterThan(0);
      expect(split.at(-1)).toBe("last");
      if (!inline) expect(split[1]).toBe("after");
      await expect(
        bubbles.locator(".markdown hr, .markdown br, .markdown .x"),
      ).toHaveCount(0);
      expect(await copyBubble(bubbles.first())).toBe(await bubbles.first().innerText());
    }
    await control("session");
    await expect(bubbles).toHaveCount(0);
    const stableSource =
      "**stable prefix** [link](https://one.test)\ngrowing tail";
    await control("start", stableSource);
    await expectPrompt();
    const stableRoot = bubbles
      .filter({ hasText: "stable prefix" })
      .locator(".markdown p");
    await expect(stableRoot).toHaveCount(1);
    await stableRoot.evaluate((p) => {
      window.fixtureInner = {
        p,
        strong: p.querySelector("strong"),
        link: p.querySelector("a"),
      };
    });
    await control("advance", stableSource + " extended");
    await expect(
      bubbles.filter({ hasText: "growing tail extended" }),
    ).toHaveCount(0);
    expect(
      await stableRoot.evaluate(
        (p) =>
          window.fixtureInner.p.isConnected &&
          p === window.fixtureInner.p &&
          p.querySelector("strong") === window.fixtureInner.strong &&
          p.querySelector("a") === window.fixtureInner.link,
      ),
    ).toBe(true);
    await control("complete", stableSource + " extended");
    await control("session");
    await expect(bubbles).toHaveCount(0);
    const referenceSource = "reference before [anchor][r]\ntail";
    await control("start", referenceSource);
    await expectPrompt();
    const reference = bubbles.filter({ hasText: "reference before" });
    await expect(reference.locator("a")).toHaveCount(0);
    const resolved = referenceSource + "\n\n[r]: https://late.test\n";
    await control("advance", resolved);
    await expect(reference.locator("a")).toHaveCount(0);
    expect(await copyBubble(reference)).toBe("reference before [anchor][r]");
    await reference.evaluate((node) => { window.fixtureReference = node; });
    await control("advance", resolved + "\n\nadditional tail");
    await expect(bubbles.filter({ hasText: "additional tail" })).toHaveCount(0);
    expect(
      await reference.evaluate(
        (node) => node === window.fixtureReference && window.fixtureReference.isConnected,
      ),
    ).toBe(true);
    await control("complete", resolved + "\n\nadditional tail");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await atomicStreamingChecks(page, control);
    await expectPrivacy();
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
        scope: process.argv.includes("--atomic-only")
          ? "atomic streaming"
          : "full sentence replies",
        profile,
        widths: [390, 1280],
        heldBeforeTerminal: true,
        userPrompt: SENTENCE_PROMPT,
        isolatedUserAndAgentCoexist: true,
        jointAcceptance: "pending Orc",
      },
      null,
      2,
    ),
  );
  console.log(
    process.argv.includes("--atomic-only")
      ? "Atomic streaming browser acceptance passed"
      : "Sentence replies browser acceptance passed",
  );
} finally {
  await browser.close();
  host?.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.stop(true);
}
