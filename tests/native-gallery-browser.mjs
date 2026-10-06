import { denyNativeNotifications } from "./notification-permission.mjs";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost, imageHttp } from "../packages/contracts/src/server.ts";
import { imagesFixture } from "./images-fixture.ts";
import { resolve } from "node:path";
const fixture = imagesFixture();
let sessionId = "fixture-session";
const host = await createChatHost(
  {
    ...fixture.backend,
    read: async () => ({ ...(await fixture.backend.read()), sessionId }),
  },
  (e) => console.error(e),
);
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    const authorized =
      req.headers.get("cookie")?.includes("fixture-owner=1") === true;
    if (path === "/api/voice/capability")
      return Response.json({ available: true });
    if (path === "/__test/session") {
      sessionId = (await req.json()).sessionId;
      await fixture.control({ action: "reset" });
      return Response.json({ sessionId });
    }
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
const url = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addInitScript(denyNativeNotifications);
  await context.addInitScript(() => {
    window.androidBridge = {};
    window.micStarts = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.micStarts++;
      throw new DOMException("fixture refusal", "NotAllowedError");
    };
    window.galleryCalls = [];
    window.inputClicks = 0;
    document.addEventListener("click", (event) => {
      if (event.target.id === "companion-image-library") window.inputClicks++;
    });
    window.galleryReplies = [];
    window.Capacitor = {
      getPlatform: () => "android",
      PluginHeaders: [
        {
          name: "Camera",
          methods: [
            { name: "chooseFromGallery", rtype: "promise" },
            { name: "takePhoto", rtype: "promise" },
          ],
        },
      ],
      nativePromise: async (plugin, method, options) => {
        window.galleryCalls.push({ plugin, method, options });
        return new Promise((resolve, reject) =>
          window.galleryReplies.push({ resolve, reject }),
        );
      },
    };
  });
  const page = await context.newPage();
  await page.goto(url);
  const input = page.locator("#companion-textarea");
  await expect(input).toBeVisible();
  const attach = page.locator(".companion-attach");
  const drafts = page.locator(".companion-image-draft-preview img");
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const remove = page.getByRole("button", { name: "移除图片", exact: true });
  const uploads = [];
  page.on("request", (r) => {
    if (
      new URL(r.url()).pathname === "/api/chat/images" &&
      r.method() === "POST"
    )
      uploads.push(r.postDataJSON());
  });
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 2400;
    canvas.getContext("2d").fillRect(0, 0, 1080, 2400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const original = (name) =>
    Buffer.concat([Buffer.from(image, "base64"), Buffer.from(name)]);
  let nativeReads = 0;
  let releaseRead;
  let heldRead;
  await page.route("**/__test/native/*", async (route) => {
    nativeReads++;
    if (route.request().url().endsWith("/held")) {
      heldRead = true;
      await new Promise((r) => {
        releaseRead = r;
      });
    }
    if (route.request().url().endsWith("/failed"))
      return route.fulfill({ status: 404 });
    await route.fulfill({
      contentType: "image/png",
      body: original(new URL(route.request().url()).pathname.split("/").at(-1)),
    });
  });
  const start = async () => {
    const count = await page.evaluate(() => window.galleryCalls.length);
    await attach.click();
    await expect
      .poll(() => page.evaluate(() => window.galleryCalls.length))
      .toBe(count + 1);
  };
  const resolvePick = async (names) =>
    page.evaluate(
      (names) =>
        window.galleryReplies.shift().resolve({
          results: names.map((name) => ({
            type: 0,
            saved: false,
            webPath: `${location.origin}/__test/native/${name}`,
            metadata: { format: "png" },
          })),
        }),
      names,
    );
  const rejectPick = async (code) =>
    page.evaluate(
      (code) => window.galleryReplies.shift().reject({ code }),
      code,
    );
  await input.fill("retained draft");
  await expect(page.locator(".companion-microphone")).toBeEnabled();
  await start();
  expect(await page.evaluate(() => window.galleryCalls[0])).toEqual({
    plugin: "Camera",
    method: "chooseFromGallery",
    options: {
      mediaType: 0,
      allowMultipleSelection: true,
      limit: 6,
      includeMetadata: true,
    },
  });
  await expect(attach).toBeDisabled();
  await expect(send).toBeDisabled();
  await resolvePick(["held", "first"]);
  await expect.poll(() => heldRead).toBe(true);
  await expect(page.locator(".companion-microphone")).toBeDisabled();
  await expect(attach).toBeDisabled();
  await expect(send).toBeDisabled();
  await page
    .locator(".companion-microphone")
    .evaluate((el) =>
      el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  await expect(page.locator(".companion-microphone")).toHaveAttribute(
    "data-state",
    "idle",
  );
  expect(await page.evaluate(() => window.micStarts)).toBe(0);
  releaseRead();
  await expect(drafts).toHaveCount(2);
  await expect
    .poll(() => drafts.first().evaluate((img) => img.naturalWidth))
    .toBe(1080);
  expect(nativeReads).toBe(2);
  await start();
  expect(
    await page.evaluate(() => window.galleryCalls.at(-1).options.limit),
  ).toBe(4);
  await rejectPick("OS-PLUG-CAMR-0020");
  await expect(attach).toBeEnabled();
  await expect(drafts).toHaveCount(2);
  await expect(input).toHaveValue("retained draft");
  await start();
  await resolvePick(["ok", "failed"]);
  await expect(attach).toBeEnabled();
  await expect(drafts).toHaveCount(2);
  await expect(page.getByTestId("input-error")).toBeVisible();
  expect(await page.evaluate(() => window.inputClicks)).toBe(0);
  await start();
  await resolvePick(Array(5).fill("overflow"));
  await expect(page.getByTestId("input-error")).toBeVisible();
  await expect(drafts).toHaveCount(2);
  await start();
  await rejectPick("UNIMPLEMENTED");
  await expect(attach).toBeEnabled();
  expect(await page.evaluate(() => window.inputClicks)).toBe(0);
  await send.click();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0].images.map((i) => i.original)).toEqual([
    original("held").toString("base64"),
    original("first").toString("base64"),
  ]);
  expect(uploads[0].images.map((i) => i.mediaType)).toEqual([
    "image/png",
    "image/png",
  ]);
  expect(uploads[0].images.map((i) => i.order)).toEqual([0, 1]);
  // The retained read-error message still restores these memory Files before admission.
  await start();
  await resolvePick(["read-recovery"]);
  await expect(drafts).toHaveCount(1);
  await input.fill("recover this PNG");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    let failed = false;
    File.prototype.arrayBuffer = function () {
      if (!failed && this.name === "camera-photo.png") {
        failed = true;
        return Promise.reject(
          new DOMException("fixture read failure", "NotReadableError"),
        );
      }
      return read.call(this);
    };
    window.restoreRead = () => {
      File.prototype.arrayBuffer = read;
    };
  });
  await send.click();
  await expect(input).toHaveValue("recover this PNG");
  await expect(drafts).toHaveCount(1);
  await expect(page.getByTestId("input-error")).toContainText(
    "图片暂时无法读取",
  );
  expect(uploads).toHaveLength(1);
  await page.evaluate(() => window.restoreRead());
  await send.click();
  await expect.poll(() => uploads.length).toBe(2);
  expect(uploads[1].images[0].original).toBe(
    original("read-recovery").toString("base64"),
  );
  // Recovery still uses owned uploaded originals and the same draft path.
  await context.request.post(new URL("/__test/image-send-recovery", url).href, {
    data: { action: "nativeRecovery" },
  });
  await page.getByRole("button", { name: "恢复编辑", exact: true }).click();
  await expect(drafts).toHaveCount(1);
  await remove.click();
  await input.fill("");
  // A full composer never passes limit=0 (unlimited) into the native picker.
  await start();
  await resolvePick(Array(6).fill("full"));
  await expect(drafts).toHaveCount(6);
  const fullCalls = await page.evaluate(() => window.galleryCalls.length);
  await attach.click();
  await expect(page.getByTestId("input-error")).toBeVisible();
  expect(await page.evaluate(() => window.galleryCalls.length)).toBe(fullCalls);
  while (await remove.count()) await remove.first().click();
  // A -> B -> A must not resurrect the old picker result.
  await start();
  for (const next of ["fixture-other", "fixture-session"]) {
    await input.fill(`pending ${next}`);
    await context.request.post(new URL("/__test/session", url).href, {
      data: { sessionId: next },
    });
    await expect(input).toHaveValue("");
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  }
  await resolvePick(["late"]);
  await expect(attach).toBeEnabled();
  await expect(drafts).toHaveCount(0);
  expect(await page.evaluate(() => window.inputClicks)).toBe(0);
  console.log(
    "Native gallery owned-fixture browser checks passed: original bytes, native routing, limits, cancellation, failures, busy guard, recovery, session ownership.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.unref();
  void server.stop(true);
}
