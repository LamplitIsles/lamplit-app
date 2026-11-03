// Run only against the test-owned CFL model-preference-host fixture.
import { chromium, expect } from "@playwright/test";
import { denyNativeNotifications } from "./notification-permission.mjs";
const origin = process.env.CFL_TEST_ORIGIN;
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("Expected loopback CFL_TEST_ORIGIN fixture");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  await context.addInitScript(denyNativeNotifications);
  await context.addCookies([
    { name: "model-test-owner", value: "1", url: origin, sameSite: "Strict" },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin);
  await expect(page.locator("#companion-textarea")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const screen = page.locator(".settings-screen");
  await screen.getByRole("button", { name: "语音输入" }).click();
  await screen.locator("#voice-region").selectOption("singapore");
  await screen.locator("#voice-key").fill("synthetic-voice-key");
  await screen.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    screen.getByText("留空则保留当前 Key。", { exact: true }),
  ).toBeVisible();
  await expect(screen.locator("#voice-key")).toHaveValue("");
  const value = await page.evaluate(async () => {
    const settings = await (await fetch("/api/voice/settings")).json();
    const capability = await (await fetch("/api/voice/capability")).json();
    return { settings, capability };
  });
  expect(value).toEqual({
    settings: { region: "singapore", configured: true },
    capability: { available: true },
  });
  await page.reload();
  await expect(screen.locator("#voice-region")).toHaveValue("singapore");
  await expect(screen.locator("#voice-key")).toHaveValue("");
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole("button", { name: "开始录音" })).toBeEnabled();
  expect(errors).toEqual([]);
  await context.close();
  console.log(
    "settings integration: fake CFL, synthetic key, persistence and capability passed",
  );
} finally {
  await browser.close();
}
