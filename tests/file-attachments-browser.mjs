import { createUiTestHost } from "./ui-test-host.ts";
import { chromium, expect } from "@playwright/test";
import {
  imageHttp,
  fileHttp,
  fileStreamHttp,
} from "../packages/contracts/src/server.ts";
import { imagesFixture } from "./images-fixture.ts";
import { filesFixture, fileLimits } from "./files-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { fixtureImage } from "./panels-fixture.ts";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";

const images = imagesFixture();
const files = filesFixture();
const fileMessages = new Map();
const marker = "__fixture_file_only__";
let enabled = true;
let fileReads = 0;
let testRecovery = null;
let currentSession = "fixture-session";
let raceMessage;
let failFileUpload = false;
let fileUploads = 0;
let imageUploads = 0;
let submissions = 0;
const backend = {
  ...images.backend,
  async read() {
    const view = await images.backend.read();
    return {
      ...view,
      sessionId: currentSession,
      ...(testRecovery ? { recovery: testRecovery } : {}),
      capabilities: {
        ...view.capabilities,
        files: enabled ? fileLimits : false,
      },
      messages: [...view.messages, ...(raceMessage ? [raceMessage] : [])].map((message) => ({
        ...message,
        text: message.text === marker ? "" : message.text,
        ...(fileMessages.has(message.operationId)
          ? { files: fileMessages.get(message.operationId) }
          : {}),
      })),
    };
  },
  async submit(input, context) {
    submissions++;
    if (input.files) fileMessages.set(input.operationId, input.files);
    return images.backend.submit(
      { ...input, text: input.text || marker },
      context,
    );
  },
};
const host = await createUiTestHost(backend, (e) => console.error(e));
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    const authorized =
      request.headers.get("cookie")?.includes("fixture-owner=1") === true;
    if (path === "/__test/session") {
      currentSession = (await request.json()).sessionId;
      await host.publish();
      return Response.json({ sessionId: currentSession });
    }
    if (path === "/api/chat/socket") {
      if (!authorized) return new Response(null, { status: 401 });
      if (server.upgrade(request)) return;
    }
    const owner = authorized
      ? {
          ownerId: "owner",
          sessionId: currentSession,
          limits: enabled ? fileLimits : false,
        }
      : null;
    if (path.startsWith("/api/chat/files/") && request.method === "GET") fileReads++;
    if (path === "/api/chat/file-operations" && request.method === "POST") {
      fileUploads++;
      if (failFileUpload) return new Response(null, { status: 503 });
    }
    if (path === "/api/chat/images" && request.method === "POST") imageUploads++;
    const stream = await fileStreamHttp(request, files.streamBackend, async () => owner);
    if (stream) return stream;
    const file = await fileHttp(request, files.backend, async () => owner);
    if (file) return file;
    const image = await imageHttp(request, images.imageBackend, async () =>
      authorized
        ? { sessionId: currentSession, limits: images.limits }
        : null,
    );
    if (image) return image;
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
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
const evidence = ".scratch/chat-file-attachments/browser";
await mkdir(evidence, { recursive: true });
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1200, height: 900 },
  ]) {
    const context = await browser.newContext({
      viewport,
      locale: "zh-CN",
      acceptDownloads: true,
    });
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const composer = page.locator("#companion-textarea");
    await expect(composer).toBeVisible();
    const add = page.getByRole("button", { name: "添加附件" });
    await add.click();
    const menu = page.getByTestId("attachment-menu");
    await expect(menu).toBeVisible();
    const buttons = menu.getByRole("button");
    await expect(buttons).toHaveText(["拍照", "照片", "上传文件", "取消"]);
    await page.screenshot({ path: `${evidence}/menu-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    for (const [label, id] of [
      ["拍照", "companion-image-capture"],
      ["照片", "companion-image-library"],
    ]) {
      await add.click();
      const [picker] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: label, exact: true }).click(),
      ]);
      expect(await picker.element().getAttribute("id")).toBe(id);
      await picker.setFiles([]);
    }
    await add.click();
    const [picker] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "上传文件", exact: true }).click(),
    ]);
    await picker.setFiles([
      {
        name: "笔记.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello file"),
      },
      {
        name: "empty.dat",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(0),
      },
    ]);
    await expect(page.getByTestId("file-draft")).toHaveCount(2);
    await expect(page.getByTestId("file-draft").first()).toContainText(
      "笔记.txt",
    );
    await page.getByRole("button", { name: "移除文件 empty.dat" }).click();
    await expect(page.getByTestId("file-draft")).toHaveCount(1);
    await composer.fill("发送一个文件");
    await composer.press("Enter");
    await expect(page.getByTestId("file-draft")).toHaveCount(0);
    const entry = page
      .getByTestId("file-message")
      .filter({ hasText: "笔记.txt" })
      .last();
    await expect(entry).toBeVisible();
    await expect(entry).not.toContainText("下载");
    await entry.hover();
    await page.mouse.down();
    await page.waitForTimeout(550);
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    if (viewport.width === 390)
      await page.screenshot({ path: `${evidence}/file-menu-390.png` });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("笔记.txt");
    expect((await readFile(await download.path())).toString()).toBe("hello file");
    await page.reload();
    await expect(
      page.getByTestId("file-message").filter({ hasText: "笔记.txt" }).last(),
    ).toBeVisible();
    const gap = () => page.getByTestId("file-message").filter({ hasText: "笔记.txt" }).last().evaluate((file) => {
      const row = file.closest(".companion-row");
      const next = row?.nextElementSibling;
      if (!next) throw new Error("Missing text bubble");
      const bubble = (message) =>
        message.querySelector(".companion-message-body").parentElement.parentElement;
      return bubble(next).getBoundingClientRect().top - bubble(row).getBoundingClientRect().bottom;
    });
    await expect.poll(gap).toBeGreaterThanOrEqual(6);
    await page.screenshot({
      path: `${evidence}/message-${viewport.width}.png`,
    });
    await add.click();
    const [emptyPicker] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "上传文件", exact: true }).click(),
    ]);
    await emptyPicker.setFiles({
      name: `only-${viewport.width}.bin`,
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(0),
    });
    await expect(page.getByTestId("file-draft")).toHaveCount(1);
    await expect(page.getByTestId("attachment-menu")).toHaveCount(0);
    await composer.press("Enter");
    const emptyFile = page.getByTestId("file-message")
      .filter({ hasText: `only-${viewport.width}.bin` }).last();
    await expect(emptyFile).toBeVisible();
    const previousTime = page.locator(".companion-message-time").first();
    await expect.poll(async () => {
      const timeBox = await previousTime.boundingBox();
      const emptyBox = await emptyFile.boundingBox();
      return emptyBox.y - (timeBox.y + timeBox.height);
    }).toBeGreaterThanOrEqual(6);
    await emptyFile.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    const [emptyDownload] = await Promise.all([
      page.waitForEvent("download"), page.getByRole("button", { name: "下载", exact: true }).click(),
    ]);
    expect((await readFile(await emptyDownload.path())).length).toBe(0);
    if (viewport.width === 390) {
      await add.click();
      const [photoPicker] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "照片", exact: true }).click(),
      ]);
      await photoPicker.setFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(fixtureImage) });
      await add.click();
      const [mixedPicker] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "上传文件", exact: true }).click(),
      ]);
      const names = ["项目报告-2026-最终版本.txt", "项目报告-2026-最终版本.pdf", "项目报告-2026-最终版本.docx"];
      await mixedPicker.setFiles(names.map(name => ({ name, mimeType: "text/plain", buffer: Buffer.from("together") })));
      await expect(page.locator(".companion-image-draft-preview img")).toHaveCount(1);
      await expect(page.getByTestId("file-draft")).toHaveCount(3);
      await expect(page.getByTestId("attachment-menu")).toHaveCount(0);
      const draftLayout = await page.locator(".companion-image-drafts").evaluate((node) => {
        const items = [...node.children].map((item) => item.getBoundingClientRect());
        return {
          direction: getComputedStyle(node).flexDirection,
          scrollable: node.scrollHeight > node.clientHeight,
          ordered: items.every((item, index) => index === 0 || item.top >= items[index - 1].bottom),
        };
      });
      expect(draftLayout).toEqual({ direction: "column", scrollable: true, ordered: true });
      for (const name of names) {
        const draft = page.getByTestId("file-draft").filter({ hasText: name });
        await draft.scrollIntoViewIfNeeded();
        const detail = draft.locator(".companion-file-name");
        await expect(detail).toHaveText(name);
        await expect(draft).toHaveAttribute("title", name);
        await expect(detail.locator(".companion-file-name-extension")).toHaveText(name.slice(name.lastIndexOf(".")));
        expect(await detail.locator(".companion-file-name-extension").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await detail.locator(".companion-file-name-stem").evaluate((node) => ({ clipped: node.scrollWidth > node.clientWidth, singleLine: getComputedStyle(node).whiteSpace === "nowrap", ellipsis: getComputedStyle(node).textOverflow === "ellipsis" }))).toEqual({ clipped: true, singleLine: true, ellipsis: true });
        expect(await detail.evaluate((node) => {
          const text = node.getBoundingClientRect(), area = node.closest(".companion-image-drafts").getBoundingClientRect();
          return text.left >= area.left && text.right <= area.right && text.top >= area.top && text.bottom <= area.bottom;
        })).toBe(true);
      }
      const remove = page.getByRole("button", { name: `移除文件 ${names[0]}` });
      await remove.scrollIntoViewIfNeeded();
      const removeBounds = await remove.boundingBox();
      const barBounds = await page.locator(".companion-image-drafts").boundingBox();
      expect(removeBounds.x + removeBounds.width).toBeLessThanOrEqual(barBounds.x + barBounds.width);
      await page.screenshot({ path: `${evidence}/draft-390.png` });
      await composer.fill("照片和文件");
      await composer.press("Enter");
      for (const name of names) await expect(page.getByTestId("file-message").filter({ hasText: name }).last()).toBeVisible();
      await expect(page.getByTestId("file-draft")).toHaveCount(0);
      await page.reload();
      for (const name of names) {
        const detail = page.getByTestId("file-message").filter({ hasText: name }).last().locator(".companion-file-name");
        await detail.scrollIntoViewIfNeeded();
        await expect(detail).toHaveText(name);
        await expect(detail.locator("xpath=ancestor::button[1]")).toHaveAttribute("title", name);
        await expect(detail.locator(".companion-file-name-extension")).toHaveText(name.slice(name.lastIndexOf(".")));
        expect(await detail.locator(".companion-file-name-extension").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await detail.locator(".companion-file-name-stem").evaluate((node) => ({ clipped: node.scrollWidth > node.clientWidth, singleLine: getComputedStyle(node).whiteSpace === "nowrap", ellipsis: getComputedStyle(node).textOverflow === "ellipsis" }))).toEqual({ clipped: true, singleLine: true, ellipsis: true });
      }
      await page.screenshot({ path: `${evidence}/long-file-history-390.png` });
    }
    await add.click();
    const [stalePicker] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "上传文件", exact: true }).click(),
    ]);
    for (const sessionId of ["other-session", "fixture-session"]) {
      await composer.fill(`pending ${sessionId}`);
      await context.request.post(`http://127.0.0.1:${server.port}/__test/session`, { data: { sessionId } });
      await expect(composer).toHaveValue("");
    }
    await stalePicker.setFiles({ name: "stale.txt", mimeType: "text/plain", buffer: Buffer.from("stale") });
    await expect(page.getByTestId("file-draft")).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  }
  // Recovery restores text only; selecting a replacement file is explicit.
  const savedRef = [...fileMessages.values()].flat().find((ref) => ref.name === "笔记.txt");
  expect(savedRef).toBeDefined();
  const recoveryContext = await browser.newContext({ locale: "zh-CN" });
  await recoveryContext.addInitScript(denyNativeNotifications);
  const recoveryPage = await recoveryContext.newPage();
  for (const text of ["恢复的文字", ""]) {
    const sourceId = crypto.randomUUID();
    testRecovery = [{ sourceId, operationId: sourceId, text, images: [], files: [savedRef], replacementEligible: true }];
    await host.publish();
    await recoveryPage.goto(`http://127.0.0.1:${server.port}/`);
    await expect(recoveryPage.getByTestId("input-recovery")).toBeVisible();
    const before = fileReads;
    await recoveryPage.getByRole("button", { name: "恢复编辑", exact: true }).click();
    await expect(recoveryPage.locator("#companion-textarea")).toHaveValue(text);
    await expect(recoveryPage.getByTestId("file-draft")).toHaveCount(0);
    await expect(recoveryPage.getByText("附件未恢复，请重新选择。", { exact: true })).toBeVisible();
    expect(fileReads).toBe(before);
    await recoveryPage.getByRole("button", { name: "添加附件" }).click();
    const [replacementPicker] = await Promise.all([
      recoveryPage.waitForEvent("filechooser"),
      recoveryPage.getByRole("button", { name: "上传文件", exact: true }).click(),
    ]);
    await replacementPicker.setFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
    await expect(recoveryPage.getByTestId("file-draft")).toHaveCount(1);
    await recoveryPage.getByRole("button", { name: "丢弃恢复的输入", exact: true }).click();
  }
  await recoveryContext.close();
  testRecovery = null;
  await host.publish();
  // History downloads remain available when uploads are disabled.
  enabled = false;
  await host.publish();
  const largeContext = await browser.newContext({ locale: "zh-CN", acceptDownloads: true });
  await largeContext.addInitScript(denyNativeNotifications);
  const largePage = await largeContext.newPage();
  await largePage.goto(`http://127.0.0.1:${server.port}/`);
  const largeFile = largePage.getByTestId("file-message").filter({ hasText: "笔记.txt" }).last();
  await expect(largeFile).toBeVisible();
  await largeFile.hover(); await largePage.mouse.down();
  await largePage.waitForTimeout(550); await largePage.mouse.up();
  const readsBefore = fileReads;
  const [largeDownload] = await Promise.all([
    largePage.waitForEvent("download"),
    largePage.getByRole("button", { name: "下载", exact: true }).click(),
  ]);
  expect(largeDownload.suggestedFilename()).toBe("笔记.txt");
  expect((await readFile(await largeDownload.path())).toString()).toBe("hello file");
  expect(fileReads - readsBefore).toBe(2); // authorization preflight and browser download
  await largeContext.close();
  enabled = true;
  await host.publish();
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    locale: "zh-CN",
  });
  await touchContext.addInitScript(denyNativeNotifications);
  const touchPage = await touchContext.newPage();
  await touchPage.goto(`http://127.0.0.1:${server.port}/`);
  const touchFile = touchPage.getByTestId("file-message").filter({ hasText: "笔记.txt" }).last();
  await expect(touchFile).toBeVisible();
  const touchBox = await touchFile.boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  const touchPoints = [{ x: touchBox.x + touchBox.width / 2, y: touchBox.y + touchBox.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
  await touchPage.waitForTimeout(650);
  await expect(touchPage.getByRole("button", { name: "下载", exact: true })).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await touchContext.close();
  // A full current conversation has a different limit from the page-wide
  // attachment retention budget. Exercise both kinds of draft in the UI.
  for (const kind of ["image", "file"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript(denyNativeNotifications);
    await context.addInitScript(() => {
      localStorage.setItem(
        "lamplit.pending:fixture-session",
        JSON.stringify(
          Array.from({ length: 20 }, (_, i) => ({
            operationId: crypto.randomUUID(),
            text: `fixture pending ${i}`,
            createdAt: Date.now(),
            state: "failed",
            dispatched: true,
          })),
        ),
      );
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const input = page.locator("#companion-textarea");
    await expect(page.getByTestId(/failed-/)).toHaveCount(20);
    await page.getByRole("button", { name: "添加附件" }).click();
    const [picker] = await Promise.all([
      page.waitForEvent("filechooser"),
      page
        .getByRole("button", {
          name: kind === "image" ? "照片" : "上传文件",
          exact: true,
        })
        .click(),
    ]);
    await picker.setFiles(
      kind === "image"
        ? {
            name: "kept.png",
            mimeType: "image/png",
            buffer: Buffer.from(fixtureImage),
          }
        : {
            name: "kept.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("bytes"),
          },
    );
    await expect(page.locator(".companion-action-menu")).toHaveCount(0);
    const before = [fileUploads, imageUploads, submissions];
    await input.fill("保留草稿");
    await input.press("Enter");
    await expect(input).toHaveValue("保留草稿");
    if (kind === "image")
      await expect(page.locator('img[alt="kept.png"]')).toBeVisible();
    else await expect(page.getByTestId("file-draft")).toContainText("kept.txt");
    const error = page.getByTestId("input-error");
    const live = page.locator(".companion-sr-only[aria-live=assertive]");
    await expect(error).toContainText("当前会话的待确认消息已达上限");
    await expect(live).toContainText("当前会话的待确认消息已达上限");
    await page.getByRole("button", { name: "设置" }).click();
    const settings = page.locator("#companion-preferences-panel");
    await settings.getByRole("button", { name: "外观", exact: true }).click();
    await settings
      .locator('input[value="en"]')
      .locator("xpath=ancestor::label[1]")
      .click();
    await expect(error).toContainText(
      "This conversation has reached the limit of pending messages",
    );
    await expect(live).toContainText(
      "This conversation has reached the limit of pending messages",
    );
    expect([fileUploads, imageUploads, submissions]).toEqual(before);
    await context.close();
  }
  // Exercise the real page-wide attachment limit through the UI, then switch
  // language without reloading (reload would discard page-owned originals).
  failFileUpload = true;
  const capacityContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  await capacityContext.addInitScript(denyNativeNotifications);
  const capacityPage = await capacityContext.newPage();
  await capacityPage.goto(`http://127.0.0.1:${server.port}/`);
  const capacityInput = capacityPage.locator("#companion-textarea");
  await expect(capacityInput).toBeVisible();
  async function switchCapacitySession(sessionId) {
    await capacityInput.fill("switch session");
    await capacityContext.request.post(
      `http://127.0.0.1:${server.port}/__test/session`,
      { data: { sessionId } },
    );
    await expect(capacityInput).toHaveValue("");
    // The composer hides attachment controls while the editor is focused.
    await capacityInput.blur();
  }
  for (let index = 0; index < 20; index++) {
    await switchCapacitySession(`capacity-${index}`);
    if (index === 0) {
      await capacityPage.getByRole("button", { name: "添加附件" }).click();
      const [photo] = await Promise.all([
        capacityPage.waitForEvent("filechooser"),
        capacityPage.getByRole("button", { name: "照片", exact: true }).click(),
      ]);
      await photo.setFiles({
        name: "retained.png",
        mimeType: "image/png",
        buffer: Buffer.from(fixtureImage),
      });
      await expect(capacityPage.locator(".companion-action-menu")).toHaveCount(
        0,
      );
    }
    await capacityPage.getByRole("button", { name: "添加附件" }).click();
    const [pick] = await Promise.all([
      capacityPage.waitForEvent("filechooser"),
      capacityPage
        .getByRole("button", { name: "上传文件", exact: true })
        .click(),
    ]);
    await pick.setFiles({
      name: `capacity-${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    });
    await expect(capacityPage.locator(".companion-action-menu")).toHaveCount(0);
    if (index === 0) {
      // Keep the first preparation unresolved even after session switch.
      await capacityPage.evaluate(() => {
        window.createImageBitmap = () => {
          window.__attachmentPreparationHeld = true;
          return new Promise(() => {});
        };
      });
    }
    await capacityInput.fill(`pending capacity ${index}`);
    await capacityInput.press("Enter");
    if (index === 0)
      await expect
        .poll(() =>
          capacityPage.evaluate(() => window.__attachmentPreparationHeld),
        )
        .toBe(true);
    else await expect(capacityPage.getByTestId(/failed-/)).toBeVisible();
  }
  await switchCapacitySession("capacity-overflow");
  await capacityPage.getByRole("button", { name: "添加附件" }).click();
  const [overflowPicker] = await Promise.all([
    capacityPage.waitForEvent("filechooser"),
    capacityPage.getByRole("button", { name: "上传文件", exact: true }).click(),
  ]);
  await overflowPicker.setFiles({
    name: "keep-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("test"),
  });
  await expect(capacityPage.locator(".companion-action-menu")).toHaveCount(0);
  await capacityInput.fill("keep draft");
  await capacityInput.press("Enter");
  const capacityError = capacityPage.getByTestId("input-error");
  await expect(capacityError).toContainText(
    "附件准备尚未结束，或待确认附件过多",
  );
  await expect(capacityPage.getByTestId("file-draft")).toContainText(
    "keep-draft.txt",
  );
  await expect(capacityInput).toHaveValue("keep draft");
  await expect(
    capacityPage.locator(".companion-sr-only[aria-live=assertive]"),
  ).toContainText("附件准备尚未结束");
  await capacityPage.getByRole("button", { name: "设置" }).click();
  const settings = capacityPage.locator("#companion-preferences-panel");
  await settings.getByRole("button", { name: "外观", exact: true }).click();
  await settings
    .locator('input[value="en"]')
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(capacityError).toContainText(
    "Attachment preparation is still finishing",
  );
  await expect(
    capacityPage.locator(".companion-sr-only[aria-live=assertive]"),
  ).toContainText("Attachment preparation is still finishing");
  await settings.getByRole("button", { name: "Back" }).click();
  await settings.getByRole("button", { name: "Back" }).click();
  await switchCapacitySession("capacity-0");
  await expect(capacityPage.getByTestId(/failed-/)).toBeVisible();
  const retainedPhoto = capacityPage.locator('img[alt="retained.png"]');
  await expect(retainedPhoto).toBeVisible();
  const retainedPhotoUrl = await retainedPhoto.getAttribute("src");
  await expect(
    capacityPage
      .getByTestId("file-message")
      .filter({ hasText: "capacity-0.txt" }),
  ).toBeVisible();
  const beforeRetry = [fileUploads, imageUploads, submissions];
  await capacityPage.getByTestId(/failed-/).click();
  await capacityPage
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(capacityError).toContainText(
    "Attachment preparation is still finishing",
  );
  await expect(
    capacityPage.locator(".companion-sr-only[aria-live=assertive]"),
  ).toContainText("Attachment preparation is still finishing");
  await expect(
    capacityPage
      .getByTestId("file-message")
      .filter({ hasText: "capacity-0.txt" }),
  ).toBeVisible();
  await expect(retainedPhoto).toHaveAttribute("src", retainedPhotoUrl);
  expect([fileUploads, imageUploads, submissions]).toEqual(beforeRetry);
  await capacityPage.getByRole("button", { name: "Settings" }).click();
  await settings
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await settings
    .locator('input[value="zh"]')
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(capacityError).toContainText(
    "附件准备尚未结束，或待确认附件过多",
  );
  await expect(
    capacityPage.locator(".companion-sr-only[aria-live=assertive]"),
  ).toContainText("附件准备尚未结束");
  await capacityContext.close();
  failFileUpload = false;
  currentSession = "fixture-session";
  await host.publish();
  const retryAttempt = crypto.randomUUID();
  const sourceOperation = crypto.randomUUID();
  const oldRef = { attachmentId: "original_file", name: "original.txt", mediaType: "text/plain", size: 1, availability: "available" };
  const observedRef = { ...oldRef, attachmentId: "unverified_file", name: "unverified.txt" };
  raceMessage = { id: "observed-retry", operationId: retryAttempt, role: "user", text: "retry", createdAt: Date.now(), turnId: null, files: [observedRef] };
  await host.publish();
  const raceContext = await browser.newContext({ locale: "zh-CN" });
  await raceContext.addInitScript(denyNativeNotifications);
  await raceContext.addInitScript(({ retryAttempt, sourceOperation, oldRef }) => {
    localStorage.setItem("lamplit.pending:fixture-session", JSON.stringify([{
      operationId: retryAttempt, retrySource: sourceOperation, logicalId: sourceOperation,
      text: "retry", files: [oldRef], localFileCount: 1, state: "sending",
      dispatched: true, createdAt: Date.now(),
    }]));
  }, { retryAttempt, sourceOperation, oldRef });
  const racePage = await raceContext.newPage();
  await racePage.goto(`http://127.0.0.1:${server.port}/`);
  await expect(racePage.getByTestId("file-message").filter({ hasText: "original.txt" })).toBeVisible();
  await expect(racePage.getByTestId("file-message").filter({ hasText: "unverified.txt" })).toHaveCount(0);
  await raceContext.close();
  raceMessage = undefined;
  enabled = false;
  await host.publish();
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addInitScript(denyNativeNotifications);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await expect(page.locator("#companion-textarea")).toBeVisible();
  await page.getByRole("button", { name: "添加附件" }).click();
  await expect(
    page
      .getByTestId("attachment-menu")
      .getByRole("button", { name: "上传文件", exact: true }),
  ).toBeDisabled();
  await context.close();
  console.log(
    "file attachment browser: mobile and desktop menu, photo/camera pickers, drafts, send, download, reload passed",
  );
} finally {
  await browser.close();
  server.stop(true);
}
