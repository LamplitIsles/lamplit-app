import { chromium, expect } from "@playwright/test";
import { createSettingsHost } from "./settings-host.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { mkdir } from "node:fs/promises";

const server = await createSettingsHost();
const evidence = ".scratch/settings-page/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    let model = "gpt-6.1-sol",
      fast = true;
    let voiceInputRequests = 0;
    await page.route("**/api/voice/**", (route) => {
      voiceInputRequests++;
      return route.fulfill({ status: 404 });
    });
    await page.route("**/api/chat/models", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        model = body.model;
        fast = body.fast;
      }
      await route.fulfill({
        json: {
          sessionId: "fixture-session",
          currentModel: model,
          fast,
          busy: false,
        },
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const draft = page.locator("#companion-textarea");
    await expect(draft).toBeVisible();
    await draft.fill("保留草稿");
    const settings = page.locator(".settings-screen");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(settings.getByRole("button", { name: "外观" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "模型" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "语音输入" })).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/${width}-home.png` });
    await settings.getByRole("button", { name: "外观" }).click();
    await expect(settings.getByText("主题", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(settings.getByRole("button", { name: "外观" })).toBeVisible();
    await settings.getByRole("button", { name: "模型" }).click();
    const radio = settings.locator(
      'input[name="companion-model"][value="gpt-5.6-sol"]',
    );
    await radio.locator("xpath=ancestor::label[1]").click();
    await expect(radio).toBeChecked();
    await settings.getByRole("button", { name: "返回" }).click();
    await expect(settings.getByRole("button", { name: "语音输入" })).toHaveCount(0);
    await page.goBack();
    await expect(draft).toHaveValue("保留草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "外观" }).click();
    await settings
      .locator('input[name="companion-appearance"][value="dark"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.goBack();
    const appearanceCard = settings.getByRole("button", { name: "外观" });
    await expect
      .poll(async () => {
        const icon = await appearanceCard.locator("svg").first().boundingBox();
        const label = await appearanceCard
          .locator("span:not(.ripple-wave)")
          .boundingBox();
        return icon && label && icon.y < label.y;
      })
      .toBe(true);
    await page.screenshot({ path: `${evidence}/${width}-dark.png` });
    expect(voiceInputRequests).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }
  const directContext = await browser.newContext({ locale: "zh-CN" });
  await directContext.addInitScript(denyNativeNotifications);
  const direct = await directContext.newPage();
  await direct.goto(`http://127.0.0.1:${server.port}/#settings/appearance`);
  const directScreen = direct.locator(".settings-screen");
  await expect(directScreen.getByText("主题", { exact: true })).toBeVisible();
  await direct.reload();
  await direct.goBack();
  await expect(
    directScreen.getByRole("button", { name: "外观" }),
  ).toBeVisible();
  await direct.goBack();
  const directDraft = direct.locator("#companion-textarea");
  await expect(directDraft).toBeVisible();
  await directDraft.fill("直接打开后保留草稿");
  await direct.goForward();
  await expect(
    directScreen.getByRole("button", { name: "外观" }),
  ).toBeVisible();
  await direct.goForward();
  await expect(directScreen.getByText("主题", { exact: true })).toBeVisible();
  await directScreen.getByRole("button", { name: "返回" }).click();
  await expect(
    directScreen.getByRole("button", { name: "外观" }),
  ).toBeVisible();
  await directScreen.getByRole("button", { name: "返回" }).click();
  await expect(directDraft).toHaveValue("直接打开后保留草稿");
  await direct.goto(`http://127.0.0.1:${server.port}/chat#settings/appearance`);
  await expect(directScreen.getByText("主题", { exact: true })).toBeVisible();
  await direct.goBack();
  await expect(
    directScreen.getByRole("button", { name: "外观" }),
  ).toBeVisible();
  await direct.goBack();
  await expect(directDraft).toBeVisible();
  expect(new URL(direct.url()).pathname).toBe("/chat");
  await direct.goBack();
  await expect(directDraft).toBeVisible();
  expect(new URL(direct.url()).pathname).toBe("/");
  // Old bookmarks lead to settings rather than an inaccessible recording page.
  await direct.goto(`http://127.0.0.1:${server.port}/#settings/voice`);
  await expect(directScreen.getByRole("button", { name: "外观" })).toBeVisible();
  await expect(directScreen.getByRole("button", { name: "语音输入" })).toHaveCount(0);
  await directContext.close();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  await context.addInitScript(denyNativeNotifications);
  const page = await context.newPage();
  await page.route("**/api/chat/models", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const unsupported = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat/models"),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await unsupported;
  const screen = page.locator(".settings-screen");
  await expect(screen.getByRole("button", { name: "外观" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "模型" })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "语音输入" })).toHaveCount(0);
  await context.close();
  console.log("settings browser: 390px, 1280px, and unsupported host passed");
} finally {
  await browser.close();
  await server.close();
}
