import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { sentenceFixture, SENTENCE_PROMPT } from "./sentence-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const profile = process.env.APP_ACCEPTANCE_PROFILE ?? "default";
if (profile !== "default" && profile !== "cfl")
  throw new Error(`Unknown APP_ACCEPTANCE_PROFILE: ${profile}`);
const thinkingCount = profile === "cfl" ? 0 : 1;
const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error(
    "Native acceptance requires a test-owned semantic control URL",
  );
const fixture = external ? undefined : sentenceFixture(profile);
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
    const bubbles = page.locator(".message-received .companion-text-bubble");
    const userBubbles = page.locator(".message-sent .companion-text-bubble");
    const expectPrompt = async () => {
      await expect(userBubbles).toHaveCount(1);
      await expect(userBubbles).toHaveText([SENTENCE_PROMPT]);
      await expect(userBubbles).toBeVisible();
    };
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
        "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' message ')][1]",
      );
    const independent = async (bubble) => {
      const row = rowFor(bubble);
      await expect(row).toHaveClass(/message-first/);
      await expect(row).toHaveClass(/message-last/);
      await expect(row).toHaveClass(/message-tail/);
      for (const selector of [".message-avatar", "time"]) {
        const el = row.locator(selector);
        await expect(el).toBeVisible();
        expect(
          await el.evaluate((node) => {
            for (let p = node; p; p = p.parentElement) {
              const style = getComputedStyle(p);
              if (Number(style.opacity) === 0 || style.visibility !== "visible")
                return false;
            }
            return node.getBoundingClientRect().width > 0;
          }),
        ).toBe(true);
      }
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
      const copy = page.getByRole("button", { name: "复制消息", exact: true });
      await expect(copy).toBeVisible();
      if (width < 500) await copy.tap();
      else await copy.click();
      await expect(page.locator(".companion-action-menu")).toBeHidden();
      return page.evaluate(() => window.fixtureCopied);
    };

    // Reconstructed source line breaks, not the unknown screenshot Markdown.
    const screenshotSource =
      "> **一个222米的新坑，2025年才发现**。同行的说明不再按句号拆开。\n> 发现办法是比对照片。\n> 发现后又拍了半年。\n\n两处「没想到」：\n\n1. 它在**一百多公里以外**留下痕迹；\n2. **喷出角度更大**，而且至少两波。\n\n按模型，平均**132年**才形成一个。赶上一回是一辈子的事。\n它落在**两种岩石的交界**上。只有挖深才翻出材料。\n名字是 **McGetchin**。这个坑三样都齐了。";
    await control("start", screenshotSource);
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
    ).toBe("历史第一行。同行第二句。\n");
    expect(
      await copyBubble(bubbles.filter({ hasText: /^历史第二行。$/ })),
    ).toBe("历史第二行。");
    const quote = bubbles.filter({ hasText: /^发现办法是比对照片。$/ });
    expect(await copyBubble(quote)).toBe("> 发现办法是比对照片。\n");
    await page.screenshot({ path: `${evidence}/quote-${width}.png` });
    await shape.last().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/screenshot-shape-${width}.png`,
    });
    const shapeTexts = await shape.allTextContents();
    await control("complete", screenshotSource);
    await page.reload();
    await expect(shape).toHaveCount(8);
    expect(await shape.allTextContents()).toEqual(shapeTexts);
    for (const [name, open, closed, selector] of [
      ["bold", "**跨行\n粗体", "**跨行\n粗体**", "strong"],
      [
        "link",
        "[跨行\n链接](https://exam",
        "[跨行\n链接](https://example.test)",
        "a",
      ],
      ["code", "`跨行\n代码", "`跨行\n代码`", "code"],
      ["math", "\\(x.\ny", "\\(x.\ny\\)", ".katex"],
    ]) {
      const prefix = `${name}稳定行。同行第二句。\n`;
      await control("start", prefix + "当前行");
      const first = bubbles.filter({ hasText: `${name}稳定行。同行第二句。` });
      await first.evaluate((el, name) => {
        el.dataset.streamIdentity = name;
      }, name);
      await control("advance", prefix + "当前行" + open);
      await expect(first).toHaveAttribute("data-stream-identity", name);
      const source = prefix + "当前行" + closed + `\n${name}后行\n${name}末行`;
      await control("advance", source);
      await expect(first).toHaveAttribute("data-stream-identity", name);
      const rich = bubbles.filter({ hasText: "当前行" }).last();
      await expect(rich.locator(selector)).toBeVisible();
      await expect(
        bubbles.filter({ hasText: new RegExp(`^${name}后行$`) }),
      ).toHaveCount(1);
      expect(await copyBubble(rich)).toBe("当前行" + closed + "\n");
      await control("complete", source);
      await expect(
        bubbles.filter({ hasText: new RegExp(`^${name}末行$`) }),
      ).toHaveCount(1);
    }
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
        "[共享链接][r]\n引用后行\n\n[r]: https://example.test",
        "a[href='https://example.test']",
        "引用后行",
      ],
      [
        "[危险链接](javascript:alert(1))\n安全后行",
        "a:not([href])",
        "安全后行",
      ],
    ]) {
      await control("start", source);
      await expect(bubbles.locator(selector).last()).toBeVisible();
      await expect(bubbles.filter({ hasText: marker })).toHaveCount(1);
      await control("complete", source);
    }
    const started = await control("start", "正在第一句。同行第二句。");
    expect(started.held).toBe(true);
    expect(started.generationId).toBeTruthy();
    expect(started.executions).toBeGreaterThan(0);
    const first = bubbles.filter({ hasText: /^正在第一句。同行第二句。$/ });
    await expect(first).toHaveCount(1);
    await first.evaluate((el) => {
      el.dataset.crIdentity = "stable";
    });
    await control("advance", "正在第一句。同行第二句。\r");
    await expect(first).toHaveAttribute("data-cr-identity", "stable");
    const answer = "正在第一句。同行第二句。\r\n第二行增长";
    await control("advance", answer);
    await expect(first).toHaveAttribute("data-cr-identity", "stable");
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(1);
    expect(await copyBubble(first)).toBe("正在第一句。同行第二句。\r\n");
    await page.screenshot({ path: `${evidence}/held-${width}.png` });
    const choose = async (value) => {
      const prompts = await userBubbles.allTextContents();
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
      await expect(page.locator("#companion-preferences-panel")).toBeHidden();
      expect(await userBubbles.allTextContents()).toEqual(prompts);
    };

    await choose(false);
    expect(
      await copyBubble(
        bubbles.filter({ hasText: /^正在第一句。同行第二句。\s*第二行增长$/ }),
      ),
    ).toBe(answer);
    await page.reload();
    await expect(
      bubbles.filter({ hasText: /^正在第一句。同行第二句。\s*第二行增长$/ }),
    ).toHaveCount(1);
    await choose(true);
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(1);
    expect((await context.request.post(`${controlUrl}/disconnect`)).ok()).toBe(
      true,
    );
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(0);
    await expect(bubbles.filter({ hasText: /^第二行增长$/ })).toHaveCount(1, {
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
      await control("update", "历史更新第一行\n历史更新第二行");
      await expect(bubbles.filter({ hasText: /^历史更新第二行$/ })).toHaveCount(
        1,
      );
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
      ).toBe("普通第二行。\n\n");
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
    const scrollText = Array(120).fill("滚动行").join("\n");
    await control("start", scrollText);
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
    await page.waitForTimeout(100);
    const top = await timeline.evaluate((el) => el.scrollTop);
    await control(
      "advance",
      scrollText + "\n" + Array(5).fill("滚动行").join("\n"),
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
    await control("start", "失败临时行");
    await expect(bubbles.filter({ hasText: "失败临时行" })).toHaveCount(1);
    await control("fail");
    await expect(
      page.locator(".companion-notice").filter({ hasText: "回复失败" }).last(),
    ).toBeVisible();
    await expect(bubbles.filter({ hasText: "失败临时行" })).toHaveCount(0);
    await control("start", "切换临时行");
    await expect(bubbles.filter({ hasText: "切换临时行" })).toHaveCount(1);
    await control("session");
    await expect(bubbles.filter({ hasText: "切换临时行" })).toHaveCount(0);
    // Preserve full-source Markdown semantics when projecting source lines.
    for (const [source, expected] of [
      [
        "before\n    indented continuation\nafter",
        ["before", "    indented continuation", "after"],
      ],
      [
        "before\n2. continuation\nafter",
        ["before", "2. continuation", "after"],
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
      await expectPrompt();
      await expect(bubbles).toHaveCount(expected.length);
      expect(await bubbles.allTextContents()).toEqual(expected);
      await expect(bubbles.locator("pre, ol, ul")).toHaveCount(0);
      await expect(
        bubbles.locator(".markdown > div, .markdown p > span"),
      ).toHaveCount(0);
      if (source.startsWith("before\n"))
        expect(await copyBubble(bubbles.nth(1))).toBe(
          source.split("\n")[1] + "\n",
        );
      await choose(false);
      await expect(bubbles).toHaveCount(1);
      await expect(bubbles.locator("pre, ol, ul")).toHaveCount(0);
      expect(await bubbles.textContent()).toBe(source);
      await choose(true);
      await expectPrompt();
      await control("complete", source);
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
      const cut = source.indexOf("last");
      expect(await copyBubble(bubbles.first())).toBe(
        inline
          ? source.slice(0, cut)
          : source.slice(0, source.indexOf("after\n")),
      );
      await choose(false);
      await expect(bubbles).toHaveCount(1);
      expect((await bubbles.textContent()).replace(/\n/g, "")).toBe(
        split.join(""),
      );
      await choose(true);
      await expectPrompt();
      await control("complete", source);
    }
    for (const parts of [
      ["<span>one\ntwo</span>\n", "after"],
      ["<span class=x>one\r\ntwo</span>\r\n", "after"],
      ["<span>one\n<em>two</em>\nthree</span>\n", "after"],
      ["<span>one\n<span>two</span>\nthree</span>\n", "after"],
      ["<span>one\ntwo</span>\n", "<span>three\nfour</span>\n", "after"],
      ["<span>one<br>\ntwo</span>\n", "after"],
    ]) {
      const source = parts.join("");
      await control("session");
      await expect(bubbles).toHaveCount(0);
      await control("start", source);
      await expectPrompt();
      await expect(bubbles).toHaveCount(parts.length);
      await expect(bubbles.last()).toHaveText("after");
      const split = await bubbles.allTextContents();
      expect(await copyBubble(bubbles.first())).toBe(parts[0]);
      await choose(false);
      await expect(bubbles).toHaveCount(1);
      expect((await bubbles.textContent()).replace(/\n/g, "")).toBe(
        split.join("").replace(/\n/g, ""),
      );
      expect(await copyBubble(bubbles.first())).toBe(source);
      await choose(true);
      await expectPrompt();
      await control("complete", source);
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
    ).toHaveCount(1);
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
    const resolved = referenceSource + "\n\n[r]: https://late.test";
    await control("advance", resolved);
    await expect(reference.locator("a")).toHaveAttribute(
      "href",
      "https://late.test",
    );
    expect(await copyBubble(reference)).toBe("reference before [anchor][r]\n");
    await reference.locator("a").evaluate((link) => {
      window.fixtureResolvedLink = link;
    });
    await control("advance", resolved + "\n\nadditional tail");
    await expect(bubbles.filter({ hasText: "additional tail" })).toHaveCount(1);
    expect(
      await reference
        .locator("a")
        .evaluate(
          (link) =>
            link === window.fixtureResolvedLink &&
            window.fixtureResolvedLink.isConnected,
        ),
    ).toBe(true);
    await control("complete", resolved + "\n\nadditional tail");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
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
  console.log("Sentence replies browser acceptance passed");
} finally {
  await browser.close();
  host?.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.stop(true);
}
