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
let holdReady = false;
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
            holdReady = false;
          }
          if (input.action === "speech") {
            if (input.availability !== undefined)
              availability = input.availability;
            if (input.text !== undefined) transcript = input.text;
            if (input.hold !== undefined) holdResult = input.hold;
            if (input.holdReady !== undefined) holdReady = input.holdReady;
          }
          if (input.action === "ready") {
            const take = takes.find((take) => take.id === input.takeId);
            if (!take.closed && !take.ready) {
              take.ready = true;
              take.events.push("ready");
              take.ws.send(JSON.stringify({ type: "ready" }));
            }
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
              ({
                id,
                bytes,
                frames,
                controls,
                closed,
                finishedBytes,
                ready,
                events,
              }) => ({
                id,
                bytes,
                controls,
                closed,
                finishedBytes,
                ready,
                events,
                frames: frames.map((frame) => Array.from(frame)),
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
            ready: !holdReady,
            events: holdReady ? [] : ["ready"],
          };
          takes.push(take);
          ws.data.take = take;
          if (take.ready) ws.send(JSON.stringify({ type: "ready" }));
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
            take.events.push(control.type);
            if (control.type === "finish") {
              expect(take.ready).toBe(true);
              take.finishedBytes = take.bytes;
              expect(take.bytes).toBeGreaterThan(0);
              if (!take.hold)
                ws.send(JSON.stringify({ type: "result", text: take.text }));
            }
          } else {
            expect(take.ready).toBe(true);
            take.events.push("pcm");
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
      window.voiceProbe = {
        tracks: [],
        rates: [],
        contexts: [],
        nodes: [],
        sources: [],
        frames: [],
        firstPCM: 0,
        readyAt: 0,
      };
      const Worklet = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends Worklet {
        constructor(...args) {
          super(...args);
          window.voiceProbe.nodes.push(this);
          this.port.addEventListener("message", (event) => {
            if (event.data instanceof ArrayBuffer) {
              window.voiceProbe.firstPCM ||= performance.now();
              window.voiceProbe.frames.push(
                Array.from(new Uint8Array(event.data)),
              );
            }
          });
        }
      };
      const disconnect = Worklet.prototype.disconnect;
      window.AudioWorkletNode.prototype.disconnect = function (...args) {
        this.released = true;
        return disconnect.apply(this, args);
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes("/api/voice/stream")) {
            this.addEventListener("message", (event) => {
              if (JSON.parse(event.data).type === "ready")
                window.voiceProbe.readyAt = performance.now();
            });
          }
        }
        get bufferedAmount() {
          return window.voiceBackpressure ?? super.bufferedAmount;
        }
      };
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
          window.voiceProbe.contexts.push(this);
        }
        createMediaStreamSource(stream) {
          const source = super.createMediaStreamSource(stream);
          window.voiceProbe.sources.push(source);
          const disconnect = source.disconnect.bind(source);
          source.disconnect = (...args) => {
            source.released = true;
            return disconnect(...args);
          };
          return source;
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
          page.evaluate(
            () =>
              window.voiceProbe.tracks.every((t) => t.readyState === "ended") &&
              window.voiceProbe.contexts.every((c) => c.state === "closed") &&
              [...window.voiceProbe.nodes, ...window.voiceProbe.sources].every(
                (n) => n.released,
              ),
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
    // Built worklet must produce real PCM before recognition readiness, then release
    // capture on early Stop while retaining exact ordered frames for deferred finish.
    await control({ action: "speech", holdReady: true });
    await input.fill("early draft");
    const clickAt = await page.evaluate(() => performance.now());
    await mic.click();
    await expect
      .poll(() => page.evaluate(() => window.voiceProbe.firstPCM))
      .toBeGreaterThan(0);
    await expect(mic).toHaveAttribute("data-state", "recording");
    const early = await latest();
    expect(early.ready).toBe(false);
    expect(early.bytes).toBe(0);
    await page.screenshot({
      path: `${screenshots}/local-before-ready-${width}.png`,
      fullPage: true,
    });
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await released();
    expect(
      await page.evaluate(() =>
        window.voiceProbe.contexts.every((c) => c.state === "closed"),
      ),
    ).toBe(true);
    expect((await observe(early)).controls).toEqual([]);
    const captured = await page.evaluate(() => window.voiceProbe.frames);
    expect(captured.length).toBeGreaterThan(0);
    await control({ action: "ready", takeId: early.id });
    await expect(input).toHaveValue("early draftrecognized final");
    const delivered = await observe(early);
    expect(delivered.frames).toEqual(captured);
    expect(delivered.events).toEqual([
      "ready",
      ...captured.map(() => "pcm"),
      "finish",
    ]);
    const timing = await page.evaluate(() => ({
      firstPCM: window.voiceProbe.firstPCM,
      ready: window.voiceProbe.readyAt,
    }));
    expect(timing.firstPCM).toBeLessThan(timing.ready);
    console.log(
      JSON.stringify({
        width,
        clickToFirstPCM: timing.firstPCM - clickAt,
        clickToReady: timing.ready - clickAt,
        frames: captured.length,
        bytes: delivered.bytes,
        frameSizes: captured.map((frame) => frame.length),
        captureReleasedBeforeReady: true,
      }),
    );
    await page.screenshot({
      path: `${screenshots}/early-stop-idle-${width}.png`,
      fullPage: true,
    });
    await control({ action: "speech", holdReady: false });
    await page.reload();
    await input.fill("early draftrecognized final");
    // Transport can become ready while permission remains held; no optimistic recording.
    for (const cancelPending of [false, true]) {
      await page.evaluate(() => {
        const get = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        window.originalGet = get;
        window.pendingStream = undefined;
        window.releasePermission = undefined;
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const stream = await get(...args);
          window.pendingStream = stream;
          await new Promise((resolve) => {
            window.releasePermission = resolve;
          });
          return stream;
        };
      });
      const count = (await state()).takes.length;
      await mic.click();
      await expect
        .poll(async () => (await state()).takes.length)
        .toBe(count + 1);
      const pending = await latest();
      expect(pending.ready).toBe(true);
      await expect
        .poll(() => page.evaluate(() => Boolean(window.pendingStream)))
        .toBe(true);
      await expect(mic).toHaveAttribute("data-state", "starting");
      if (cancelPending) await cancel.click();
      await page.evaluate(() => {
        window.releasePermission();
        navigator.mediaDevices.getUserMedia = window.originalGet;
      });
      if (cancelPending) {
        await released();
        await expect(mic).toHaveAttribute("data-state", "idle");
        expect((await observe(pending)).bytes).toBe(0);
      } else {
        await expect(mic).toHaveAttribute("data-state", "recording");
        await expect
          .poll(async () => (await observe(pending)).bytes)
          .toBeGreaterThan(0);
        await cancel.click();
        await released();
      }
      await expect.poll(async () => (await observe(pending)).closed).toBe(true);
      await expect(input).toHaveValue("early draftrecognized final");
    }
    // Combined output budget and queued delivery: block only after capture flush,
    // then observe ready without any PCM/finish, and unblock exact original bytes.
    await control({ action: "speech", holdReady: true });
    const queuedStart = async () => {
      await page.evaluate(() => {
        window.voiceProbe.frames = [];
        window.voiceProbe.readyAt = 0;
      });
      await mic.click();
      await expect(mic).toHaveAttribute("data-state", "recording");
      await expect.poll(async () => (await latest()).ready).toBe(false);
      return latest();
    };
    const queued = await queuedStart();
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await released();
    const queuedFrames = await page.evaluate(() => window.voiceProbe.frames);
    await page.evaluate(() => {
      window.voiceBackpressure = 262144;
    });
    await control({ action: "ready", takeId: queued.id });
    await expect
      .poll(() => page.evaluate(() => window.voiceProbe.readyAt))
      .toBeGreaterThan(0);
    await page.waitForTimeout(50); // let multiple drain polls run while blocked
    expect((await observe(queued)).bytes).toBe(0);
    expect((await observe(queued)).controls).toEqual([]);
    await page.evaluate(() => {
      window.voiceBackpressure = 0;
    });
    await expect(mic).toHaveAttribute("data-state", "idle");
    expect((await observe(queued)).frames).toEqual(queuedFrames);
    expect((await observe(queued)).controls).toEqual(["finish"]);
    await page.evaluate(() => {
      delete window.voiceBackpressure;
    });

    // Queue cancellation drops buffered PCM; late ready/result cannot revive the draft.
    await input.fill("bounded draft");
    const dropped = await queuedStart();
    await cancel.click();
    await released();
    await control({ action: "ready", takeId: dropped.id });
    await control({ action: "result", takeId: dropped.id, text: "discarded" });
    expect((await observe(dropped)).bytes).toBe(0);
    await expect(input).toHaveValue("bounded draft");

    const overflow = await queuedStart();
    await expect(mic).toHaveAttribute("data-state", "idle", { timeout: 8000 });
    await released();
    expect((await observe(overflow)).bytes).toBe(0);
    await expect(
      page.locator('[data-testid="companion-voice-error-status"]'),
    ).toBeVisible();
    await expect(input).toHaveValue("bounded draft");
    // Local observer includes the rejected 51st frame; retained queue is only 50 frames.
    expect(
      (await page.evaluate(() => window.voiceProbe.frames)).reduce(
        (n, f) => n + f.length,
        0,
      ),
    ).toBe(163200);

    // Reject when queued plus outbound bytes exceed 256 KiB, before the 5s FIFO cap.
    const combined = await queuedStart();
    await page.evaluate(() => {
      window.voiceBackpressure = 250000;
    });
    await expect(mic).toHaveAttribute("data-state", "idle");
    await released();
    expect((await observe(combined)).bytes).toBe(0);
    expect(
      (await page.evaluate(() => window.voiceProbe.frames)).reduce(
        (n, f) => n + f.length,
        0,
      ),
    ).toBeLessThan(160000);
    await page.evaluate(() => {
      delete window.voiceBackpressure;
    });

    // Preserve the 15s startup deadline even after early Stop released capture.
    // Virtual browser timers affect the client only; worklet PCM remains real.
    await page.clock.install();
    const timeout = await queuedStart();
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await released();
    await page.clock.runFor(15001);
    await expect(mic).toHaveAttribute("data-state", "idle");
    await expect.poll(async () => (await observe(timeout)).closed).toBe(true);
    expect((await observe(timeout)).controls).toEqual([]);
    await expect(input).toHaveValue("bounded draft");
    await page.clock.resume();

    // A result received before our finish is rejected, even after early Stop.
    const premature = await queuedStart();
    await mic.click();
    await expect(mic).toHaveAttribute("data-state", "transcribing");
    await control({
      action: "result",
      takeId: premature.id,
      text: "premature",
    });
    await expect(mic).toHaveAttribute("data-state", "idle");
    await released();
    await expect(input).toHaveValue("bounded draft");

    // Page lifecycle cancellation also discards unsent local audio.
    const hidden = await queuedStart();
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(mic).toHaveAttribute("data-state", "idle");
    await released();
    await expect.poll(async () => (await observe(hidden)).closed).toBe(true);
    expect((await observe(hidden)).bytes).toBe(0);
    await control({ action: "speech", holdReady: false });
    await page.reload();
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
    await expect
      .poll(async () =>
        (await state()).takes.slice(priorTakes).every((take) => take.closed),
      )
      .toBe(true);
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
    "Voice browser acceptance passed at 390px/1280px: local-first/remote-first actual 16kHz PCM, early-stop ordered delivery, bounded queue/backpressure/deadlines/release, final selected draft, explicit send, cancel/stale, errors, disconnect, mic refusal, oversized draft, disabled capability and text recovery.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  for (const take of takes) take.ws.terminate();
  server?.unref();
  void server?.stop(true);
}
