import { chromium, expect } from "@playwright/test";
import { createChatHost, imageHttp } from "../packages/contracts/src/server.ts";
import { imagesFixture } from "./images-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const fixture = imagesFixture();
const pcmBytes = 8000 * 2 * 4;
const wav = Buffer.alloc(44 + pcmBytes);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcmBytes, 40);
const turnId = "agent-turn";
const base = { role: "agent", createdAt: 1, operationId: null, turnId };
let picture = { ...base, id: "picture", text: "", imageState: "preparing" };
const text = { ...base, id: "text", text: "先看看这张图片。\n", textState: "streaming" };
const voice = { ...base, id: "voice", text: "", voice: { id: "a".repeat(64) } };
let releaseSubmit;
const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
let releaseSecond;
const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
let releaseThird, releaseFourth;
const thirdGate = new Promise((resolve) => { releaseThird = resolve; });
const fourthGate = new Promise((resolve) => { releaseFourth = resolve; });
let releaseRetry;
const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
let trailing = [];
const backend = {
  ...fixture.backend,
  async read() {
    const view = await fixture.backend.read();
    return { ...view, activeTurnId: turnId, messages: [text, picture, voice, ...view.messages, ...trailing],
      streamingReply: { id: text.id, turnId, createdAt: 1, text: text.text } };
  },
  async submit(input) {
    await (input.text === "第二条图片" ? secondGate : input.text === "第三条图片" ? thirdGate : input.text === "第四条图片" ? fourthGate : submitGate);
    return fixture.backend.submit(input);
  },
  async retryFailed(input) {
    const result = await fixture.backend.retryFailed(input);
    trailing = [{ ...base, id: "after-retry", text: "重试后的回复" }];
    await host.refresh();
    await retryGate;
    return result;
  },
};
const host = await createChatHost(backend);
const channels = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(request)) return;
    if (path === "/__test/finish-picture") {
      picture = { ...base, id: "picture", text: "", imageState: "ready", images: [{ attachmentId: "generated", name: "generated.png", mediaType: "image/png", availability: "available" }] };
      await host.refresh();
      return new Response("ok");
    }
    if (path === "/__test/unknown-picture") {
      picture = { ...base, id: "picture", text: "", imageState: "unknown" };
      await host.refresh();
      return new Response("ok");
    }
    if (path === "/__test/release-submit") { releaseSubmit(); return new Response("ok"); }
    if (path === "/__test/release-second") { releaseSecond(); return new Response("ok"); }
    if (path === "/__test/release-third") { releaseThird(); return new Response("ok"); }
    if (path === "/__test/release-fourth") { releaseFourth(); return new Response("ok"); }
    if (path === "/__test/release-retry") { releaseRetry(); return new Response("ok"); }
    if (path === "/__test/later-message") {
      trailing = [{ ...base, id: "later", text: "发送后的回复" }];
      await host.refresh();
      return new Response("ok");
    }
    if (path === "/__test/intervening-message") {
      trailing = [{ ...base, id: "intervening", text: "中间的回复" }];
      await host.refresh();
      return new Response("ok");
    }
    if (path === "/__test/mode-failed") { await fixture.control({ action: "mode", state: "failed" }); return new Response("ok"); }
    if (path === "/__test/mode-submitted") { await fixture.control({ action: "mode", state: "submitted" }); return new Response("ok"); }
    if (path.startsWith("/api/chat/media/generated/")) return new Response(fixtureImage, { headers: { "content-type": "image/png" } });
    if (path.startsWith("/api/audio/")) return new Response(wav, { headers: { "content-type": "audio/wav" } });
    const response = await imageHttp(request, fixture.imageBackend, async () => ({ sessionId: "fixture-session", limits: fixture.limits }));
    return response ?? staticAssets(resolve("apps/web/build"), path);
  },
  websocket: {
    open(socket) { channels.set(socket, host.connect(socket, async () => true)); },
    message(socket, raw) { void channels.get(socket).receive(String(raw)); },
    close(socket) { channels.get(socket)?.close(); channels.delete(socket); },
  },
});
const browser = await chromium.launch({ headless: true, executablePath: process.env.APP_ACCEPTANCE_BROWSER });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  await context.addInitScript(denyNativeNotifications);
  const page = await context.newPage();
  const errors = [], mediaRequests = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/chat/media/") && !path.includes("/generated/")) mediaRequests.push(path);
  });
  const url = `http://127.0.0.1:${server.port}/`;
  await page.goto(url);
  await expect(page.getByText("先看看这张图片。", { exact: true })).toHaveCount(1);
  const loading = page.getByTestId("image-picture:image:");
  await expect(loading.getByRole("status")).toBeVisible();
  await expect(loading.locator(".preloader")).toBeVisible();
  await expect(page.getByRole("region", { name: "语音播放器" })).toBeVisible();
  const ordered = await page.locator(".companion-timeline-content").evaluate((node) => {
    const image = node.querySelector('[data-testid="image-picture:image:"]');
    const voice = node.querySelector('[aria-label="语音播放器"]');
    return !!image && !!voice && !!(image.compareDocumentPosition(voice) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(ordered).toBe(true);
  await mkdir(".scratch/ordered-timeline", { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: ".scratch/ordered-timeline/loading-390.png" });
  await page.getByRole("button", { name: "播放语音" }).click();
  await expect(page.getByRole("button", { name: "暂停语音" })).toBeVisible();
  await context.request.post(new URL("/__test/finish-picture", url).href);
  await expect(loading.locator("img")).toBeVisible();
  await expect(loading.getByRole("status")).toHaveCount(0);
  await context.request.post(new URL("/__test/unknown-picture", url).href);
  await expect(loading.getByText("暂时无法确认图片状态。", { exact: true })).toBeVisible();

  const choose = page.locator("#companion-image-library");
  const photo = { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(fixtureImage) };
  await choose.setInputFiles([photo, photo]);
  await page.locator("#companion-textarea").fill("发给你");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const sent = page.locator(".companion-image-entry img[alt='photo.png']");
  await expect(sent).toHaveCount(2);
  await expect(page.getByText("正在发送…", { exact: true })).toBeVisible();
  const localSrc = await sent.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  expect(localSrc.every((src) => src?.startsWith("blob:"))).toBe(true);
  await sent.evaluateAll((nodes) => { window.__sentPreviews = nodes; });
  const secondPhoto = { ...photo, name: "second.png" };
  await choose.setInputFiles([secondPhoto, secondPhoto]);
  await page.locator("#companion-textarea").fill("第二条图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const secondImages = page.locator(".companion-image-entry img[alt='second.png']");
  await expect(secondImages).toHaveCount(2);
  await secondImages.evaluateAll((nodes) => { window.__secondPreviews = nodes; });
  await context.request.post(new URL("/__test/later-message", url).href);
  const follows = async (before, after) => page.evaluate(({ before, after }) => {
    const nodes = [...document.querySelectorAll(".companion-timeline-content *")];
    const first = nodes.find((node) => node.textContent === before);
    const second = nodes.find((node) => node.textContent === after);
    return !!first && !!second && !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, { before, after });
  await expect(page.getByText("发送后的回复", { exact: true })).toBeVisible();
  expect(await follows("发给你", "发送后的回复")).toBe(true);
  expect(await follows("发给你", "第二条图片")).toBe(true);
  await context.request.post(new URL("/__test/release-submit", url).href);
  await expect.poll(async () => (await fixture.control({ action: "state" })).messages.filter((m) => m.text === "发给你").length).toBe(1);
  await expect.poll(() => follows("发给你", "第二条图片")).toBe(true);
  await expect(secondImages).toHaveCount(2);
  await expect.poll(() => secondImages.evaluateAll((nodes) => nodes.every((node, index) => node === window.__secondPreviews[index]))).toBe(true);
  expect(mediaRequests).toEqual([]);
  await context.request.post(new URL("/__test/release-second", url).href);
  await expect.poll(async () => (await fixture.control({ action: "state" })).messages.filter((m) => m.text === "第二条图片").length).toBe(1);
  await expect(page.getByText("正在发送…", { exact: true })).toHaveCount(0);
  await expect(sent).toHaveCount(2);
  await expect.poll(() => sent.evaluateAll((nodes) => nodes.every((node, index) => node === window.__sentPreviews[index]))).toBe(true);
  expect(await sent.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")))).toEqual(localSrc);
  expect(mediaRequests).toEqual([]);

  const thirdPhoto = { ...photo, name: "third.png" };
  await choose.setInputFiles([thirdPhoto]);
  await page.locator("#companion-textarea").fill("第三条图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("第三条图片", { exact: true })).toBeVisible();
  await context.request.post(new URL("/__test/intervening-message", url).href);
  await expect(page.getByText("中间的回复", { exact: true })).toBeVisible();
  const fourthPhoto = { ...photo, name: "fourth.png" };
  await choose.setInputFiles([fourthPhoto]);
  await page.locator("#companion-textarea").fill("第四条图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const fourthImage = page.locator(".companion-image-entry img[alt='fourth.png']");
  await expect(fourthImage).toHaveCount(1);
  await fourthImage.evaluateAll((nodes) => { window.__fourthPreview = nodes[0]; });
  expect(await follows("第三条图片", "中间的回复")).toBe(true);
  expect(await follows("中间的回复", "第四条图片")).toBe(true);
  await context.request.post(new URL("/__test/release-third", url).href);
  await expect.poll(async () => (await fixture.control({ action: "state" })).messages.filter((m) => m.text === "第三条图片").length).toBe(1);
  await expect.poll(() => follows("中间的回复", "第四条图片")).toBe(true);
  await expect.poll(() => fourthImage.evaluate((node) => node === window.__fourthPreview)).toBe(true);
  expect(mediaRequests).toEqual([]);
  await context.request.post(new URL("/__test/release-fourth", url).href);
  await expect.poll(async () => (await fixture.control({ action: "state" })).messages.filter((m) => m.text === "第四条图片").length).toBe(1);
  await expect(page.getByText("正在发送…", { exact: true })).toHaveCount(0);

  await context.request.post(new URL("/__test/mode-failed", url).href);
  const retryPhoto = { ...photo, name: "retry.png" };
  await choose.setInputFiles([retryPhoto, retryPhoto]);
  await page.locator("#companion-textarea").fill("重试图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const retryImages = page.locator(".companion-image-entry img[alt='retry.png']");
  await expect(retryImages).toHaveCount(2);
  const failed = page.locator(".message-sent").filter({ hasText: "重试图片" }).getByTestId(/failed-/);
  await expect(failed).toBeVisible();
  const retrySrc = await retryImages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  await retryImages.evaluateAll((nodes) => { window.__retryPreviews = nodes; });
  await context.request.post(new URL("/__test/mode-submitted", url).href);
  await failed.click();
  await page.locator(".companion-action-menu").getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("重试后的回复", { exact: true })).toBeVisible();
  await expect(page.getByText("正在发送…", { exact: true })).toBeVisible();
  await expect(retryImages).toHaveCount(2);
  expect(await follows("重试图片", "重试后的回复")).toBe(true);
  await context.request.post(new URL("/__test/release-retry", url).href);
  await expect.poll(async () => (await fixture.control({ action: "state" })).messages.filter((m) => m.text === "重试图片").length).toBe(1);
  await expect(failed).toHaveCount(0);
  await expect(page.getByText("正在发送…", { exact: true })).toHaveCount(0);
  await expect(retryImages).toHaveCount(2);
  await expect.poll(() => retryImages.evaluateAll((nodes) => nodes.every((node, index) => node === window.__retryPreviews[index]))).toBe(true);
  expect(await retryImages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")))).toEqual(retrySrc);
  expect(mediaRequests).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
  console.log("ordered timeline: placeholder, immediate voice, preview dedupe and no confirmation fetch passed");
} finally {
  await browser.close();
  host.close();
  for (const socket of channels.keys()) socket.terminate();
  server.stop(true);
}
