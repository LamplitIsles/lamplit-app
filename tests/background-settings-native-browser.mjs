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
  const draft = page.locator("#companion-textarea");
  await expect(draft).toBeVisible();
  await draft.fill("背景切换保留草稿");
  const imageBytes = async (width, height, color) =>
    Buffer.from(
      await page.evaluate(
        ({ width, height, color }) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = color;
          context.fillRect(0, 0, width, height);
          return canvas.toDataURL("image/png").split(",")[1];
        },
        { width, height, color },
      ),
      "base64",
    );
  const landscape = await imageBytes(400, 200, "#3468bd");
  const portrait = await imageBytes(200, 400, "#df9655");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const screen = page.locator(".settings-screen");
  await screen.getByRole("button", { name: "外观", exact: true }).click();
  const wideInput = screen.locator('input[type="file"][aria-label="横屏"]');
  const tallInput = screen.locator('input[type="file"][aria-label="竖屏"]');
  await expect(wideInput).toBeEnabled();
  await wideInput.setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: landscape,
  });
  await expect(screen.locator(".background-configured")).toHaveCount(1);
  const first = await page.evaluate(async () => {
    const info = await (await fetch("/api/background-settings")).json();
    const results = await Promise.all(
      ["landscape", "portrait"].map(async (kind) => {
        const response = await fetch(`/api/backgrounds/${kind}`);
        return {
          type: response.headers.get("content-type"),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        };
      }),
    );
    return { info, results };
  });
  expect(first.info).toEqual({ landscape: true, portrait: false });
  for (const value of first.results) {
    expect(value.type).toBe("image/webp");
    expect(Buffer.from(value.bytes).subarray(0, 4).toString()).toBe("RIFF");
    expect(Buffer.from(value.bytes).subarray(8, 12).toString()).toBe("WEBP");
  }
  expect(first.results[0].bytes).toEqual(first.results[1].bytes);
  await expect(page.locator(".companion-background-landscape")).toHaveCount(1);
  await tallInput.setInputFiles({
    name: "tall.png",
    mimeType: "image/png",
    buffer: portrait,
  });
  await expect(screen.locator(".background-configured")).toHaveCount(2);
  await page.reload();
  await expect(screen.locator(".background-configured")).toHaveCount(2);
  await expect(
    screen.locator(".background-configured img").first(),
  ).toHaveJSProperty("complete", true);
  expect(
    await screen
      .locator(".background-configured img")
      .first()
      .evaluate((img) => img.naturalWidth),
  ).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await context.close();
  console.log(
    "background integration: fake CFL, WebP conversion, one-slot fallback and persistence passed",
  );
} finally {
  await browser.close();
}
