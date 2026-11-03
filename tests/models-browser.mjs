import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const fixture = fixtureBackend();
const host = await createChatHost(fixture.backend);
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
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
const evidence = ".scratch/dashboard-model-selector/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript(denyNativeNotifications);
    let currentModel = "gpt-6.1-sol",
      fast = true,
      busy = false,
      mode = "normal",
      posts = 0,
      gets = 0,
      release;
    const state = () => ({
      sessionId: "fixture-session",
      currentModel,
      fast,
      busy,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/api/chat/models", async (route) => {
      if (route.request().method() === "GET") gets++;
      if (mode === "unsupported") return route.fulfill({ status: 404 });
      if (mode === "load-failure") return route.fulfill({ status: 503 });
      if (route.request().method() === "POST") {
        posts++;
        const input = route.request().postDataJSON();
        expect(input.sessionId).toBe("fixture-session");
        expect(input.expectedModel).toBe(currentModel);
        expect(input.expectedFast).toBe(fast);
        if (mode === "stale")
          return route.fulfill({
            status: 409,
            json: { error: { code: "stale_model" } },
          });
        if (mode === "pending")
          await new Promise((resolve) => {
            release = resolve;
          });
        currentModel = input.model;
        fast = input.fast;
        if (mode === "ambiguous") return route.abort("failed");
      }
      if (mode === "loading")
        await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({ json: state() });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const draft = page.locator("#companion-textarea");
    await expect(draft).toBeVisible();
    await draft.fill("保留这个草稿");
    const panel = page.locator("#companion-preferences-panel");
    const radio = (id) =>
      panel.locator(`input[name="companion-model"][value="${id}"]`);
    const choose = (id) =>
      radio(id).locator("xpath=ancestor::label[1]").click();
    const reload = panel.getByRole("button", { name: "刷新", exact: true });
    const fastSwitch = panel.getByRole("switch", { name: "Fast" });
    const open = () =>
      page.getByRole("button", { name: "设置", exact: true }).click();
    mode = "loading";
    await open();
    await expect(
      panel.getByText("正在加载设置…", { exact: true }),
    ).toBeVisible();
    await expect(radio(currentModel)).toBeChecked();
    await expect(fastSwitch).toBeChecked();
    await expect(panel.locator('input[name="companion-model"]')).toHaveCount(3);
    await expect(radio("gpt-6.1-sol")).toHaveAccessibleName("6.1 sol");
    await expect(radio("gpt-5.6-sol")).toHaveAccessibleName("5.6 sol");
    await expect(radio("gpt-6.1-terra")).toHaveAccessibleName("6.1 terra");
    await expect(panel.getByRole("button", { name: "切换模型" })).toHaveCount(
      0,
    );
    await expect(reload).toHaveCount(0);
    mode = "pending";
    await choose("gpt-5.6-sol");
    await expect.poll(() => posts).toBe(1);
    await expect(radio("gpt-5.6-sol")).toBeDisabled();
    await expect(fastSwitch).toBeDisabled();
    await expect(radio("gpt-6.1-sol")).toBeChecked();
    await expect(radio("gpt-5.6-sol")).not.toBeChecked();
    const getsBeforeReopen = gets;
    await page.keyboard.press("Escape");
    await open();
    await expect(radio("gpt-6.1-sol")).toBeChecked();
    await expect(radio("gpt-5.6-sol")).toBeDisabled();
    await expect(fastSwitch).toBeDisabled();
    expect(gets).toBe(getsBeforeReopen);
    release();
    mode = "normal";
    await expect(radio("gpt-5.6-sol")).toBeChecked();
    await expect(panel.locator("#model-status")).toHaveCount(0);
    await expect(
      panel.getByText("从下一次回复开始生效。", { exact: true }),
    ).toHaveCount(0);
    const optionHeight = await panel
      .locator(".model-options")
      .evaluate((el) => el.getBoundingClientRect().height);
    const radioHeight = await panel
      .locator('input[value="dark"]')
      .locator("xpath=ancestor::label[1]")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(optionHeight - radioHeight)).toBeLessThan(1);
    for (const bounds of await panel
      .locator(".model-option")
      .evaluateAll((nodes) =>
        nodes.map((el) => ({
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        })),
      )) {
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await panel.locator(".model-option svg").first().getAttribute("width"),
    ).toBe("14");
    const spacing = await panel.locator(".model-settings").evaluate((el) => {
      const row = el.querySelector(".model-options").getBoundingClientRect();
      const nextGroup = el.nextElementSibling.getBoundingClientRect();
      return nextGroup.top - row.bottom;
    });
    expect(spacing).toBeGreaterThanOrEqual(6);
    expect(spacing).toBeLessThanOrEqual(12);
    await page.screenshot({ path: `${evidence}/${width}-saved.png` });
    await choose("gpt-5.6-sol");
    expect(posts).toBe(1);
    mode = "pending";
    await fastSwitch.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => posts).toBe(2);
    await expect(fastSwitch).toBeChecked();
    await expect(fastSwitch).toBeDisabled();
    await expect(radio("gpt-5.6-sol")).toBeDisabled();
    await page.keyboard.press("Escape");
    await open();
    await expect(fastSwitch).toBeChecked();
    await expect(fastSwitch).toBeDisabled();
    await expect(radio("gpt-5.6-sol")).toBeDisabled();
    release();
    mode = "normal";
    await expect(fastSwitch).not.toBeChecked();
    await fastSwitch.locator("xpath=ancestor::label[1]").click();
    await expect(fastSwitch).toBeChecked();
    expect(posts).toBe(3);
    mode = "ambiguous";
    await fastSwitch.locator("xpath=ancestor::label[1]").click();
    await expect(panel.getByRole("status")).toContainText("尚未确认设置");
    await expect(fastSwitch).toBeChecked();
    await expect(fastSwitch).toBeDisabled();
    mode = "normal";
    await reload.click();
    await expect(fastSwitch).not.toBeChecked();
    expect(posts).toBe(4);
    await fastSwitch.locator("xpath=ancestor::label[1]").click();
    await expect(fastSwitch).toBeChecked();
    expect(posts).toBe(5);
    await page.keyboard.press("Escape");
    await expect(draft).toHaveValue("保留这个草稿");
    await open();
    await expect(radio("gpt-5.6-sol")).toBeChecked();
    await expect(fastSwitch).toBeChecked();
    mode = "ambiguous";
    await radio("gpt-6.1-sol").focus();
    await page.keyboard.press("Space");
    await expect(panel.getByRole("status")).toContainText("尚未确认设置");
    await expect(radio("gpt-6.1-sol")).toBeDisabled();
    expect(posts).toBe(6);
    mode = "normal";
    await reload.click();
    await expect(radio("gpt-6.1-sol")).toBeChecked();
    expect(posts).toBe(6);
    mode = "stale";
    await choose("gpt-6.1-terra");
    await expect(panel.getByRole("status")).toContainText("设置已更新");
    await expect(radio("gpt-6.1-sol")).toBeChecked();
    mode = "load-failure";
    await reload.click();
    await expect(panel.getByRole("status")).toContainText("无法加载设置");
    mode = "normal";
    busy = true;
    await reload.click();
    await expect(radio("gpt-6.1-sol")).toBeDisabled();
    await expect(panel.getByRole("status")).toContainText("正在处理对话");
    await page.screenshot({ path: `${evidence}/${width}-busy.png` });
    const bounds = await panel.locator(".popover-inner").boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    busy = false;
    await reload.click();
    await expect(radio("gpt-6.1-sol")).toBeEnabled();
    await choose("gpt-6.1-terra");
    await expect(radio("gpt-6.1-terra")).toBeChecked();
    await panel
      .locator('input[value="dark"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: `${evidence}/${width}-dark.png` });
    await panel
      .locator('input[value="en"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect(
      panel.getByRole("radiogroup", { name: "Model", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${evidence}/${width}-english.png` });
    await page.keyboard.press("Escape");
    currentModel = "legacy-model";
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      panel.getByText("Current: legacy-model", { exact: true }),
    ).toBeVisible();
    await expect(fastSwitch).toBeDisabled();
    await expect(
      panel.getByText("Choose a supported model to change Fast."),
    ).toBeVisible();
    await expect(
      panel.locator('input[name="companion-model"]:checked'),
    ).toHaveCount(0);
    await choose("gpt-6.1-sol");
    await expect(radio("gpt-6.1-sol")).toBeChecked();
    await expect(fastSwitch).toBeEnabled();
    await page.keyboard.press("Escape");
    mode = "unsupported";
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(panel.locator('input[name="companion-model"]')).toHaveCount(0);
    await expect(fastSwitch).toHaveCount(0);
    await expect(panel.getByText("Appearance", { exact: true })).toBeVisible();
    expect(posts).toBe(9);
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    `PASS model radios: mobile/desktop, three fixed choices, direct/confirmed save, pending, reopen, draft, keyboard, busy, stale, ambiguous result, reload, unsupported, zh/en; ${evidence}`,
  );
} finally {
  await browser.close();
  for (const channel of channels.values()) channel.close();
  server.stop(true);
  await host.close();
}
