import { createUiTestHost } from "./ui-test-host.ts";
import { fixtureBackend } from "./fixture.ts";
import { fileLimits } from "./files-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { chromium, devices, expect } from "@playwright/test";
import { resolve } from "node:path";

if (process.env.APP_ACCEPTANCE_URL || process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("This test only uses an isolated fixture");
const fixture = fixtureBackend();
const host = await createUiTestHost({
  ...fixture.backend,
  async read() {
    const view = await fixture.backend.read();
    return {
      ...view,
      capabilities: { ...view.capabilities, files: fileLimits },
    };
  },
});
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
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
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
  args: ["--disable-background-networking", "--disable-sync"],
});
try {
  for (const mode of [
    "viewport",
    "virtualKeyboard",
    "viewport-ios",
    "desktop",
  ]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      isMobile: mode !== "desktop",
      hasTouch: mode !== "desktop",
      serviceWorkers: "block",
      ...(mode === "viewport-ios"
        ? { userAgent: devices["iPhone 13"].userAgent }
        : {}),
    });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await context.addInitScript((mode) => {
      window.__composerTransitions = [];
      document.addEventListener("transitionrun", (event) => {
        if (event.target instanceof Element && event.target.matches(".companion-stickers, .companion-attach")) {
          window.__composerTransitions.push(event.propertyName);
        }
      }, true);
      const viewport = new EventTarget();
      Object.assign(viewport, {
        width: 390,
        height: 844,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      if (mode === "virtualKeyboard") {
        const keyboard = new EventTarget();
        Object.assign(keyboard, {
          overlaysContent: false,
          boundingRect: { x: 0, y: 844, width: 0, height: 0 },
        });
        Object.defineProperty(navigator, "virtualKeyboard", {
          configurable: true,
          value: keyboard,
        });
        window.setFixtureKeyboard = (open) => {
          keyboard.boundingRect = open
            ? { x: 0, y: 500, width: 390, height: 344 }
            : { x: 0, y: 844, width: 0, height: 0 };
          keyboard.dispatchEvent(new Event("geometrychange"));
        };
      } else {
        window.setFixtureKeyboard = (open) => {
          viewport.height = open ? 500 : 844;
          viewport.dispatchEvent(new Event("resize"));
        };
      }
    }, mode);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(origin);
    const input = page.locator("#companion-textarea");
    const nav = page.locator(".companion-bottom-nav");
    const shell = page.locator(".companion-composer");
    const stickers = page.locator(".companion-stickers");
    const attach = page.locator(".companion-attach");
    await expect(input).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(page.locator(".companion-microphone")).toHaveCount(0);
    await expect(stickers).toBeVisible();
    await expect(attach).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(5);
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.locator('.companion-nav-item:not([aria-current])')).toHaveCount(4);
    const navColors = await nav.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button.firstElementChild).color),
    );
    expect(navColors[0]).not.toBe(navColors[1]);
    const collapsed = await page.evaluate(() => {
      const rect = (selector) =>
        document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        input: rect("#companion-textarea"),
        stickers: rect(".companion-stickers"),
        attach: rect(".companion-attach"),
      };
    });
    expect(collapsed.input.height).toBeGreaterThanOrEqual(48);
    for (const button of [collapsed.stickers, collapsed.attach]) {
      expect(button.width).toBeCloseTo(collapsed.input.height, 0);
      expect(button.height).toBeCloseTo(collapsed.input.height, 0);
      expect((button.top + button.bottom) / 2).toBeCloseTo(
        (collapsed.input.top + collapsed.input.bottom) / 2,
        0,
      );
    }
    expect(collapsed.stickers.left - collapsed.input.right).toBeGreaterThanOrEqual(8);
    expect(collapsed.stickers.left - collapsed.input.right).toBeLessThanOrEqual(12);
    expect(collapsed.attach.left).toBeGreaterThanOrEqual(collapsed.input.right);
    const inputSurface = await input.evaluate((node) => {
      const style = getComputedStyle(node.closest(".k-glass"));
      return {
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
        inputShadow: getComputedStyle(node).boxShadow,
      };
    });
    expect(inputSurface).toEqual({ backgroundImage: "none", boxShadow: "none", inputShadow: "none" });
    for (const button of [
      page.locator(".companion-nav-item").first(),
      stickers,
      attach,
    ]) {
      const icon = button.locator("svg").first();
      const before = await icon.boundingBox();
      const bounds = await button.boundingBox();
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.down();
      if (mode !== "viewport-ios") {
        const wave = button.locator(".k-touch-ripple-wave");
        await expect(wave).toHaveCount(1);
        await expect
          .poll(() => wave.evaluate((el) => getComputedStyle(el).position))
          .toBe("absolute");
      }
      const during = await icon.boundingBox();
      expect(Math.abs(during.y - before.y)).toBeLessThan(1);
      expect(Math.abs(during.height - before.height)).toBeLessThan(1);
      const frameworkWave = button.locator(".ripple-wave");
      await expect(frameworkWave).toHaveCount(0);
      await expect(button).not.toHaveClass(/active-state/);
      await page.mouse.move(1, 1);
      await page.mouse.up();
    }
    await input.focus();
    if (mode === "viewport-ios") {
      // Focus must enter editing mode even when iOS reports no viewport resize.
      await expect(nav).toBeHidden();
      await expect(stickers).toHaveAttribute("aria-hidden", "true");
      await expect(attach).toHaveAttribute("aria-hidden", "true");
    }
    if (mode !== "desktop") {
      await page.evaluate(() => window.setFixtureKeyboard(true));
      await expect(nav).toBeHidden();
      await expect(shell).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(shell).toHaveCSS("box-shadow", "none");
      await expect(shell).toHaveCSS("backdrop-filter", "none");
    }
    await expect.poll(() => page.evaluate(() => window.__composerTransitions.includes("width"))).toBe(true);
    await expect.poll(() => input.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(collapsed.input.width + 50);
    await expect(stickers).toHaveAttribute("aria-hidden", "true");
    await expect(attach).toHaveAttribute("aria-hidden", "true");
    expect(await stickers.evaluate((el) => el.inert)).toBe(true);
    const single = await input.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    await input.fill("第一行\n第二行\n第三行\n第四行");
    await expect
      .poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(single);
    await input.fill(
      Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
    );
    await expect
      .poll(() =>
        input.evaluate((el) => ({
          height: el.clientHeight,
          scroll: el.scrollHeight,
        })),
      )
      .toEqual(expect.objectContaining({ height: 144 }));
    const expanded = await input.evaluate((el) => ({
      height: el.clientHeight,
      scroll: el.scrollHeight,
      value: el.value,
    }));
    expect(expanded.scroll).toBeGreaterThan(expanded.height);
    expect(expanded.value).toContain("第 30 行");
    await expect(page.locator(".companion-microphone")).toHaveCount(0);
    await expect(stickers).toBeHidden();
    await expect(attach).toBeHidden();
    await input.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await input.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await input.fill("短文本");
    await expect
      .poll(() => input.evaluate((el) => el.clientHeight))
      .toBe(single);
    await input.fill(expanded.value);
    await expect.poll(() => input.evaluate((el) => el.clientHeight)).toBe(144);
    if (mode !== "desktop") {
      await page.evaluate(() => window.setFixtureKeyboard(false));
      await expect(nav).toBeVisible();
      await expect(stickers).toBeVisible();
      await expect(attach).toBeVisible();
      await expect
        .poll(() => input.evaluate((el) => el.clientHeight))
        .toBe(single);
      const preview = page.locator(".companion-composer-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("…");
      await expect(preview).toHaveAttribute("aria-hidden", "true");
      await input.click();
      if (mode === "viewport-ios") {
        // The input can stay focused when iOS dismisses the keyboard.
        await expect(nav).toBeHidden();
        await expect(stickers).toHaveAttribute("aria-hidden", "true");
      }
      await page.evaluate(() => window.setFixtureKeyboard(true));
      await expect(nav).toBeHidden();
      await expect(input).toHaveValue(expanded.value);
      await expect
        .poll(() => input.evaluate((el) => el.clientHeight))
        .toBe(144);
      await input.fill("很长的内容".repeat(40));
      await expect
        .poll(() => input.evaluate((el) => el.clientHeight))
        .toBe(144);
      await page.evaluate(() => window.setFixtureKeyboard(false));
      await expect(nav).toBeVisible();
      await expect
        .poll(() => preview.evaluate((el) => el.scrollWidth > el.clientWidth))
        .toBe(true);
      await expect
        .poll(() => preview.evaluate((el) => getComputedStyle(el).textOverflow))
        .toBe("ellipsis");
    } else {
      await expect(nav).toBeVisible();
      await page.evaluate(() => window.setFixtureKeyboard(true));
      await expect(nav).toBeVisible();
      const draft = await input.inputValue();
      await input.blur();
      await expect(stickers).toHaveAttribute("aria-hidden", "false");
      await input.focus();
      await expect(stickers).toHaveAttribute("aria-hidden", "true");
      await input.blur();
      await expect(stickers).toBeVisible();
      await expect(stickers).toHaveAttribute("aria-hidden", "false");
      await expect(input).toHaveValue(draft);
    }
    expect(errors).toEqual([]);
    console.log(`${mode}: passed`);
    await context.close();
  }
  const reduced = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(origin);
  const reducedInput = reducedPage.locator("#companion-textarea");
  await reducedInput.focus();
  const reducedSticker = reducedPage.locator(".companion-stickers");
  await expect(reducedSticker).toHaveAttribute("aria-hidden", "true");
  const timing = await reducedSticker.evaluate((el) => ({
    durations: getComputedStyle(el).transitionDuration,
    delays: getComputedStyle(el).transitionDelay,
    inert: el.inert,
  }));
  expect(timing.durations.split(",").every((value) => parseFloat(value) <= 0.001)).toBe(true);
  expect(timing.delays.split(",").every((value) => parseFloat(value) === 0)).toBe(true);
  expect(timing.inert).toBe(true);
  await reduced.close();
  console.log("reduced motion: passed");
} finally {
  await browser.close();
  for (const ws of channels.keys()) ws.terminate();
  host.close();
  server.stop(true);
}
