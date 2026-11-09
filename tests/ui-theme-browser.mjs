import { chromium, devices, expect } from "@playwright/test";
import { createSettingsHost } from "./settings-host.mjs";

const server = await createSettingsHost();
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const userAgent of [
    devices["iPhone 13"].userAgent,
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
  ]) {
    const context = await browser.newContext({ locale: "zh-CN", userAgent });
    const page = await context.newPage();
    await page.goto(origin);
    await expect(page.locator("#companion-textarea")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/\bios\b/);
    await expect(page.locator(".k-app").first()).toHaveClass(/\bk-ios\b/);
    const label = page
      .locator(".companion-nav-item")
      .first()
      .locator("span")
      .last();
    await expect(label).toBeVisible();
    expect((await label.boundingBox()).height).toBeGreaterThanOrEqual(14);
    await context.close();
  }

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    userAgent: devices["iPhone 13"].userAgent,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin);
  const draft = page.locator("#companion-textarea");
  await expect(draft).toBeVisible();
  await draft.fill("切换风格前的草稿");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.locator(".settings-screen");
  await settings.getByRole("button", { name: "外观", exact: true }).click();
  await expect(settings.getByText("界面风格", { exact: true })).toBeVisible();
  const ios = settings.locator('input[name="companion-ui-theme"][value="ios"]');
  const material = settings.locator(
    'input[name="companion-ui-theme"][value="material"]',
  );
  await expect(ios).toBeChecked();
  await settings
    .locator('input[name="companion-appearance"][value="dark"]')
    .locator("xpath=ancestor::label[1]")
    .click();
  await material.locator("xpath=ancestor::label[1]").click();
  await expect(page.locator("html")).toHaveClass(/\bmd\b/);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.locator(".k-app").first()).toHaveClass(/\bk-material\b/);
  await expect(material).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("her.companion.ui-theme")),
    )
    .toBe("material");

  const embedded = await context.newPage();
  await embedded.goto(`${origin}/a2ui.html`);
  await expect(embedded.locator(".k-app")).toHaveClass(/\bk-material\b/);
  await ios.locator("xpath=ancestor::label[1]").click();
  await expect(page.locator("html")).toHaveClass(/\bios\b/);
  await expect(embedded.locator(".k-app")).toHaveClass(/\bk-ios\b/);
  await material.locator("xpath=ancestor::label[1]").click();
  await page.goBack();
  await page.goBack();
  await expect(draft).toHaveValue("切换风格前的草稿");
  const navLabel = page
    .locator(".companion-nav-item")
    .first()
    .locator("span")
    .last();
  await expect(navLabel).toBeVisible();
  expect((await navLabel.boundingBox()).height).toBeGreaterThanOrEqual(14);
  await page.reload();
  await expect(page.locator(".k-app").first()).toHaveClass(/\bk-material\b/);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect(errors).toEqual([]);
  await context.close();

  const invalid = await browser.newContext({ locale: "en-US" });
  await invalid.addInitScript(() =>
    localStorage.setItem("her.companion.ui-theme", "unexpected"),
  );
  const invalidPage = await invalid.newPage();
  await invalidPage.goto(`${origin}/#/settings/appearance`);
  await expect(
    invalidPage.getByText("Interface style", { exact: true }),
  ).toBeVisible();
  await expect(
    invalidPage.locator('input[name="companion-ui-theme"][value="ios"]'),
  ).toBeChecked();
  await expect(invalidPage.locator("html")).toHaveClass(/\bios\b/);
  await invalid.close();
  console.log(
    "UI theme: default, live switch, persistence, A2UI sync and dark mode passed",
  );
} finally {
  await browser.close();
  await server.close();
}
