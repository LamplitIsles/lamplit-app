import { createUiTestHost } from "./ui-test-host.ts";
import { submissionsFixture } from "./submissions-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { imageHttp } from "../packages/contracts/src/server.ts";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host needs test-owned submission control URL");
const fixture = submissionsFixture();
const host = await createUiTestHost(fixture.backend);
const channels = new Map();
const server = external ? undefined : Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/__test/submissions") {
      const result = await fixture.control(await req.json());
      await host.publish();
      return Response.json(result);
    }
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    const response = await imageHttp(req, fixture.imageBackend, async () => ({
      sessionId: "fixture-session",
      limits: fixture.limits,
    }));
    return response ?? staticAssets(resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build"), path);
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
const controlUrl = process.env.APP_ACCEPTANCE_CONTROL_URL ?? new URL("/__test/submissions", url).href;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
      httpCredentials: process.env.APP_ACCEPTANCE_USERNAME
        ? { username: process.env.APP_ACCEPTANCE_USERNAME, password: process.env.APP_ACCEPTANCE_PASSWORD ?? "" }
        : undefined,
    });
    const control = async (input) =>
      (
        await context.request.post(
          controlUrl,
          { data: input },
        )
      ).json();
    await control({ action: "reset" });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url);
    const input = page.locator("#companion-textarea");
    const bubble = (text) =>
      page.locator(".k-message.outgoing").filter({ hasText: text });
    const menuAction = (name) =>
      page
        .locator(".companion-action-menu")
        .getByRole("button", { name, exact: true });
    await expect(input).toBeEditable();
    await control({ action: "mode", state: "slow", hidden: true });
    await input.fill("暂未确认的消息");
    await input.press("Enter");
    await expect(bubble("暂未确认的消息")).toHaveCount(1);
    await expect(bubble("暂未确认的消息").getByRole("status")).toHaveCount(0);
    await expect(page.getByTestId("input-recovery")).toHaveCount(0);
    await expect
      .poll(async () => (await control({ action: "state" })).submitCalls)
      .toBe(1);
    await control({ action: "release" });
    await expect
      .poll(async () => (await control({ action: "state" })).submissions.length)
      .toBe(1);
    await control({ action: "publish" });
    await expect(bubble("暂未确认的消息")).toHaveCount(1);
    await control({ action: "complete" });
    await control({ action: "mode", state: "null", hidden: true });
    await input.fill("断线后仍需核对");
    await input.press("Enter");
    await expect
      .poll(async () => (await control({ action: "state" })).submitCalls)
      .toBe(2);
    await page.reload();
    await expect(bubble("断线后仍需核对")).toHaveCount(1);
    await expect(bubble("断线后仍需核对").getByRole("status")).toHaveCount(0);
    expect((await control({ action: "state" })).submitCalls).toBe(2);
    if (process.env.APP_ACCEPTANCE_EVIDENCE)
      await page.screenshot({
        path: `${process.env.APP_ACCEPTANCE_EVIDENCE}/delivery-unknown-${width}.png`,
      });
    await bubble("断线后仍需核对").getByTestId(/remove-pending-/).click();
    await menuAction("从本机移除").click();
    await expect(page.getByTestId("message-action-menu")).toHaveCount(0);
    await expect(bubble("断线后仍需核对")).toHaveCount(0);
    expect((await control({ action: "state" })).submitCalls).toBe(2);
    await control({ action: "mode", state: "failed" });
    await input.fill("明确失败的消息");
    await input.press("Enter");
    const failed = bubble("明确失败的消息").getByTestId(/failed-/);
    await expect(failed).toBeVisible();
    if (process.env.APP_ACCEPTANCE_EVIDENCE)
      await page.screenshot({
        path: `${process.env.APP_ACCEPTANCE_EVIDENCE}/delivery-failed-${width}.png`,
      });
    await input.fill("保留的新草稿");
    await failed.click();
    await control({ action: "mode", state: "submitted" });
    await menuAction("重试").click();
    await expect(failed).toHaveCount(0);
    await expect(bubble("明确失败的消息")).toHaveCount(1);
    await expect(input).toHaveValue("保留的新草稿");
    await control({ action: "mode", state: "failed" });
    await input.fill("丢弃的失败消息");
    await input.press("Enter");
    await bubble("丢弃的失败消息")
      .getByTestId(/failed-/)
      .click();
    await menuAction("删除").click();
    await menuAction("删除").click();
    await expect(bubble("丢弃的失败消息")).toHaveCount(0);
    await page.reload();
    await expect(bubble("丢弃的失败消息")).toHaveCount(0);
    await expect(page.getByTestId("input-recovery")).toHaveCount(0);
    await control({ action: "mode", state: "queued" });
    await input.fill("停止时排队的消息");
    await input.press("Enter");
    const queued = bubble("停止时排队的消息");
    await expect(queued).toHaveCount(1);
    await expect(queued.getByTestId(/failed-/)).toHaveCount(0);
    await page.getByTestId("companion-stop").click();
    const stopped = queued.getByTestId(/failed-/);
    await expect(stopped).toBeVisible();
    await stopped.click();
    await control({ action: "mode", state: "submitted" });
    await menuAction("重试").click();
    await expect(stopped).toHaveCount(0);
    await expect(queued).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (process.env.APP_ACCEPTANCE_EVIDENCE)
      await page.screenshot({
        path: `${process.env.APP_ACCEPTANCE_EVIDENCE}/delivery-${width}.png`,
      });
    await context.close();
  }
  console.log(
    "Browser delivery: optimistic display, reload without replay, explicit retry and local discard passed on mobile and desktop.",
  );
} finally {
  await browser.close();
  host.close();
  server?.stop(true);
}
