import { denyNativeNotifications } from "./notification-permission.mjs";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost, imageHttp } from "../packages/contracts/src/server.ts";
import { imagesFixture } from "./images-fixture.ts";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const fixture = imagesFixture();
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
        if (path === "/__test/image-send-recovery")
          return Response.json(await fixture.control(await req.json()));
        if (path === "/api/chat/socket") {
          if (!authorized) return new Response(null, { status: 401 });
          if (server.upgrade(req)) return;
        }
        const response = await imageHttp(req, fixture.imageBackend, async () =>
          authorized
            ? { sessionId: "fixture-session", limits: fixture.limits }
            : null,
        );
        if (response) return response;
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
  new URL("/__test/image-send-recovery", url).href;
const evidence =
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/image-send-recovery/browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
const results = [];
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
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    const albumMetadata = [];
    const uploads = [];
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
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/api/chat/images" &&
        request.method() === "POST"
      )
        uploads.push(request.postDataJSON());
    });
    await page.goto(url);
    const input = page.locator("#companion-textarea");
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    const choose = page.locator("#companion-image-library");
    const drafts = page.locator(".companion-image-draft-preview img");
    const recovery = page.getByTestId("input-recovery");
    const restore = page.getByRole("button", { name: "恢复编辑", exact: true });
    await expect(input).toBeVisible();
    await expect(page.locator(".companion-attach")).toBeVisible();
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = 180;
      const c = canvas.getContext("2d");
      c.fillStyle = "#8ab6b1";
      c.fillRect(0, 0, 180, 180);
      c.fillStyle = "#294b46";
      c.beginPath();
      c.moveTo(90, 20);
      c.lineTo(25, 145);
      c.lineTo(155, 145);
      c.fill();
      c.fillStyle = "#c39866";
      c.fillRect(82, 135, 16, 35);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const file = {
      name: "tree.png",
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    };
    await choose.setInputFiles(file);
    await expect(drafts).toHaveCount(1);
    await expect
      .poll(() => drafts.first().evaluate((img) => img.naturalWidth))
      .toBe(180);
    const thumbnail = await drafts.first().boundingBox();
    // Pinned CFL Framework7 native measurement; attachments scroll in one row.
    expect(thumbnail.width).toBe(72);
    expect(thumbnail.height).toBe(72);
    const remove = page.getByRole("button", { name: "移除图片", exact: true });
    const target = await remove.boundingBox();
    expect(target.width).toBe(44);
    expect(target.height).toBe(44);
    expect((await input.boundingBox()).width).toBeGreaterThan(0);
    await expect(send).toBeEnabled();
    const nativeLimits = (await control({ action: "state" })).limits;
    await choose.setInputFiles(
      Array.from({ length: nativeLimits.maxImagesPerMessage }, () => file),
    );
    await expect(drafts).toHaveCount(1); // atomic intake rejects count overflow
    await expect(page.getByTestId("input-error")).toBeVisible();
    await choose.setInputFiles({
      name: "oversized.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(nativeLimits.maxImageBytes + 1),
    });
    await expect(drafts).toHaveCount(1);
    await expect(page.getByTestId("input-error")).toBeVisible();

    await page.screenshot({
      path: `${evidence}/attachment-light-${width}.png`,
      fullPage: true,
    });
    await page
      .locator(".messagebar")
      .screenshot({ path: `${evidence}/attachment-region-light-${width}.png` });
    await page.evaluate(() =>
      localStorage.setItem("her.companion.appearance", "dark"),
    );
    await remove.click();
    await expect(drafts).toHaveCount(0);
    // Browser paste uses the same intake path and displays a real image.
    await input.evaluate((node, data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([bytes], "pasted.png", { type: "image/png" }),
      );
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, image);
    await expect(drafts).toHaveCount(1);
    // Bare compact with images is refused before upload/chat admission.
    await input.fill("/compact");
    await send.click();
    await expect(input).toHaveValue("/compact");
    await expect(drafts).toHaveCount(1);
    expect((await control({ action: "state" })).submissions).toEqual([]);
    expect(uploads).toEqual([]);
    await input.fill("");
    if (width === 320) {
      await choose.setInputFiles(file);
      await expect(drafts).toHaveCount(2);
      expect((await drafts.nth(1).boundingBox()).y).toBe(
        (await drafts.first().boundingBox()).y,
      );
      await page.screenshot({
        path: `${evidence}/attachment-overflow-320.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await context.close();
      results.push({ width, thumbnail, target, overflow: false });
      continue;
    }
    await send.click();
    await expect(drafts).toHaveCount(0);
    await expect
      .poll(async () => (await control({ action: "state" })).executions)
      .toBe(1);
    const first = (await control({ action: "state" })).submissions[0];
    expect(uploads[0].images[0].original).toBe(image);
    expect(first.text).toBe("");
    expect(first.images.length).toBe(1);
    await expect(page.locator(`img[alt="pasted.png"]`)).toBeVisible();
    const upload = uploads[0];
    expect(upload.images[0].preview.startsWith("/9j/")).toBe(true);
    expect(upload.images[0].model.startsWith("/9j/")).toBe(true);
    const postUpload = (data) =>
      context.request.post(new URL("/api/chat/images", url).href, {
        data,
        headers: { Origin: new URL(url).origin },
      });
    expect((await postUpload(upload)).ok()).toBe(true);
    expect([400, 409]).toContain(
      (
        await postUpload({
          ...upload,
          images: [{ ...upload.images[0], name: "changed.png" }],
        })
      ).status(),
    );
    expect([400, 403, 409]).toContain(
      (
        await postUpload({ ...upload, sessionId: "wrong-owner-session" })
      ).status(),
    );
    const guest = await browser.newContext();
    const denied = await guest.request.get(
      new URL(`/api/chat/media/${first.images[0].attachmentId}/original`, url)
        .href,
    );
    expect([401, 403, 404]).toContain(denied.status());
    await guest.close();
    await input.fill("图片与文字");
    await choose.setInputFiles(file);
    await send.click();
    await expect
      .poll(async () => (await control({ action: "state" })).submissions.length)
      .toBe(2);
    expect((await control({ action: "state" })).submissions[1].text).toBe(
      "图片与文字",
    );
    // Active turn remains the same while the image-bearing steering input is admitted.
    await expect(page.getByTestId("companion-stop")).toBeVisible();
    await control({ action: "complete" });
    await expect(page.getByText("完整图片回复", { exact: true })).toBeVisible();
    let state = await control({ action: "state" });
    expect(state.album.some((image) => image.origin === "human")).toBe(true);
    expect(state.album.some((image) => image.origin === "agent")).toBe(true);
    await page
      .getByRole("button", { name: "查看 Companion 关系资料", exact: true })
      .click();
    const drawer = page.getByTestId("companion-relationship-drawer");
    await drawer.getByRole("tab", { name: "相册", exact: true }).click();
    await expect(
      drawer.getByRole("button", { name: "pasted.png", exact: true }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "generated.png", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        albumMetadata.some(
          (i) => i.id === first.images[0].attachmentId && i.origin === "human",
        ),
      )
      .toBe(true);
    expect(
      albumMetadata.some(
        (i) => i.filename === "generated.png" && i.origin === "agent",
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/album-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await page.screenshot({
      path: `${evidence}/history-${width}.png`,
      fullPage: true,
    });
    await control({ action: "history" });
    await page.reload();

    // Existing Companion uses a link for older messages.
    await page
      .getByRole("button", { name: "查看更早的消息", exact: true })
      .click();
    await expect(page.locator('img[alt="pasted.png"]')).toBeVisible();
    // Pre-admission failure retains the File and editable text; no execution.
    await control({ action: "uploadFailure", enabled: true });
    await input.fill("上传失败保留");
    await choose.setInputFiles(file);
    const beforeFailure = (await control({ action: "state" })).submissions
      .length;
    await send.click();
    await expect(input).toHaveValue("上传失败保留");
    await expect(drafts).toHaveCount(1);
    expect((await control({ action: "state" })).submissions.length).toBe(
      beforeFailure,
    );
    await page.screenshot({
      path: `${evidence}/upload-failure-${width}.png`,
      fullPage: true,
    });
    await control({ action: "uploadFailure", enabled: false });
    await control({ action: "mode", state: "unconsumed" });
    await send.click();
    await expect(input).toHaveValue("");
    await expect(recovery).toBeVisible();
    await input.fill("当前编辑");
    await expect(restore).toBeDisabled();
    await page.screenshot({
      path: `${evidence}/recovery-protected-${width}.png`,
      fullPage: true,
    });
    await input.fill("");
    await page.reload();
    await expect(recovery).toBeVisible();
    await restore.click();
    await expect(input).toHaveValue("上传失败保留");
    await expect(drafts).toHaveCount(1);
    await input.fill("恢复后编辑");
    await control({ action: "mode", state: "consumed" });
    await send.click();
    await expect
      .poll(async () => (await control({ action: "state" })).recovery.length)
      .toBe(0);
    state = await control({ action: "state" });
    const replacement = state.submissions.at(-1);
    expect(replacement.text).toBe("恢复后编辑");
    expect(replacement.replacementSourceIds.length).toBe(1);
    expect(replacement.operationId).not.toBe(
      replacement.replacementSourceIds[0],
    );
    const executions = state.executions;
    await page.reload();
    expect((await control({ action: "state" })).executions).toBe(executions);
    await expect(recovery).toHaveCount(0);
    // A delayed native recovery result cannot replace edits made while originals load.
    await control({ action: "nativeRecovery" });
    await page.reload();
    await expect(recovery).toBeVisible();
    let releaseMedia;
    const heldMedia = new Promise((resolve) => {
      releaseMedia = resolve;
    });
    let mediaStarted;
    const mediaRequest = new Promise((resolve) => {
      mediaStarted = resolve;
    });
    await page.route("**/api/chat/media/**/original", async (route) => {
      mediaStarted();
      const response = await route.fetch();
      await heldMedia;
      await route.fulfill({ response });
    });
    await restore.click();
    await mediaRequest;
    await input.fill("恢复期间编辑");
    releaseMedia();
    await expect(restore).toBeDisabled();
    await expect(input).toHaveValue("恢复期间编辑");
    await expect(drafts).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    expect((await control({ action: "state" })).recovery.length).toBe(1);
    await control({ action: "consume" });
    await input.fill("");
    // Clearing a restored source returns its offer; Ignore reaches the next source without reload.
    for (const discard of [false, true]) {
      await control({ action: "nativeRecovery" });
      await control({ action: "nativeRecovery" });
      const sources = (await control({ action: "state" })).recovery;
      await expect(recovery).toBeVisible();
      await restore.click();
      await expect(input).toHaveValue("原生恢复输入");
      await expect(drafts).toHaveCount(1);
      if (discard)
        await page
          .getByRole("button", { name: "丢弃恢复的输入", exact: true })
          .click();
      else {
        await remove.click();
        await input.fill("");
        await expect(recovery).toBeVisible();
        await page.getByRole("button", { name: "忽略", exact: true }).click();
      }
      await expect(input).toHaveValue("");
      await expect(recovery).toBeVisible();
      await expect(recovery.locator("img")).toHaveAttribute(
        "src",
        new RegExp(sources[1].images[0].attachmentId),
      );
      await restore.click();
      await expect(input).toHaveValue("原生恢复输入");
      await page.screenshot({
        path: `${evidence}/recovery-${discard ? "discard" : "clear"}-next-${width}.png`,
        fullPage: true,
      });
      expect(
        (await control({ action: "state" })).recovery.map((r) => r.sourceId),
      ).toEqual(sources.map((r) => r.sourceId));
      await page
        .getByRole("button", { name: "丢弃恢复的输入", exact: true })
        .click();
      await expect(recovery).toHaveCount(0);
      await control({ action: "consume" });
    }
    // A newer send cannot silently discard Files from a delayed failed upload.
    await control({ action: "uploadFailure", enabled: true });
    let releaseUpload;
    const heldUpload = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted;
    const uploadRequest = new Promise((resolve) => {
      uploadStarted = resolve;
    });
    await page.route("**/api/chat/images", async (route) => {
      uploadStarted();
      const response = await route.fetch();
      await heldUpload;
      await route.fulfill({ response });
    });
    await input.fill("较早上传失败");
    await choose.setInputFiles(file);
    await send.click();
    await uploadRequest;
    await input.fill("随后文字发送");
    await send.click();
    await expect(input).toHaveValue("");
    releaseUpload();
    await expect(input).toHaveValue("较早上传失败");
    await expect(drafts).toHaveCount(1);
    await page.unrouteAll({ behavior: "wait" });
    await control({ action: "uploadFailure", enabled: false });
    await remove.click();
    await input.fill("");
    // Native-origin recovery rehydrates on refresh; missing media requires explicit removal.
    await control({ action: "nativeRecovery" });
    await page.reload();
    await expect(recovery).toBeVisible();
    await control({ action: "missing" });
    await restore.click();
    await expect(input).toHaveValue("原生恢复输入");
    await expect(page.getByTestId("missing-recovery-image")).toBeVisible();
    await expect(send).toBeDisabled();
    await page.screenshot({
      path: `${evidence}/missing-original-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "移除缺失图片", exact: true })
      .click();
    await send.click();
    await expect
      .poll(async () => (await control({ action: "state" })).recovery.length)
      .toBe(0);
    await control({ action: "mode", state: "rejected" });
    await input.fill("拒绝输入");
    await send.click();
    await expect(recovery).toBeVisible();
    await restore.click();
    await expect(input).toHaveValue("拒绝输入");
    await input.fill("");
    await control({ action: "consume" });
    await page.reload();
    await expect(recovery).toHaveCount(0);
    await control({ action: "mode", state: "uncertain" });
    await input.fill("未知送达");
    await send.click();
    await expect(recovery).toBeVisible();
    await expect(restore).toBeDisabled();
    await page.getByText("查看提交内容", { exact: true }).click();
    await expect(recovery.getByText("未知送达", { exact: true })).toBeVisible();
    const uncertainCount = (await control({ action: "state" })).executions;
    await context.setOffline(true);
    await context.setOffline(false);
    await page.reload();
    await expect(recovery).toBeVisible();
    expect((await control({ action: "state" })).executions).toBe(
      uncertainCount,
    );
    await control({ action: "consume" });
    await page.reload();
    await expect(recovery).toHaveCount(0);
    await control({ action: "disabled", enabled: true });
    await page.reload();
    await expect(page.locator(".companion-attach")).toHaveCount(0);
    await input.fill("图片关闭仍可发文字");
    await control({ action: "mode", state: "consumed" });
    await send.click();
    await expect(input).toHaveValue("");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Dark scoped reference after reload uses the retained theme settings.
    await control({ action: "disabled", enabled: false });
    await page.reload();
    await choose.setInputFiles([file, file]);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: `${evidence}/attachment-dark-${width}.png`,
      fullPage: true,
    });
    await page
      .locator(".messagebar")
      .screenshot({ path: `${evidence}/attachment-region-dark-${width}.png` });
    expect(errors).toEqual([]);
    results.push({
      width,
      thumbnail,
      target,
      overflow: false,
      semanticAcceptance: "passed",
    });
    await context.close();
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      { backend: external ? "actual-host" : "fixture", results },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Image/recovery browser acceptance passed: file/paste, measured thumbnails/removal, image-only/text+image/steering, immutable uploads, owner isolation, history/album provenance, failure retention, protected recovery/refresh/edit/replacement, missing originals, rejection/uncertainty/consumption, disabled storage, 390/1280/320 overflow.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server?.unref();
  void server?.stop(true);
}
