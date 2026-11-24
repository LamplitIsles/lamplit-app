import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createUiTestHost } from "./ui-test-host.ts";
import { staticAssets } from "./static-assets.mjs";
import { imagesFixture } from "./images-fixture.ts";
import { imageHttp } from "../packages/contracts/src/server.ts";

const scratch = resolve(".scratch/single-photo-upload-and-webp-previews");
await mkdir(scratch, { recursive: true });
const entry = resolve(scratch, "photo-upload-entry.ts");
await writeFile(
  entry,
  `export { preparePhotoUploads } from ${JSON.stringify(resolve("apps/web/src/lib/photo-upload.ts"))};`,
);
const build = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "esm",
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await page.evaluate(async (bundle) => {
    const moduleUrl = URL.createObjectURL(
      new Blob([bundle], { type: "text/javascript" }),
    );
    const { preparePhotoUploads } = await import(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const limits = {
      mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      maxImagesPerMessage: 6,
      maxImageBytes: 5000,
      maxMessageImageBytes: 10000,
    };
    const encode = (canvas, type) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 1200, 1200);
    ctx.fillStyle = "blue";
    ctx.fillRect(1200, 0, 1200, 1200);
    const png = await encode(canvas, "image/png");
    const source = new File([png, new Uint8Array(10000)], "landscape.png", {
      type: "image/png",
    });
    const draft = (file, id = "one") => ({
      id,
      file,
      previewUrl: "blob:local",
    });
    const calls = [];
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
      calls.push([type, quality, this.width, this.height]);
      return originalToBlob.call(this, cb, type, quality);
    };
    const prepared = await preparePhotoUploads(
      "s",
      "00000000-0000-4000-8000-000000000000",
      [draft(source)],
      limits,
    );
    const item = prepared.images[0];
    const data = Uint8Array.from(atob(item.original), (c) => c.charCodeAt(0));
    const decoded = await createImageBitmap(
      new Blob([data], { type: item.mediaType }),
    );
    const dimensions = [decoded.width, decoded.height];
    decoded.close();
    const smallCanvas = document.createElement("canvas");
    smallCanvas.width = 30;
    smallCanvas.height = 20;
    const small = new File(
      [await encode(smallCanvas, "image/png")],
      "small.png",
      { type: "image/png" },
    );
    const smallResult = await preparePhotoUploads(
      "s",
      "00000000-0000-4000-8000-000000000000",
      [draft(small)],
      limits,
    );
    const jpeg = new Uint8Array(
      await (await encode(smallCanvas, "image/jpeg")).arrayBuffer(),
    );
    // Minimal EXIF TIFF with orientation 6, inserted immediately after SOI.
    const exif = Uint8Array.from([
      255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
      18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const oriented = new File(
      [jpeg.slice(0, 2), exif, jpeg.slice(2)],
      "rotated.jpg",
      { type: "image/jpeg" },
    );
    const rotated = await preparePhotoUploads(
      "s",
      "00000000-0000-4000-8000-000000000000",
      [draft(oriented)],
      limits,
    );
    const rb = Uint8Array.from(atob(rotated.images[0].original), (c) =>
      c.charCodeAt(0),
    );
    const ri = await createImageBitmap(new Blob([rb], { type: "image/webp" }));
    const orientation = [ri.width, ri.height];
    ri.close();
    const pngBytes = new Uint8Array(
      await (await encode(smallCanvas, "image/png")).arrayBuffer(),
    );
    const actl = Uint8Array.from([
      0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const apng = new File(
      [pngBytes.slice(0, 33), actl, pngBytes.slice(33)],
      "animation.png",
      { type: "image/png" },
    );
    const webp = Uint8Array.from([
      82, 73, 70, 70, 30, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0,
      2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65, 78, 73, 77, 0, 0, 0, 0,
    ]);
    const animWebp = new File([webp], "animation.webp", { type: "image/webp" });
    const gif = new File(
      [Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0])],
      "animation.gif",
      { type: "image/gif" },
    );
    const animated = [];
    for (const file of [gif, apng, animWebp]) {
      const value = await preparePhotoUploads(
        "s",
        "00000000-0000-4000-8000-000000000000",
        [draft(file)],
        limits,
      );
      animated.push([
        value.images[0].mediaType,
        value.images[0].name,
        value.images[0].original ===
          btoa(
            String.fromCharCode(...new Uint8Array(await file.arrayBuffer())),
          ),
      ]);
    }
    let oversizedRejected = false;
    try {
      await preparePhotoUploads(
        "s",
        "00000000-0000-4000-8000-000000000000",
        [draft(source)],
        { ...limits, maxImageBytes: 1 },
      );
    } catch {
      oversizedRejected = true;
    }
    let malformedRejected = false;
    try {
      await preparePhotoUploads(
        "s",
        "00000000-0000-4000-8000-000000000000",
        [
          draft(
            new File([pngBytes.slice(0, 40)], "broken.png", {
              type: "image/png",
            }),
          ),
        ],
        limits,
      );
    } catch {
      malformedRejected = true;
    }
    const huge = pngBytes.slice();
    new DataView(huge.buffer).setUint32(16, 20000);
    let decodeCalls = 0;
    const originalDecode = window.createImageBitmap;
    window.createImageBitmap = (...args) => {
      decodeCalls++;
      return originalDecode(...args);
    };
    let dimensionsRejected = false;
    try {
      await preparePhotoUploads(
        "s",
        "00000000-0000-4000-8000-000000000000",
        [draft(new File([huge], "huge.png", { type: "image/png" }))],
        limits,
      );
    } catch {
      dimensionsRejected = true;
    }
    window.createImageBitmap = originalDecode;
    let totalRejected = false;
    try {
      await preparePhotoUploads(
        "s",
        "00000000-0000-4000-8000-000000000000",
        [draft(small, "one"), draft(small, "two")],
        { ...limits, maxMessageImageBytes: 1 },
      );
    } catch {
      totalRejected = true;
    }
    return {
      keys: Object.keys(item).sort(),
      name: item.name,
      type: item.mediaType,
      dimensions,
      orientation,
      sourceSize: source.size,
      outputSize: data.length,
      calls,
      smallName: smallResult.images[0].name,
      animated,
      oversizedRejected,
      malformedRejected,
      dimensionsRejected,
      decodeCalls,
      totalRejected,
    };
  }, bundle);
  expect(result.keys).toEqual(["id", "mediaType", "name", "order", "original"]);
  expect(result.name).toBe("landscape.webp");
  expect(result.type).toBe("image/webp");
  expect(result.dimensions).toEqual([1200, 600]);
  expect(result.orientation).toEqual([20, 30]);
  expect(result.sourceSize).toBeGreaterThan(5000);
  expect(result.outputSize).toBeLessThanOrEqual(5000);
  expect(result.calls[0]).toEqual(["image/webp", 0.8, 1200, 600]);
  expect(
    result.calls.some(
      (call) => call[0] === "image/webp" && call[2] === 30 && call[3] === 20,
    ),
  ).toBe(true);
  expect(result.smallName).toBe("small.webp");
  expect(result.animated).toEqual([
    ["image/gif", "animation.gif", true],
    ["image/png", "animation.png", true],
    ["image/webp", "animation.webp", true],
  ]);
  expect(result.oversizedRejected).toBe(true);
  expect(result.malformedRejected).toBe(true);
  expect(result.dimensionsRejected).toBe(true);
  expect(result.decodeCalls).toBe(0);
  expect(result.totalRejected).toBe(true);
  console.log(
    "photo preparation browser fixture passed",
    JSON.stringify(result),
  );
} finally {
  await browser.close();
}

// Exercise the actual production chunks and WASM served by the synthetic host.
const fixture = imagesFixture();
const host = await createUiTestHost(fixture.backend);
const channels = new Map();
const assets = resolve("apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(request)) return;
    const response = await imageHttp(
      request,
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
const builtBrowser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  const page = await builtBrowser.newPage();
  await page.addInitScript(() => {
    window.__forceWebpFallback = false;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      return toBlob.call(
        this,
        callback,
        window.__forceWebpFallback && type === "image/webp"
          ? "image/png"
          : type,
        quality,
      );
    };
  });
  const base = `http://127.0.0.1:${server.port}`;
  const loaded = [];
  const uploads = [];
  page.on("response", (response) => {
    if (/\/assets\/(?:webp_enc-|meta-)/.test(new URL(response.url()).pathname))
      loaded.push({ url: response.url(), status: response.status() });
  });
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/chat/images" &&
      request.method() === "POST"
    )
      uploads.push(request.postDataJSON());
  });
  await page.goto(base);
  const input = page.locator("#companion-textarea");
  const choose = page.locator("#companion-image-library");
  await expect(input).toBeVisible();
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1200;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 1200, 1200);
    ctx.fillStyle = "blue";
    ctx.fillRect(1200, 0, 1200, 1200);
    return (await new Promise((resolve) => c.toBlob(resolve, "image/png")))
      .arrayBuffer()
      .then((b) => Array.from(new Uint8Array(b)));
  });
  const send = async (name) => {
    await choose.dispatchEvent("click");
    await choose.setInputFiles({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(png),
    });
    await expect(
      page.locator(".companion-image-draft-preview img"),
    ).toHaveCount(1);
    await input.fill("synthetic photo");
    await input.press("Enter");
  };
  await send("native.png");
  await expect.poll(() => uploads.length).toBe(1);
  expect(loaded).toHaveLength(0);
  await page.evaluate(() => {
    window.__forceWebpFallback = true;
  });
  const boundary = `${"a".repeat(154)}😀.png`;
  expect(boundary.length).toBe(160);
  await send(boundary);
  await expect.poll(() => uploads.length).toBe(2);
  const image = uploads[1].images[0];
  expect(Object.keys(image).sort()).toEqual([
    "id",
    "mediaType",
    "name",
    "order",
    "original",
  ]);
  expect(image.name).toBe(`${"a".repeat(154)}.webp`);
  expect(image.name.length).toBeLessThanOrEqual(160);
  expect(image.mediaType).toBe("image/webp");
  const binary = Buffer.from(image.original, "base64");
  expect(binary.subarray(0, 4).toString()).toBe("RIFF");
  expect(binary.subarray(8, 12).toString()).toBe("WEBP");
  const pixels = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/webp" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      width: canvas.width,
      height: canvas.height,
      left: Array.from(ctx.getImageData(200, 300, 1, 1).data),
      right: Array.from(ctx.getImageData(1000, 300, 1, 1).data),
    };
  }, image.original);
  expect([pixels.width, pixels.height]).toEqual([1200, 600]);
  expect(pixels.left[0]).toBeGreaterThan(200);
  expect(pixels.left[2]).toBeLessThan(50);
  expect(pixels.right[2]).toBeGreaterThan(200);
  expect(pixels.right[0]).toBeLessThan(50);
  const wasm = loaded.filter((item) => item.url.endsWith(".wasm"));
  expect(wasm).toHaveLength(1);
  expect(
    loaded.every(
      (item) => item.url.startsWith(`${base}/assets/`) && item.status === 200,
    ),
  ).toBe(true);
  const wasmBytes = (
    await Bun.file(
      resolve(assets, new URL(wasm[0].url).pathname.slice(1)),
    ).arrayBuffer()
  ).byteLength;
  await send(`${"b".repeat(155)}.png`);
  await expect.poll(() => uploads.length).toBe(3);
  expect(uploads[2].images[0].name).toBe(`${"b".repeat(155)}.webp`);
  expect(uploads[2].images[0].name.length).toBe(160);
  expect(loaded.filter((item) => item.url.endsWith(".wasm"))).toHaveLength(1);
  console.log(
    "built App forced-PNG fallback passed",
    JSON.stringify({
      loaded,
      wasmBytes,
      outputBytes: binary.length,
      pixels,
      nameLength: image.name.length,
    }),
  );
} finally {
  await builtBrowser.close();
  host.close();
  server.stop(true);
}
