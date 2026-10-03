import { denyNativeNotifications } from "./notification-permission.mjs";
import { staticAssets } from "./static-assets.mjs";
import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import {
  parseVoiceControl,
  validateVoiceFrameBytes,
} from "../packages/contracts/dist/voice.js";
import { fixtureBackend } from "./fixture.ts";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const external = process.env.APP_ACCEPTANCE_URL;
if (external && !process.env.APP_ACCEPTANCE_CONTROL_URL)
  throw new Error("Actual host requires test-owned APP_ACCEPTANCE_CONTROL_URL");
const fixture = fixtureBackend();
const host = await createChatHost(fixture.backend);
const channels = new Map();
const takes = [];
let availability = "enabled";
let transcript = "recognized final";
let holdResult = false;
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = external
  ? undefined
  : Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__test/voice") {
          const input = await req.json();
          if (input.action === "reset") {
            fixture.reset();
            takes.length = 0;
            availability = "enabled";
            transcript = "recognized final";
            holdResult = false;
          }
          if (input.action === "speech") {
            if (input.availability !== undefined)
              availability = input.availability;
            if (input.text !== undefined) transcript = input.text;
            if (input.hold !== undefined) holdResult = input.hold;
          }
          if (input.action === "complete") await fixture.complete(input.text);
          if (input.action === "disconnect")
            for (const ws of channels.keys()) ws.close();
          if (input.action === "result")
            takes
              .find((take) => take.id === input.takeId)
              .ws.send(JSON.stringify({ type: "result", text: input.text }));
          if (input.action === "error")
            takes
              .find((take) => take.id === input.takeId)
              .ws.send(JSON.stringify({ type: "error", code: input.code }));
          return Response.json({
            executions: fixture.executions,
            takes: takes.map(
              ({ id, bytes, frames, controls, closed, finishedBytes }) => ({
                id,
                bytes,
                controls,
                closed,
                finishedBytes,
                firstFrame: frames[0] ? Array.from(frames[0]) : [],
                nonzero: frames.some((frame) =>
                  frame.some((byte) => byte !== 0),
                ),
              }),
            ),
          });
        }
        if (path === "/api/voice/capability")
          return availability === "unreachable"
            ? new Response(null, { status: 503 })
            : Response.json({ available: availability === "enabled" });
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
        return staticAssets(assets, path);
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
            id: crypto.randomUUID(),
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
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const url = external ?? `http://127.0.0.1:${server.port}/`;
const controlUrl =
  process.env.APP_ACCEPTANCE_CONTROL_URL ?? new URL("/__test/voice", url).href;
const screenshots =
  process.env.APP_ACCEPTANCE_EVIDENCE ??
  ".scratch/default-shared-frontend/voice";
await mkdir(screenshots, { recursive: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      permissions: ["microphone"],
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
    const state = () => control({ action: "state" });
    const observe = async (take) =>
      (await state()).takes.find((current) => current.id === take.id);
    await control({ action: "reset" });
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
    await context.addInitScript(denyNativeNotifications);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    const input = page.locator("#companion-textarea");
    const mic = page.locator(".companion-microphone");
    const cancel = page.getByRole("button", { name: "取消录音", exact: true });
    const send = page.locator(".companion-send");
    const released = () =>
      expect
        .poll(() =>
          page.evaluate(() =>
            window.voiceProbe.tracks.every((t) => t.readyState === "ended"),
          ),
        )
        .toBe(true);
    const latest = async () => (await state()).takes.at(-1);
    const start = async () => {
      const count = (await state()).takes.length;
      await expect(mic).toBeEnabled();
      await mic.click();
      await expect(mic).toHaveAttribute("data-state", "recording");
      await expect(cancel).toBeVisible();
      await expect
        .poll(async () => (await state()).takes.length)
        .toBe(count + 1);
      await expect.poll(async () => (await latest()).bytes).toBeGreaterThan(0);
      return latest();
    };
    await expect(input).toBeVisible();
    // Idle image picking is independent of the voice cancellation action.
    await expect(cancel).toHaveCount(0);
    await input.fill("before REPLACE after");
    await input.evaluate((el) => {
      el.focus();
      el.setSelectionRange(7, 14);
    });
    const before = (await state()).executions;
    const take = await start();
    expect((await observe(take)).controls).toEqual([]); // PCM arrives while recording, before finish.
    expect((await observe(take)).firstFrame.length).toBe(3200);
    await expect.poll(async () => (await observe(take)).nonzero).toBe(true);
    expect(await page.evaluate(() => window.voiceProbe.rates)).toEqual([16000]);
    await expect(input).toHaveValue("before REPLACE after");
    await expect(send).toBeDisabled();
    await page.screenshot({
      path: `${screenshots}/recording-${width}.png`,
      fullPage: true,
    });
    await mic.click();
    await expect(input).toHaveValue("before recognized final after");
    expect((await observe(take)).controls).toEqual(["finish"]);
    const finished = await observe(take);
    expect(finished.finishedBytes).toBe(finished.bytes);
    await released();
    expect((await state()).executions).toBe(before);
    await input.fill(`edited final ${width}`);
    await send.click();
    await expect.poll(async () => (await state()).executions).toBe(before + 1);
    await control({ action: "complete", text: "fake reply" });

    await input.fill("cancel draft");
    const cancelled = await start();
    await cancel.click();
    await expect(mic).toHaveAttribute("data-state", "idle");
    await expect
      .poll(async () => (await observe(cancelled)).controls)
      .toEqual(["cancel"]);
    await released();
    await expect(input).toHaveValue("cancel draft");
    await page.screenshot({
      path: `${screenshots}/cancel-${width}.png`,
      fullPage: true,
    });

    // Cancel during finalization, then deliver a late completion from the old take.
    await control({ action: "speech", hold: true });
    const stale = await start();
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await expect(cancel).toBeVisible();
    await cancel.click();
    await input.fill("new draft");
    await control({
      action: "result",
      takeId: stale.id,
      text: "late old result",
    });
    await expect(input).toHaveValue("new draft");
    await released();
    // A fresh take must still complete after old cancellation.
    await control({ action: "speech", hold: false, text: "fresh result" });
    await start();
    await mic.click();
    await expect(input).toHaveValue("new draftfresh result");
    expect((await state()).executions).toBe(before + 1);

    await input.fill("error draft");
    const failed = await start();
    await control({
      action: "error",
      takeId: failed.id,
      code: "upstream_error",
    });
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
    await control({ action: "disconnect" });
    await expect
      .poll(async () => (await observe(disconnected)).closed)
      .toBe(true);
    await released();
    await expect(input).toHaveValue("error draft");
    await expect(mic).toBeEnabled(); // text connection recovers

    const oversized = "x".repeat(16_001);
    await control({ action: "speech", text: oversized });
    await input.fill("");
    await start();
    await mic.click();
    await expect(input).toHaveValue(oversized);
    await expect(send).toBeDisabled();
    await input.fill("shortened");
    await expect(send).toBeEnabled();
    expect((await state()).executions).toBe(before + 1);

    // Actual rate mismatch fails without sending mislabeled audio or adding a resampler.
    const priorTakes = (await state()).takes.length;
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
    expect((await state()).takes.length).toBe(priorTakes);
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
    await expect
      .poll(async () => (await observe(navigating)).closed)
      .toBe(true);
    await page.goto(url);
    await expect(input).toHaveValue("");
    expect((await state()).executions).toBe(before + 1);

    await control({ action: "speech", availability: "disabled" });
    await page.reload();
    await expect(mic).toBeDisabled();
    await expect(
      page.locator('[data-testid="companion-voice-unavailable-status"]'),
    ).toBeVisible();
    await input.fill(`disabled text ${width}`);
    await send.click();
    await expect.poll(async () => (await state()).executions).toBe(before + 2);
    await control({ action: "complete" });
    await page.screenshot({
      path: `${screenshots}/disabled-${width}.png`,
      fullPage: true,
    });
    // Malformed/unreachable capability does not offer capture or break text.
    await control({ action: "speech", availability: "unreachable" });
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
  server?.unref();
  void server?.stop(true);
}
