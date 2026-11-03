import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";

// A synthetic WAV served at the same-origin voice URL: no user media is read.
const pcmBytes = 8000 * 2 * 4;
const wav = Buffer.alloc(44 + pcmBytes);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcmBytes, 40);

const fixture = fixtureBackend();
const voice = (id, audioId) => ({ id, role: "agent", text: "", voice: { id: audioId }, createdAt: 1, operationId: null, turnId: "turn" });
const current = { ...voice("current", "a".repeat(64)), images: [{ attachmentId: "voice", name: "example.png", mediaType: "image/png", availability: "missing" }] };
const older = voice("older", "b".repeat(64));
const backend = { ...fixture.backend,
  async read() { return { ...await fixture.backend.read(), messages: [current], before: "older" }; },
  async history() { return { messages: [older], before: null }; },
};
const host = await createChatHost(backend);
const channels = new Map();
const requests = [];
let failAudio = false;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(request)) return;
    if (path === "/__test/fail-audio") { failAudio = !failAudio; return new Response("ok"); }
    if (path.startsWith("/api/audio/")) {
      requests.push(path);
      if (failAudio) return new Response("missing", { status: 404 });
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    }
    return staticAssets(resolve("apps/web/build"), path);
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
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const players = page.getByRole("region", { name: "语音播放器" });
  await expect(players).toHaveCount(1);
  await expect(page.getByTestId("image-current:voice")).toBeVisible();
  await expect(players.first().getByRole("button", { name: "播放语音" })).toBeVisible();
  await players.first().getByRole("button", { name: "播放语音" }).click();
  await expect(players.first().getByRole("button", { name: "暂停语音" })).toBeVisible();
  expect(requests).toContain(`/api/audio/${"a".repeat(64)}.mp3`);
  const seek = players.first().getByRole("slider", { name: "语音进度" });
  await expect(seek).toBeEnabled();
  await seek.fill("2");
  await expect.poll(() => players.first().locator("audio").evaluate(audio => audio.currentTime)).toBeGreaterThan(1);
  await players.first().getByRole("button", { name: "暂停语音" }).click();
  await expect(players.first().getByRole("button", { name: "播放语音" })).toBeVisible();
  await page.getByRole("button", { name: "查看更早的消息" }).click();
  await expect(players).toHaveCount(2);
  await page.reload();
  await expect(players).toHaveCount(1);
  await context.request.post(`http://127.0.0.1:${server.port}/__test/fail-audio`);
  await page.reload();
  await expect(players.first().getByText("播放失败")).toBeVisible();
  await expect(players.first().getByRole("button", { name: "播放语音" })).toBeVisible();
  await context.request.post(`http://127.0.0.1:${server.port}/__test/fail-audio`);
  await players.first().getByRole("button", { name: "播放语音" }).click();
  await expect(players.first().getByRole("button", { name: "暂停语音" })).toBeVisible();
  await expect(players.first().getByText("播放失败")).toHaveCount(0);
  await context.close();
  console.log("voice playback: same-origin load, play, seek, pause, history, reconnect and retry passed");
} finally {
  await browser.close();
  host.close();
  for (const socket of channels.keys()) socket.terminate();
  server.stop(true);
}
