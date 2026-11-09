import { chromium, expect } from "@playwright/test";
import { createSettingsHost } from "./settings-host.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";

const server = await createSettingsHost();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  await context.addInitScript(denyNativeNotifications);
  const page = await context.newPage();
  const errors = [];
  let sockets = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", () => sockets++);
  const base = `http://127.0.0.1:${server.port}`;
  await page.goto(`${base}/?fixture=keep`);
  const input = page.locator("#companion-textarea");
  await input.fill("导航时保留草稿");
  const initialSockets = sockets;
  for (const [id, hash] of [
    ["history", "memories"],
    ["diary", "diary"],
    ["images", "album"],
    ["alarms", "wake"],
  ]) {
    await page.locator(`#companion-${id}-tab`).click();
    await expect(page).toHaveURL(new RegExp(`\\?fixture=keep#/` + hash + `$`));
    await expect(page.locator("#companion-drawer-panel")).toBeVisible();
  }
  await page.goBack();
  await expect(page).toHaveURL(/#\/album$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/diary$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/album$/);
  await page.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(input).toHaveValue("导航时保留草稿");
  expect(sockets).toBe(initialSockets);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/appearance$/);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "外观", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(input).toHaveValue("导航时保留草稿");
  expect(sockets).toBe(initialSockets);

  for (const [path, tab] of [
    ["memories", "history"],
    ["diary", "diary"],
    ["album", "images"],
    ["wake", "alarms"],
  ]) {
    await page.goto(`${base}/#/` + path);
    await expect(page.locator(`#companion-${tab}-tab`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#companion-drawer-panel")).toBeVisible();
  }
  await page.goto(`${base}/#/diary`);
  await page.getByRole("button", { name: "2026-10-02", exact: true }).click();
  await expect(page).toHaveURL(/#\/diary\/2026-10-02\.md$/);
  await expect(page.getByRole("heading", { name: "灯火日记" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/diary$/);
  await expect(
    page.getByRole("button", { name: "2026-10-02", exact: true }),
  ).toBeVisible();
  await page.goto(`${base}/#/diary/2026-10-02.md`);
  await expect(page.getByRole("heading", { name: "灯火日记" })).toBeVisible();
  await page.getByRole("button", { name: /返回日记/ }).click();
  await expect(page).toHaveURL(/#\/diary$/);
  await page.goto(`${base}/#/diary/%zz`);
  await expect(page).toHaveURL(/#\/diary$/);
  await expect(
    page.getByRole("button", { name: "2026-10-02", exact: true }),
  ).toBeVisible();
  await page.goto(`${base}/#settings/voice`);
  await expect(
    page.getByRole("button", { name: "外观", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  expect(errors).toEqual([]);
  await context.close();
  console.log(
    "app navigation: deep links, history, settings, query and draft passed",
  );
} finally {
  await browser.close();
  await server.close();
}
