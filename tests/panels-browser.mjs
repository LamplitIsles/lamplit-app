import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
const intervalParameter = process.env.APP_ACCEPTANCE_INTERVAL_SECONDS ?? "90";
const intervalSeconds = Number(intervalParameter);
if (
  !/^[1-9]\d*$/.test(intervalParameter) ||
  !Number.isSafeInteger(intervalSeconds)
)
  throw new Error(
    "APP_ACCEPTANCE_INTERVAL_SECONDS must be a positive safe integer",
  );
const intervalExpectation = new RegExp(`每 ${intervalSeconds} 秒`);
const fixture = fixtureBackend();
let host = await createChatHost(fixture.backend, () => {});
const channels = new Map();
const imageRequests = [];
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    if (path.startsWith("/api/fixture-images/")) {
      imageRequests.push(path);
      return new Response(fixtureImage, {
        headers: { "Content-Type": "image/png" },
      });
    }
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
const external = process.env.APP_ACCEPTANCE_URL;
const url = external ?? `http://127.0.0.1:${server.port}/`;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/companion-panels/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
try {
  for (const width of [390, 1280]) {
    fixture.panels.failures.clear();
    fixture.panels.empty.clear();
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "zh-CN",
      acceptDownloads: true,
      permissions: ["microphone"],
      httpCredentials: process.env.APP_ACCEPTANCE_USERNAME
        ? {
            username: process.env.APP_ACCEPTANCE_USERNAME,
            password: process.env.APP_ACCEPTANCE_PASSWORD ?? "",
          }
        : undefined,
    });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = [];
    const albumMetadata = [];
    let voiceBytes = 0;
    page.on("websocket", (socket) => {
      if (socket.url().includes("/api/voice/stream"))
        socket.on("framesent", ({ payload }) => {
          if (typeof payload !== "string") voiceBytes += payload.length;
        });
    });
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === "result" && Array.isArray(frame.result?.images))
            albumMetadata.push(...frame.result.images);
        } catch {}
      }),
    );
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url);
    const input = page.locator("#companion-textarea");
    await expect(input).toBeVisible();
    const drawer = page.getByTestId("companion-relationship-drawer");
    await page
      .getByRole("button", { name: "查看 Companion 关系资料", exact: true })
      .click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("一起走过第 25 段路")).toBeVisible();
    await drawer
      .getByRole("button", { name: "加载更早的变化", exact: true })
      .click();
    await expect(drawer.locator(".companion-history-entry")).toHaveCount(25);
    await expect(drawer.locator(".active-state")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/relationship-${width}.png`,
      fullPage: true,
    });
    await drawer.getByRole("tab", { name: "日记", exact: true }).click();
    await expect(drawer.locator(".companion-diary-list-entry")).toHaveCount(30);
    await drawer
      .getByRole("button", { name: "加载更早的变化", exact: true })
      .click();
    await expect(drawer.locator(".companion-diary-list-entry")).toHaveCount(35);
    await drawer.getByRole("button", { name: "2026-10-02" }).click();
    await expect(
      drawer.getByRole("heading", { name: "灯火日记" }),
    ).toBeVisible();
    await expect(drawer.getByRole("link", { name: "看看海" })).toHaveAttribute(
      "href",
      "https://example.com/diary",
    );
    await expect(drawer.locator(".active-state")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/diary-${width}.png`,
      fullPage: true,
    });
    await drawer.locator(".companion-diary-back").click();
    await drawer.getByRole("button", { name: "2026-10-01" }).click();
    await expect(
      drawer.getByText("这篇日记已不存在。", { exact: true }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: /返回/ }).click();
    await drawer.getByRole("button", { name: "2026-09-30" }).click();
    await expect(drawer.getByText(/这篇日记太长/)).toBeVisible();
    await drawer.getByRole("tab", { name: "相册", exact: true }).click();
    const tile = drawer.getByRole("button", {
      name: "灯火-35.png",
      exact: true,
    });
    await expect(tile).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "灯火-34.png", exact: true }),
    ).toBeDisabled();
    await expect(drawer.getByText("图片不可用", { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "按日", exact: true }).click();
    await expect(drawer.locator(".active-state")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/album-${width}.png`,
      fullPage: true,
    });
    const viewport = drawer.locator(".companion-gallery-viewport");
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    if (!external)
      await expect
        .poll(
          () => fixture.panels.calls.filter((call) => call === "album").length,
        )
        .toBeGreaterThan(1);
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await tile.click();
    const photo = page.locator(".photo-browser .swiper-slide-active img");
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute(
      "src",
      albumMetadata.find((image) => image.filename === "灯火-35.png")
        .originalUrl,
    );
    await photo.click({ button: "right" });
    const save = page.getByRole("button", { name: "保存图片", exact: true });
    await expect(save).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      save.click(),
    ]).catch(async (error) => {
      await expect(drawer.locator(".active-state")).toHaveCount(0);
      await page.screenshot({ path: `${evidence}/save-failed-${width}.png` });
      console.log(await page.locator("body").innerText(), imageRequests);
      throw error;
    });
    expect(download.suggestedFilename()).toBe("灯火-35.png");
    expect(new Uint8Array(await readFile(await download.path()))).toEqual(
      fixtureImage,
    );
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    await expect(drawer.locator(".active-state")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/original-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭大图", exact: true }).click();
    await expect(photo).not.toBeVisible();
    await drawer.getByRole("tab", { name: "自动唤醒", exact: true }).click();
    await expect(drawer.getByText(intervalExpectation)).toBeVisible();
    await expect(drawer.getByText(/Asia\/Shanghai/).first()).toBeVisible();
    await expect(drawer.locator(".active-state")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/reminders-${width}.png`,
      fullPage: true,
    });
    if (!external) {
      for (const [method, tab] of [
        ["relationshipHistory", "关系历史"],
        ["diaryList", "日记"],
        ["album", "相册"],
        ["reminders", "自动唤醒"],
      ]) {
        fixture.panels.failures.add(method);
        await drawer.getByRole("tab", { name: tab, exact: true }).click();
        await expect(drawer.locator('[role="alert"]')).toBeVisible();
        await expect(drawer.locator(".active-state")).toHaveCount(0);
        await page.screenshot({
          path: `${evidence}/${method}-error-${width}.png`,
          fullPage: true,
        });
        fixture.panels.failures.delete(method);
        await drawer.locator('[role="alert"]').getByRole("button").click();
        await expect(drawer.locator('[role="alert"]')).toHaveCount(0);
        fixture.panels.empty.add(method);
        // History/diary/album reload through their tab; reminders keep their own refresh.
        if (method !== "reminders")
          await drawer.getByRole("tab", { name: tab, exact: true }).click();
        else
          await drawer
            .getByRole("button", { name: "刷新", exact: true })
            .click();
        await expect(
          drawer.getByText(
            {
              relationshipHistory: "还没有记录过关系变化。",
              diaryList: "还没有日记。",
              album: "还没有聊天图片。",
              reminders: "还没有唤醒安排",
            }[method],
            { exact: true },
          ),
        ).toBeVisible();
        await expect(drawer.locator(".active-state")).toHaveCount(0);
        await page.screenshot({
          path: `${evidence}/${method}-empty-${width}.png`,
          fullPage: true,
        });
        fixture.panels.empty.delete(method);
      }
      let release;
      const delayed = new Promise((resolve) => {
        release = resolve;
      });
      fixture.panels.delays.set("diaryRead", delayed);
      await drawer.getByRole("tab", { name: "日记", exact: true }).click();
      await drawer.getByRole("button", { name: "2026-10-02" }).click();
      await drawer.getByRole("tab", { name: "自动唤醒", exact: true }).click();
      release();
      fixture.panels.delays.delete("diaryRead");
      await expect(drawer.getByText(intervalExpectation)).toBeVisible();
      await expect(
        drawer.getByRole("heading", { name: "灯火日记" }),
      ).toHaveCount(0);
      fixture.remind();
    }
    await drawer
      .getByRole("button", { name: "关闭关系资料", exact: true })
      .click();
    await expect(page.locator(".companion-alarm-source").last()).toHaveText(
      "应用提醒",
    );
    await input.fill(`panels-chat-${width}`);
    await input.press("Enter");
    if (!external) {
      await expect.poll(() => fixture.executions).toBe(width === 390 ? 1 : 2);
      await fixture.complete(`panels-complete-${width}`);
      await expect(
        page.getByText(`panels-complete-${width}`, { exact: true }),
      ).toBeVisible();
    }
    if (external) {
      await expect(
        page
          .getByText(
            new RegExp(process.env.APP_ACCEPTANCE_REPLY ?? "fixture reply"),
          )
          .last(),
      ).toBeVisible();
      const mic = page.locator(".companion-microphone");
      await mic.click();
      await expect(mic).toHaveAttribute("data-state", "recording");
      await expect.poll(() => voiceBytes).toBeGreaterThan(0);
      await mic.click();
      await expect(input).toHaveValue(
        process.env.APP_ACCEPTANCE_TRANSCRIPT ?? "recognized final",
      );
    }
    await page.reload();
    await expect(input).toBeVisible();
    await expect(page.locator(".companion-alarm-source").last()).toHaveText(
      "应用提醒",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (!external) {
      await page
        .getByRole("button", {
          name: "查看 Companion 关系资料",
          exact: true,
        })
        .click();
      await drawer.getByRole("tab", { name: "相册", exact: true }).click();
      await tile.click();
      await expect(photo).toBeVisible();
      await photo.click({ button: "right" });
      await expect(save).toBeVisible();
      const staleSave = await save.elementHandle();
      let staleDownloads = 0;
      page.on("download", () => staleDownloads++);
      const previousImageRequests = imageRequests.length;
      host.close();
      host = await createChatHost(
        {
          ...fixture.backend,
          read: async () => ({
            ...(await fixture.backend.read()),
            sessionId: "different-session",
            name: "different-session",
          }),
        },
        () => {},
      );
      for (const ws of channels.keys()) ws.terminate();
      await expect(page).toHaveTitle("different-session");
      await expect(photo).not.toBeVisible();
      await expect(page.locator(".companion-action-menu")).toHaveCount(0);
      await staleSave.evaluate((element) => element.click());
      expect(staleDownloads).toBe(0);
      expect(imageRequests.length).toBe(previousImageRequests);
      await page.screenshot({
        path: `${evidence}/session-replacement-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    await context.close();
    if (!external) {
      host.close();
      host = await createChatHost(fixture.backend, () => {});
    }
  }
  console.log(
    `Panels acceptance passed at 390/1280 (${external ? "actual host" : "fixture host"}); evidence ${evidence}`,
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.stop(true);
}
