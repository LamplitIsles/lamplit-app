import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { compactFixture } from "./compact-fixture.ts";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const fixture = compactFixture();
const host = await createChatHost(fixture.backend, (e) => console.error(e));
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        const authorized =
          req.headers.get("cookie")?.includes("fixture-owner=1") === true;
        if (path === "/__test/quiet-compaction")
          return Response.json(await fixture.control(await req.json()));
        if (path === "/api/chat/socket") {
          if (!authorized) return new Response(null, { status: 401 });
          if (server.upgrade(req)) return;
        }
        if (path === "/__test/quiet-compaction/disconnect") {
          for (const channel of channels.values()) channel.disconnect();
          return Response.json({ disconnected: true });
        }
        return staticAssets(assets, path, {
          "Set-Cookie": "fixture-owner=1; Path=/; SameSite=Strict",
        });
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
  new URL("/__test/quiet-compaction", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/quiet-compaction/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const width of [390, 1280, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
      httpCredentials: process.env.APP_ACCEPTANCE_USERNAME
        ? {
            username: process.env.APP_ACCEPTANCE_USERNAME,
            password: process.env.APP_ACCEPTANCE_PASSWORD ?? "",
          }
        : undefined,
    });
    const control = async (input) => {
      const response = await context.request.post(controlUrl, { data: input });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await control({ action: "reset" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    const input = page.locator("#companion-textarea");
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    const ring = page.locator(".companion-context-meter");
    const status = page.getByTestId("companion-continuity-status");
    const failure = page.getByTestId("input-error");
    const silent = async () => {
      await expect(status).toHaveCount(0);
      await expect(
        page.locator('[data-testid^="continuity-record-"]'),
      ).toHaveCount(0);
      await expect(page.getByText("已整理对话", { exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator(".toast")).toHaveCount(0);
    };
    await expect(input).toBeVisible();
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    await ring.click();
    await expect(page.locator(".companion-context-summary")).toHaveText(
      "0 / 0 (0%)",
    );
    await page.keyboard.press("Escape");
    await control({ action: "usage", tokens: 50000, capacity: 100000 });
    await expect(ring).toHaveAttribute("aria-label", /50%/);
    await control({ action: "usage", tokens: null, capacity: 100000 });
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    await ring.click();
    await expect(page.locator(".companion-context-summary")).toHaveText(
      "0 / 100k (0%)",
    );
    await page.keyboard.press("Escape");
    await control({ action: "usage", tokens: 0, capacity: 100000 });
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    // Busy and native refusal preserve exact draft and never submit a user message.
    await control({ action: "busy", enabled: true });
    await input.fill("/compact");
    await send.click();
    await expect(input).toHaveValue("/compact");
    expect((await control({ action: "state" })).calls).toBe(0);
    await control({ action: "busy", enabled: false });
    await control({ action: "refuse", enabled: true });
    await send.click();
    await expect(input).toHaveValue("/compact");
    await expect(failure).toBeVisible();
    expect((await control({ action: "state" })).executions).toBe(0);
    await control({ action: "refuse", enabled: false });
    await control({ action: "usage", tokens: 90000, capacity: 100000 });
    // Existing suggestion completes the command. Native engine owns its execution.
    await input.fill("/comp");
    await page.locator("#companion-command-compact").click();
    await expect(input).toHaveValue("/compact");
    await send.click();
    await expect(status).toHaveAttribute("data-state", "running");
    await expect(input).toHaveValue("");
    await expect(send).toBeDisabled();
    await page.screenshot({
      path: `${evidence}/running-${width}.png`,
      fullPage: true,
    });
    expect((await control({ action: "state" })).executions).toBe(1);
    expect((await control({ action: "state" })).submissions).toEqual([]);
    await control({ action: "finish" });
    await silent();
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    await page.reload(); // historical completion stays silent, no stale usage
    await silent();
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    await control({ action: "usage", tokens: 12000, capacity: 100000 });
    await expect(ring).toHaveAttribute("aria-label", /12%/);
    await page.reload();
    await expect(ring).toHaveAttribute("aria-label", /12%/);
    await control({ action: "auto" });
    await expect(status).toHaveAttribute("data-state", "running");
    await control({ action: "finish", failed: true });
    await expect(status).toHaveAttribute("data-state", "failed");
    await page.screenshot({
      path: `${evidence}/failed-${width}.png`,
      fullPage: true,
    });
    await control({ action: "auto" });
    await control({ action: "finish" });
    await silent();
    await expect(ring).toHaveAttribute("aria-label", /0%/);
    // Lost response and reconnect only read native view. No automatic compact replay.
    await control({ action: "hold", enabled: true });
    await input.fill("/compact");
    await send.click();
    await expect(status).toHaveAttribute("data-state", "running");
    const calls = (await control({ action: "state" })).calls;
    const disconnected = await context.request.post(`${controlUrl}/disconnect`);
    expect(disconnected.ok()).toBe(true);
    await expect(input).toHaveValue("/compact");
    await control({ action: "release" });
    await control({ action: "finish" });
    await expect(send).toBeEnabled({ timeout: 10000 });
    await silent();
    expect((await control({ action: "state" })).calls).toBe(calls);
    await page.reload();
    await expect(input).toBeVisible();
    expect((await control({ action: "state" })).calls).toBe(calls);
    // Old accepted callback cannot retire a draft belonging to the next session.
    await control({ action: "hold", enabled: true });
    await input.fill("/compact");
    await send.click();
    await expect(status).toHaveAttribute("data-state", "running");
    await control({ action: "session", sessionId: "second-session" });
    await expect(status).toHaveCount(0);
    await input.fill("新会话草稿");
    await control({ action: "release" });
    await expect(input).toHaveValue("新会话草稿");
    expect((await control({ action: "state" })).submissions).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `${evidence}/silent-${width}.png`,
      fullPage: true,
    });
    await context.close();
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        backend: external ? "actual-host" : "fixture",
        viewports: [390, 1280, 320],
        acceptance: "passed",
        actualJointAcceptance: "pending Owner",
      },
      null,
      2,
    ),
  );
  console.log(
    "Compact browser acceptance passed: nullable meter, command menu, busy/refused draft, native running/failure, quiet manual/automatic/history, refreshed usage, stale session, disconnect/no replay.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
