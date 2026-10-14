import { chromium, expect } from "@playwright/test";
import { createChatHost, imageHttp } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { submissionsFixture } from "./submissions-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host needs test-owned submission control URL");
const fixture = submissionsFixture();
const host = await createChatHost(fixture.backend, () => {});
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__test/submissions") {
          const result = await fixture.control(await req.json());
          await host.refresh();
          return Response.json(result);
        }
        if (path === "/api/chat/socket" && server.upgrade(req)) return;
        const response = await imageHttp(
          req,
          fixture.imageBackend,
          async () => ({
            sessionId: "fixture-session",
            limits: fixture.limits,
          }),
        );
        return response ?? staticAssets(assets, path);
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
  new URL("/__test/submissions", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  ".scratch/failed-message-actions/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
const results = [];
try {
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        colorScheme: theme,
        locale: "zh-CN",
        httpCredentials: process.env.APP_ACCEPTANCE_USERNAME
          ? {
              username: process.env.APP_ACCEPTANCE_USERNAME,
              password: process.env.APP_ACCEPTANCE_PASSWORD ?? "",
            }
          : undefined,
      });
      const control = async (input) => {
        const r = await context.request.post(controlUrl, { data: input });
        expect(r.ok()).toBe(true);
        return r.json();
      };
      await control({ action: "reset" });
      await context.addInitScript(denyNativeNotifications);
      const page = await context.newPage();
      const errors = [];
      const finalizations = [],
        activeFinalizations = new Set();
      let publications = 0,
        connection = 0,
        unknownSubmission;
      page.on("websocket", (socket) => {
        const calls = new Map(),
          socketId = ++connection;
        socket.on("framesent", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.type !== "call") return;
          if (
            frame.call?.member === "submit" &&
            frame.call.args[0].text === "尚无明确结果"
          )
            unknownSubmission = frame.call.args[0];
          if (frame.call?.member !== "finalizeSubmission") return;
          const call = {
            id: frame.id,
            connection: socketId,
            input: frame.call.args[0],
            publications,
            inFlight: activeFinalizations.size + 1,
          };
          calls.set(frame.id, call);
          activeFinalizations.add(call);
          finalizations.push(call);
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.type === "update") publications++;
          const call = calls.get(frame.id);
          if (!call || !["result", "error"].includes(frame.type)) return;
          call.response = frame;
          calls.delete(frame.id);
          activeFinalizations.delete(call);
        });
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.clock.install();
      await page.goto(url);
      const input = page.locator("#companion-textarea"),
        send = page.getByRole("button", { name: "发送消息", exact: true });
      const recovery = page.getByTestId("input-recovery");
      const bubble = (text) =>
        page.locator(".message-sent").filter({ hasText: text });
      const pending = (operationId) =>
        page.evaluate((id) => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith("lamplit.pending:")) {
              const record = JSON.parse(localStorage.getItem(key)).find(
                (p) => p.operationId === id,
              );
              if (record) return record;
            }
          return null;
        }, operationId);
      const sending = (text) => bubble(text).getByRole("status");
      const snap = (name) =>
        page.screenshot({
          path: `${evidence}/${name}-${theme}-${width}.png`,
          fullPage: true,
        });
      await input.fill("ready");
      await expect(send).toBeEnabled();
      await input.fill("");
      const photo = {
        name: "receipt.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          await page.evaluate(() => {
            const c = document.createElement("canvas");
            c.width = c.height = 180;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#8ab6b1";
            ctx.fillRect(0, 0, 180, 180);
            return c.toDataURL("image/png").split(",")[1];
          }),
          "base64",
        ),
      };
      await control({ action: "mode", state: "slow", hidden: true });
      await page.locator("#companion-image-library").setInputFiles(photo);
      await input.fill("慢确认文字图片");
      await send.click();
      await expect(input).toHaveValue("");
      await expect(bubble("慢确认文字图片")).toHaveCount(1);
      await expect(sending("慢确认文字图片")).toHaveText("正在发送…");
      await expect(recovery).toHaveCount(0);
      await expect
        .poll(async () => (await control({ action: "state" })).submitCalls)
        .toBe(1);
      await snap("sending");
      await control({ action: "release" });
      await expect
        .poll(
          async () => (await control({ action: "state" })).submissions.length,
        )
        .toBe(1);
      await expect(recovery).toHaveCount(0);
      await expect(bubble("慢确认文字图片")).toHaveCount(1);
      const slow = (await control({ action: "state" })).submissions[0];
      await expect
        .poll(async () => (await pending(slow.operationId))?.state)
        .toBe("sent");
      await expect(sending("慢确认文字图片")).toHaveCount(0);
      await snap("sent");
      await control({ action: "publish" });
      await expect.poll(() => pending(slow.operationId)).toBeNull();
      await expect(bubble("慢确认文字图片")).toHaveCount(1);
      await expect(sending("慢确认文字图片")).toHaveCount(0);
      await control({ action: "complete" });
      await control({ action: "mode", state: "publishFirst" });
      await input.fill("先发布后回执");
      await send.click();
      await expect(bubble("先发布后回执")).toHaveCount(1);
      await expect
        .poll(
          async () => (await control({ action: "state" })).submissions.length,
        )
        .toBe(2);
      const published = (await control({ action: "state" })).submissions[1];
      await expect.poll(() => pending(published.operationId)).toBeNull();
      await expect(sending("先发布后回执")).toHaveCount(0);
      await control({ action: "release" });
      await expect(recovery).toHaveCount(0);
      await control({ action: "replyFailure" });
      await expect(page.getByText("回复失败", { exact: true })).toBeVisible();
      await expect(recovery).toHaveCount(0);
      await control({ action: "mode", state: "lost", hidden: true });
      await input.fill("断线前已提交");
      await send.click();
      await expect
        .poll(async () => (await control({ action: "state" })).lookupCalls)
        .toBeGreaterThan(0);
      await context.setOffline(true);
      await expect(recovery).toHaveCount(0);
      await context.setOffline(false);
      await page.reload();
      await expect(bubble("断线前已提交")).toHaveCount(1);
      await expect(recovery).toHaveCount(0);
      expect((await control({ action: "state" })).submitCalls).toBe(3);
      await control({ action: "publish" });
      await expect(bubble("断线前已提交")).toHaveCount(1);
      await control({ action: "complete" });
      await control({ action: "mode", state: "null", hidden: true });
      await input.fill("尚无明确结果");
      await send.click();
      await expect
        .poll(async () => (await control({ action: "state" })).submitCalls)
        .toBe(4);
      await page.reload();
      await expect(bubble("尚无明确结果")).toHaveCount(1);
      await expect(sending("尚无明确结果")).toHaveText("正在发送…");
      await expect(recovery).toHaveCount(0);
      expect((await control({ action: "state" })).submitCalls).toBe(4);
      await snap("null-reload");
      const socketUrl = new URL("/api/chat/socket", url);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      const cookies = (await context.cookies(url))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const headers = { Cookie: cookies };
      if (process.env.APP_ACCEPTANCE_USERNAME)
        headers.Authorization = `Basic ${Buffer.from(`${process.env.APP_ACCEPTANCE_USERNAME}:${process.env.APP_ACCEPTANCE_PASSWORD ?? ""}`).toString("base64")}`;
      const beforeExpiry = await control({ action: "state" });
      // The real browser deadline requests an authoritative native fence; age alone never fails.
      await control({ action: "finalizationLost", enabled: true });
      await page.clock.fastForward(61000);
      await expect
        .poll(async () => (await control({ action: "state" })).finalizeCalls)
        .toBe(1);
      await expect(sending("尚无明确结果")).toHaveText("正在发送…");
      await expect
        .poll(() => finalizations.filter((call) => call.response).length)
        .toBe(1);
      const receiptClient = await openChat(
        new WebSocket(socketUrl, { headers }),
        () => {},
        () => {},
      );
      let fencedReceipt;
      try {
        fencedReceipt = await receiptClient.lookup(
          unknownSubmission.operationId,
        );
        expect(fencedReceipt?.state).toBe("failed");
      } finally {
        receiptClient.close();
      }
      await page.clock.resume();
      // A normal view publication may recheck an expired, still-unconfirmed input.
      await control({ action: "publish" });
      await expect
        .poll(() => finalizations.filter((call) => call.response).length)
        .toBeGreaterThan(1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(sending("尚无明确结果")).toHaveText("正在发送…");
      await writeFile(
        `${evidence}/finalization-publication-${theme}-${width}.json`,
        JSON.stringify(finalizations, null, 2),
      );
      await control({ action: "finalizationLost", enabled: false });
      await page.reload();
      await expect(bubble("尚无明确结果").getByTestId(/failed-/)).toBeVisible();
      await page.clock.resume();
      const recoveredCalls = finalizations.length;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(finalizations).toHaveLength(recoveredCalls);
      expect(activeFinalizations.size).toBe(0);
      for (const [index, call] of finalizations.entries()) {
        expect(call.inFlight).toBe(1);
        expect(call.input).toEqual(finalizations[0].input);
        expect(call.input.submission).toEqual(unknownSubmission);
        if (index && call.connection === finalizations[index - 1].connection)
          expect(call.publications).toBeGreaterThan(
            finalizations[index - 1].publications,
          );
        if (call.response.type === "result")
          expect(call.response.result).toEqual(fencedReceipt);
        else expect(call.response.type).toBe("error");
      }
      expect(finalizations.at(-1).response.result).toEqual(fencedReceipt);
      const afterExpiry = await control({ action: "state" });
      expect(afterExpiry.finalizeCalls).toBe(finalizations.length);
      expect(afterExpiry.submitCalls).toBe(beforeExpiry.submitCalls);
      expect(afterExpiry.retryCalls).toBe(beforeExpiry.retryCalls);
      expect(afterExpiry.executions).toBe(beforeExpiry.executions);
      await writeFile(
        `${evidence}/finalization-recovery-${theme}-${width}.json`,
        JSON.stringify(
          {
            finalizations,
            executionDelta: afterExpiry.executions - beforeExpiry.executions,
            submitDelta: afterExpiry.submitCalls - beforeExpiry.submitCalls,
            retryDelta: afterExpiry.retryCalls - beforeExpiry.retryCalls,
          },
          null,
          2,
        ),
      );
      await expect(recovery).toHaveCount(0);
      const failedMark = () =>
        bubble("明确拒绝文字图片").getByTestId(/failed-/);
      const menuAction = (name) =>
        page
          .locator(".companion-action-menu")
          .getByRole("button", { name, exact: true });
      await control({ action: "mode", state: "failed" });
      await page.locator("#companion-image-library").setInputFiles(photo);
      await input.fill("明确拒绝文字图片");
      await send.click();
      await expect(failedMark()).toBeVisible();
      await expect(input).toHaveValue("");
      await expect(
        page.locator(".companion-image-draft-preview img"),
      ).toHaveCount(0);
      await input.fill("新草稿保持原样");
      await page.locator("#companion-image-library").setInputFiles(photo);
      await snap("failed");
      await bubble("明确拒绝文字图片")
        .locator(".companion-text-bubble")
        .focus();
      await page.keyboard.press("Shift+F10");
      await expect(menuAction("复制消息")).toBeVisible();
      await snap("failed-menu");
      await page.keyboard.press("Escape");
      await failedMark().click();
      await menuAction("删除").click();
      await expect(
        page.getByRole("dialog", {
          name: "删除这条发送失败的消息？",
          exact: true,
        }),
      ).toContainText("删除这条发送失败的消息？");
      await menuAction("取消").click();
      await expect(failedMark()).toBeVisible();
      await failedMark().click();
      await menuAction("重试").click();
      await expect(failedMark()).toBeVisible(); // New attempt fails again, same logical bubble.
      await expect(bubble("明确拒绝文字图片")).toHaveCount(1);
      await expect(input).toHaveValue("新草稿保持原样");
      await expect(
        page.locator(".companion-image-draft-preview img"),
      ).toHaveCount(1);
      await control({ action: "mode", state: "slow" });
      await failedMark().click();
      await menuAction("重试").click();
      await expect(sending("明确拒绝文字图片")).toHaveText("正在发送…");
      await expect(failedMark()).toHaveCount(0);
      await expect(bubble("明确拒绝文字图片")).toHaveCount(1);
      await control({ action: "release" });
      await expect(sending("明确拒绝文字图片")).toHaveCount(0);
      await expect(input).toHaveValue("新草稿保持原样");
      await page.getByRole("button", { name: "移除图片", exact: true }).click();
      await input.fill("");
      await page.reload();
      await expect(bubble("明确拒绝文字图片")).toHaveCount(1);
      await expect(recovery).toHaveCount(0);
      await bubble("尚无明确结果")
        .getByTestId(/failed-/)
        .click();
      await menuAction("删除").click();
      await control({ action: "deleteFailure", enabled: true });
      await menuAction("删除").click();
      await expect(bubble("尚无明确结果").getByTestId(/failed-/)).toBeVisible();
      await control({ action: "deleteFailure", enabled: false });
      await bubble("尚无明确结果")
        .getByTestId(/failed-/)
        .click();
      await menuAction("删除").click();
      await menuAction("删除").click();
      await expect(bubble("尚无明确结果")).toHaveCount(0);
      await page.reload();
      await expect(bubble("尚无明确结果")).toHaveCount(0);
      await expect(recovery).toHaveCount(0);
      await snap("deleted-reload");
      await control({ action: "complete" });
      await control({ action: "mode", state: "withdrawn" });
      await input.fill("处理前撤回");
      await send.click();
      await expect(bubble("处理前撤回")).toHaveCount(1);
      await expect(recovery).toContainText("处理前撤回");
      await snap("withdrawal");
      await control({ action: "consume" });
      await expect(recovery).toHaveCount(0);
      await control({ action: "mode", state: "submitted" });
      await input.fill("停止只停止回复");
      await send.click();
      await expect(
        page.getByRole("button", { name: "停止当前回复", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "停止当前回复", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "停止当前回复", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText("已停止回复", { exact: true })).toBeVisible();
      await expect(recovery).toHaveCount(0);
      await expect(bubble("停止只停止回复")).toHaveCount(1);
      // Same-ID immutable content is checked on the real socket boundary.
      const native = await control({ action: "state" });
      const stopped = native.submissions.find(
        (p) => p.text === "停止只停止回复",
      );
      expect(stopped).toBeDefined();
      const original = native.submissions[0];
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = await openChat(
          new WebSocket(socketUrl, { headers }),
          () => {},
          () => {},
        );
        try {
          expect((await client.lookup(stopped.operationId))?.state).toBe(
            "submitted",
          );
          expect((await client.submit(original)).state).toBe("submitted");
          expect((await client.lookup(original.operationId))?.state).toBe(
            "submitted",
          );
          await expect(
            client.submit({ ...original, text: "conflicting content" }),
          ).rejects.toThrow();
          expect(await client.lookup(crypto.randomUUID())).toBeNull();
        } finally {
          client.close();
        }
      }
      expect((await control({ action: "state" })).executions).toBe(
        native.executions,
      );
      await page.reload();
      await expect(bubble("慢确认文字图片")).toHaveCount(1);
      await expect(recovery).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      await snap("reloaded");
      results.push({
        width,
        theme,
        scope: external
          ? "actual-host-pending-owner-acceptance"
          : "app-fixture",
        submissions: (await control({ action: "state" })).submissions.length,
      });
      await context.close();
    }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    "Submission browser acceptance passed: slow ack/publish order, deadline fencing, failed image/text direct retry/delete without draft mutation, null/reload/reconnect no recovery, same-ID dedup/conflict, withdrawal, reply failure/stop; light/dark mobile/desktop.",
  );
} finally {
  await browser.close();
  host.close();
  if (server) await server.stop(true);
}
