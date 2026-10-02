import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import {
  parseVoiceControl,
  validateVoiceFrameBytes,
} from "../packages/contracts/dist/voice.js";
import { fixtureBackend } from "./fixture.ts";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const fixture = fixtureBackend();
const host = await createChatHost(fixture.backend);
const channels = new Map();
const takes = [];
let capability = { available: true };
let transcript = "recognized final";
let holdResult = false;
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/voice/capability") return Response.json(capability);
    if (
      path === "/api/voice/stream" &&
      server.upgrade(req, { data: { voice: true } })
    )
      return;
    if (
      path === "/api/chat/socket" &&
      server.upgrade(req, { data: { voice: false } })
    )
      return;
    const target = resolve(
      assets,
      path.replace(/^\/slice\/?/, "") || "index.html",
    );
    if (!target.startsWith(`${assets}/`))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(target);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (!ws.data.voice) {
        channels.set(
          ws,
          host.connect(ws, async () => true),
        );
        return;
      }
      const take = {
        ws,
        frames: [],
        bytes: 0,
        controls: [],
        closed: false,
        finishedBytes: 0,
        text: transcript,
        hold: holdResult,
      };
      takes.push(take);
      ws.data.take = take;
      ws.send(JSON.stringify({ type: "ready" }));
    },
    message(ws, raw) {
      if (!ws.data.voice) {
        void channels.get(ws).receive(String(raw));
        return;
      }
      const take = ws.data.take;
      if (typeof raw === "string") {
        const control = parseVoiceControl(raw);
        take.controls.push(control.type);
        if (control.type === "finish") {
          take.finishedBytes = take.bytes;
          expect(take.bytes).toBeGreaterThan(0);
          if (!take.hold)
            ws.send(JSON.stringify({ type: "result", text: take.text }));
        }
      } else {
        take.bytes = validateVoiceFrameBytes(raw.byteLength, take.bytes);
        take.frames.push(new Uint8Array(raw));
      }
    },
    close(ws) {
      if (ws.data.voice) ws.data.take.closed = true;
      else {
        channels.get(ws)?.close();
        channels.delete(ws);
      }
    },
  },
});
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const origin = `http://127.0.0.1:${server.port}`;
const screenshots = ".scratch/streaming-voice-input/screenshots";
await mkdir(screenshots, { recursive: true });
try {
  for (const width of [390, 1280]) {
    capability = { available: true };
    transcript = "recognized final";
    holdResult = false;
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      permissions: ["microphone"],
    });
    // Observe genuine browser capture resources without replacing capture or worklet behavior.
    await context.addInitScript(() => {
      window.voiceProbe = { tracks: [], rates: [] };
      if (!navigator.mediaDevices) return;
      const get = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await get(...args);
        window.voiceProbe.tracks.push(...stream.getTracks());
        return stream;
      };
      const Audio = window.AudioContext;
      window.AudioContext = class extends Audio {
        constructor(options) {
          super(options);
          window.voiceProbe.rates.push(this.sampleRate);
        }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/slice/`);
    const input = page.locator("#companion-textarea");
    const mic = page.locator(".companion-microphone");
    const cancel = page.locator(".companion-attach");
    const send = page.locator(".companion-send");
    const released = () =>
      expect
        .poll(() =>
          page.evaluate(() =>
            window.voiceProbe.tracks.every((t) => t.readyState === "ended"),
          ),
        )
        .toBe(true);
    const latest = () => takes.at(-1);
    const start = async () => {
      const count = takes.length;
      await expect(mic).toBeEnabled();
      await mic.click();
      await expect(mic).toHaveAttribute("data-state", "recording");
      await expect.poll(() => takes.length).toBe(count + 1);
      await expect.poll(() => latest().bytes).toBeGreaterThan(0);
      return latest();
    };
    await expect(input).toBeVisible();
    // Images and other disconnected actions remain hidden.
    await expect(cancel).toHaveCount(0);
    await input.fill("before REPLACE after");
    await input.evaluate((el) => {
      el.focus();
      el.setSelectionRange(7, 14);
    });
    const before = fixture.executions;
    const take = await start();
    expect(take.controls).toEqual([]); // PCM arrives while recording, before finish.
    expect(take.frames[0].byteLength).toBe(3200);
    await expect
      .poll(() => take.frames.some((frame) => frame.some((byte) => byte !== 0)))
      .toBe(true);
    expect(await page.evaluate(() => window.voiceProbe.rates)).toEqual([16000]);
    await expect(input).toHaveValue("before REPLACE after");
    await expect(send).toBeDisabled();
    await page.screenshot({
      path: `${screenshots}/recording-${width}.png`,
      fullPage: true,
    });
    await mic.click();
    await expect(input).toHaveValue("before recognized final after");
    expect(take.controls).toEqual(["finish"]);
    expect(take.finishedBytes).toBe(take.bytes);
    await released();
    expect(fixture.executions).toBe(before);
    await input.fill(`edited final ${width}`);
    await send.click();
    await expect.poll(() => fixture.executions).toBe(before + 1);
    await fixture.complete("fake reply");

    await input.fill("cancel draft");
    const cancelled = await start();
    await cancel.click();
    await expect(mic).toHaveAttribute("data-state", "idle");
    await expect.poll(() => cancelled.controls).toEqual(["cancel"]);
    await released();
    await expect(input).toHaveValue("cancel draft");
    await page.screenshot({
      path: `${screenshots}/cancel-${width}.png`,
      fullPage: true,
    });

    // Cancel during finalization, then deliver a late completion from the old take.
    holdResult = true;
    const stale = await start();
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await cancel.click();
    await input.fill("new draft");
    stale.ws.send(JSON.stringify({ type: "result", text: "late old result" }));
    await expect(input).toHaveValue("new draft");
    await released();
    // A fresh take must still complete after old cancellation.
    holdResult = false;
    transcript = "fresh result";
    await start();
    await mic.click();
    await expect(input).toHaveValue("new draftfresh result");
    expect(fixture.executions).toBe(before + 1);

    await input.fill("error draft");
    const failed = await start();
    failed.ws.send(JSON.stringify({ type: "error", code: "upstream_error" }));
    await expect(
      page.locator('[data-testid="companion-voice-error-status"]'),
    ).toBeVisible();
    await expect(input).toHaveValue("error draft");
    await released();
    await page.screenshot({
      path: `${screenshots}/error-${width}.png`,
      fullPage: true,
    });

    const disconnected = await start();
    // Lose the text observation channel: capture and voice transport must both stop.
    for (const ws of channels.keys()) ws.close();
    await expect.poll(() => disconnected.closed).toBe(true);
    await released();
    await expect(input).toHaveValue("error draft");
    await expect(mic).toBeEnabled(); // text connection recovers

    transcript = "x".repeat(16_001);
    await input.fill("");
    await start();
    await mic.click();
    await expect(input).toHaveValue(transcript);
    await expect(send).toBeDisabled();
    await input.fill("shortened");
    await expect(send).toBeEnabled();
    expect(fixture.executions).toBe(before + 1);

    // Actual rate mismatch fails without sending mislabeled audio or adding a resampler.
    const priorTakes = takes.length;
    await page.evaluate(() => {
      const Audio = window.AudioContext;
      window.AudioContext = class extends Audio {
        constructor() {
          super({ sampleRate: 48000 });
        }
      };
    });
    await mic.click();
    await expect(
      page.locator('[data-testid="companion-voice-error-status"]'),
    ).toBeVisible();
    await expect(input).toHaveValue("shortened");
    expect(takes.length).toBe(priorTakes);
    await released();

    // Refused microphone must preserve draft and allow text send.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Denied", "NotAllowedError");
      };
    });
    await mic.click();
    await expect(
      page.locator('[data-testid="companion-voice-error-status"]'),
    ).toBeVisible();
    await expect(input).toHaveValue("shortened");
    await expect(send).toBeEnabled();
    await released();

    // Navigation closes an in-flight take, preventing results on a disposed page.
    await page.reload();
    await input.fill("navigation draft");
    const navigating = await start();
    await page.goto("about:blank");
    await expect.poll(() => navigating.closed).toBe(true);
    await page.goto(`${origin}/slice/`);
    await expect(input).toHaveValue("");
    expect(fixture.executions).toBe(before + 1);

    capability = { available: false };
    await page.reload();
    await expect(mic).toBeDisabled();
    await expect(
      page.locator('[data-testid="companion-voice-unavailable-status"]'),
    ).toBeVisible();
    await input.fill(`disabled text ${width}`);
    await send.click();
    await expect.poll(() => fixture.executions).toBe(before + 2);
    await fixture.complete();
    await page.screenshot({
      path: `${screenshots}/disabled-${width}.png`,
      fullPage: true,
    });
    // Malformed/unreachable capability does not offer capture or break text.
    capability = { available: true, unexpected: "field" };
    await page.reload();
    await expect(mic).toBeDisabled();
    await input.fill("still text");
    await expect(send).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Voice browser acceptance passed at 390px/1280px: actual 16kHz streaming PCM, final selected draft, explicit send, cancel/stale, errors, disconnect, mic refusal, oversized draft, disabled capability and text recovery.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  for (const take of takes) take.ws.terminate();
  server.unref();
  void server.stop(true);
}
