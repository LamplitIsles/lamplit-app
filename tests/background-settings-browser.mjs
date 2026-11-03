import { chromium, expect } from "@playwright/test";
import { createSettingsHost } from "./settings-host.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { mkdir } from "node:fs/promises";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);
const server = await createSettingsHost();
const evidence = ".scratch/settings-page/backgrounds";
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
    let snapshot = { landscape: false, portrait: false };
    let backgroundGets = 0,
      imageGets = 0,
      postCount = 0,
      release,
      held = false,
      ambiguous = false,
      failAppearance = false;
    await page.route("**/api/background-settings**", async (route) => {
      const method = route.request().method();
      if (method === "GET") backgroundGets++;
      if (method === "POST") {
        postCount++;
        expect(route.request().headers()["content-type"]).toBe("image/png");
        expect(route.request().postDataBuffer()).toEqual(png);
        const kind = new URL(route.request().url()).pathname.split("/").pop();
        if (held)
          await new Promise((resolve) => {
            release = resolve;
          });
        snapshot = { ...snapshot, [kind]: true };
        if (ambiguous) return route.abort("failed");
      }
      return route.fulfill({ json: snapshot });
    });
    await page.route("**/api/backgrounds/*", (route) => {
      imageGets++;
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "cache-control": "no-store" },
        body: png,
      });
    });
    await page.route("**/api/chat/appearance", (route) => {
      if (failAppearance) return route.fulfill({ status: 503 });
      return route.fulfill({
        json: {
          companionName: "Mica",
          userName: "",
          ...(snapshot.landscape || snapshot.portrait
            ? {
                backgrounds: {
                  landscape: "/api/backgrounds/landscape",
                  portrait: "/api/backgrounds/portrait",
                },
              }
            : {}),
        },
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const draft = page.locator("#companion-textarea");
    await expect(draft).toBeVisible();
    await draft.fill("留住这条草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.locator(".settings-screen");
    await settings.getByRole("button", { name: "外观", exact: true }).click();
    const landscape = settings.locator('input[type="file"][aria-label="横屏"]');
    const portrait = settings.locator('input[type="file"][aria-label="竖屏"]');
    await expect(landscape).toBeEnabled();
    await settings.locator(".background-settings").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/${width}-empty.png` });
    failAppearance = true;
    await landscape.setInputFiles({
      name: "wide.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(settings.locator(".background-configured")).toHaveCount(1);
    await expect(settings.getByRole("alert")).toContainText("无法刷新聊天背景");
    await settings.getByRole("alert").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/${width}-refresh-error.png` });
    expect(postCount).toBe(1);
    failAppearance = false;
    await settings.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    expect(postCount).toBe(1);
    await expect(page.locator(".companion-background-landscape")).toHaveCount(
      1,
    );
    await expect(page.locator(".companion-background-portrait")).toHaveCount(1);
    await page.locator(".companion-background-landscape").evaluate((el) => {
      el.dataset.beforeReplacement = "old";
    });
    const previousImages = imageGets;
    held = true;
    await portrait.setInputFiles({
      name: "tall.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(portrait).toBeDisabled();
    await expect.poll(() => postCount).toBe(2);
    const previousGets = backgroundGets;
    await page.goBack();
    await page.goBack();
    await expect(draft).toHaveValue("留住这条草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "外观", exact: true }).click();
    await expect(portrait).toBeDisabled();
    expect(backgroundGets).toBe(previousGets);
    held = false;
    release();
    await expect(settings.locator(".background-configured")).toHaveCount(2);
    await expect(
      page.locator(".companion-background-landscape"),
    ).not.toHaveAttribute("data-before-replacement");
    await expect.poll(() => imageGets).toBeGreaterThan(previousImages);
    await page.screenshot({ path: `${evidence}/${width}-saved.png` });
    ambiguous = true;
    await landscape.setInputFiles({
      name: "wide.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(settings.getByRole("alert")).toContainText("上传结果尚未确认");
    await expect(settings.locator(".background-configured")).toHaveCount(2);
    await expect(landscape).toBeDisabled();
    ambiguous = false;
    await settings.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(landscape).toBeEnabled();
    expect(postCount).toBe(3);
    expect(errors).toEqual([]);
    await context.close();
  }
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addInitScript(denyNativeNotifications);
  const page = await context.newPage();
  await page.route("**/api/background-settings**", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const unsupported = page.waitForResponse((response) =>
    response.url().endsWith("/api/background-settings"),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await unsupported;
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByRole("region", { name: "聊天背景" })).toHaveCount(0);
  await context.close();
  console.log(
    "background settings browser: 390px, 1280px and unsupported host passed",
  );
} finally {
  await browser.close();
  await server.close();
}
