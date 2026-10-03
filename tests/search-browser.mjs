import { denyNativeNotifications } from "./notification-permission.mjs";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { searchFixture } from "./search-fixture.ts";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const fixture = fixtureBackend();
const search = searchFixture();
const host = await createChatHost(
  { ...fixture.backend, ...search.backend },
  (e) => console.error(e),
);
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
        if (path === "/__test/conversation-search") {
          const input = await req.json();
          if (input.action === "reset") fixture.reset();
          const result = search.control(input);
          const view = await fixture.backend.read();
          return Response.json({
            ...result,
            sessionId: view.sessionId,
            messages: view.messages,
            archiveSessionId: "archive-session",
            recordIds: {
              original: "archive-0",
              repeated: "archive-1",
              summary: "archive-2",
              imported: "archive-22",
            },
          });
        }
        if (path === "/api/chat/socket") {
          if (!authorized) return new Response(null, { status: 401 });
          if (server.upgrade(req)) return;
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
  new URL("/__test/conversation-search", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/conversation-search/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280]) {
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
    const initial = await control({ action: "state" });
    const ids = initial.recordIds;
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const archiveReplies = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", (event) => {
        const frame = JSON.parse(String(event.payload));
        if (
          frame.type === "result" &&
          (frame.result?.hits || frame.result?.record)
        )
          archiveReplies.push(frame.result);
      }),
    );
    await page.goto(url);
    const draft = page.locator("#companion-textarea");
    await expect(draft).toBeVisible();
    await draft.fill("保留草稿 unsent");
    await page
      .getByRole("button", { name: "搜索聊天记录", exact: true })
      .click();
    const popup = page.locator(".companion-search-dialog");
    const query = popup.locator('input[type="search"]');
    const cards = popup.locator("li.companion-search-result");
    const submit = async (value) => {
      await query.fill(value);
      await query.press("Enter");
    };
    const openHit = async (id) => {
      const hits = archiveReplies.findLast((r) => r.hits)?.hits;
      const index = hits?.findIndex((hit) => hit.id === id) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      await cards.nth(index).click();
    };
    const back = () =>
      popup.getByRole("button", { name: "返回搜索结果", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/prompt-${width}.png`,
      fullPage: true,
    });
    await control({ action: "hold", key: "灯塔" });
    await submit("灯塔");
    await expect(popup.getByRole("status")).toBeVisible();
    await page.screenshot({
      path: `${evidence}/loading-${width}.png`,
      fullPage: true,
    });
    // A newer query wins while the first native method is still held.
    await submit("archiveSummary3142");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("记忆摘要");
    await control({ action: "release" });
    await expect
      .poll(() => archiveReplies.filter((r) => r.hits?.length === 20).length)
      .toBe(1);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("记忆摘要");
    // Observe real RPC replies; no interception bypasses native public methods.
    await submit("lighthouse");
    await expect(cards).toHaveCount(20);
    const ranked = archiveReplies.findLast((r) => r.hits)?.hits;
    expect(
      ranked.filter((hit) => hit.sessionId === initial.archiveSessionId).length,
    ).toBeGreaterThanOrEqual(19);
    await expect(popup).toContainText("仅显示前 20 条");
    await expect(popup.locator("img")).toHaveCount(0);
    await expect(cards.first()).toContainText("<img src=x onerror=alert(1)>");
    await submit("灯塔");
    await expect(cards.first().locator("mark")).toHaveText("灯塔");
    await page.screenshot({
      path: `${evidence}/results-${width}.png`,
      fullPage: true,
    });
    await openHit(ids.original);
    await expect(popup.locator(".search-target")).toContainText(
      "灯塔 lighthouse repeated",
    );
    await expect(popup).toContainText("before original branch");
    await expect(popup).not.toContainText("before imported branch");
    await expect(popup).toContainText("nearby summary");
    await expect(popup).toContainText("前后文过长，已截取附近内容。");
    await page.screenshot({
      path: `${evidence}/reader-${width}.png`,
      fullPage: true,
    });
    await back();
    await expect(cards).toHaveCount(20);
    const oldReads = archiveReplies.filter(
      (r) => r.record?.id === ids.original,
    ).length;
    await control({ action: "hold", key: ids.original });
    await openHit(ids.original);
    await expect(popup.getByRole("status")).toBeVisible();
    await back();
    await openHit(ids.repeated);
    await expect(popup).toContainText("before imported branch");
    await expect(popup).not.toContainText("before original branch");
    await control({ action: "release" });
    await expect
      .poll(
        () =>
          archiveReplies.filter((r) => r.record?.id === ids.original).length,
      )
      .toBe(oldReads + 1);
    await expect(popup).toContainText("before imported branch");
    await expect(popup).not.toContainText("before original branch");
    await back();
    await openHit(ids.summary);
    await expect(popup.locator(".search-target")).toContainText(
      "灯塔 lighthouse archiveSummary3142",
    );
    await back();
    await submit("archiveImported3142");
    await expect(cards).toHaveCount(1);
    await cards.first().click();
    await expect(popup).toContainText("before imported branch");
    await expect(popup).not.toContainText("before original branch");
    await back();
    await control({ action: "failure", method: "searchRead", enabled: true });
    await cards.first().click();
    await expect(popup.getByRole("alert")).toBeVisible();
    await control({ action: "failure", method: "searchRead", enabled: false });
    await popup.getByRole("button", { name: "重试", exact: true }).click();
    await expect(popup.locator(".search-target")).toContainText("record 22");
    await back();
    await submit("zz-no-match-zz");
    await expect(cards).toHaveCount(0);
    await expect(popup).toContainText("没有找到");
    await control({ action: "failure", method: "search", enabled: true });
    await submit("灯塔");
    await expect(popup.getByRole("alert")).toBeVisible();
    await page.screenshot({
      path: `${evidence}/failure-${width}.png`,
      fullPage: true,
    });
    await control({ action: "failure", method: "search", enabled: false });
    await popup.getByRole("button", { name: "重试", exact: true }).click();
    await expect(cards).toHaveCount(20);
    await popup.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(draft).toHaveValue("保留草稿 unsent");
    const final = await control({ action: "state" });
    expect(final.calls).toContain(`read:${ids.repeated}`);
    expect(final.sessionId).toBe(initial.sessionId);
    expect(final.messages).toEqual(initial.messages);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(draft).toHaveValue("");
    await expect(
      page
        .locator(".message-text")
        .filter({ hasText: "保留草稿 unsent" })
        .first(),
    ).toBeVisible();
    const sent = await control({ action: "state" });
    expect(sent.sessionId).toBe(initial.sessionId);
    expect(
      sent.messages.filter((message) => message.text === "保留草稿 unsent"),
    ).toHaveLength(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        backend: external ? "actual-host" : "fixture",
        viewports: [390, 1280],
        acceptance: "passed",
        actualJointAcceptance: "pending Owner",
      },
      null,
      2,
    ),
  );
  console.log(
    "Search browser acceptance passed: cards, summaries, context/read/back, loading/retry, stale query/selection, safe marks, draft/chat preservation.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
