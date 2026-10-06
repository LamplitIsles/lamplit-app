import { expect, test } from "bun:test";
import {
  CameraErrorCode,
  MediaType,
  MediaTypeSelection,
} from "../apps/web/node_modules/@capacitor/camera";
import { chooseNativePhotos } from "../apps/web/src/lib/companion/client/native-mobile.ts";
import {
  imageFileFromCapturedMedia,
  imageIntakeError,
} from "../apps/web/src/lib/companion/client/image-drafts.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { imageLimits } from "./images-fixture.ts";

test("native gallery requests remaining photos and preserves original PNG bytes in returned order", async () => {
  const paths: string[] = [];
  const files = await chooseNativePhotos(
    2,
    async (options) => {
      expect(options).toEqual({
        mediaType: MediaTypeSelection.Photo,
        allowMultipleSelection: true,
        limit: 2,
        includeMetadata: true,
      });
      return {
        results: ["second", "first"].map((id) => ({
          type: MediaType.Photo,
          saved: false,
          webPath: `http://fixture/native/${id}`,
          metadata: { format: "png" },
        })),
      };
    },
    async (url) => {
      paths.push(String(url));
      return new Response(fixtureImage, {
        headers: { "content-type": "image/png" },
      });
    },
  );
  expect(paths).toEqual([
    "http://fixture/native/second",
    "http://fixture/native/first",
  ]);
  expect(files).toHaveLength(2);
  for (const file of files!) {
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(fixtureImage);
  }
  expect(
    imageIntakeError([], files!, { ...imageLimits, maxImagesPerMessage: 1 })
      ?.key,
  ).toBe("image.countLimit");
});

test("gallery cancellation alone is silent; native errors and media read errors propagate", async () => {
  expect(
    await chooseNativePhotos(1, async () => {
      throw { code: CameraErrorCode.ChooseMediaCancelled };
    }),
  ).toBeUndefined();
  await expect(
    chooseNativePhotos(1, async () => {
      throw { code: CameraErrorCode.ChooseMediaFailed };
    }),
  ).rejects.toEqual({ code: CameraErrorCode.ChooseMediaFailed });
  let called = false;
  expect(
    await chooseNativePhotos(0, async () => {
      called = true;
      return { results: [] };
    }),
  ).toEqual([]);
  expect(called).toBe(false);
  await expect(
    chooseNativePhotos(
      2,
      async () => ({
        results: [
          { type: MediaType.Photo, saved: false, webPath: "http://fixture/ok" },
          { type: MediaType.Photo, saved: false },
        ],
      }),
      async () =>
        new Response(fixtureImage, {
          headers: { "content-type": "image/png" },
        }),
    ),
  ).rejects.toThrow("camera-media-missing-url");
});

test("native media accepts actual MIME or plugin metadata, rejects unsupported originals", async () => {
  for (const [mime, format, expected] of [
    ["image/png", "png", "image/png"],
    ["image/jpeg", "jpg", "image/jpeg"],
    ["image/webp", "webp", "image/webp"],
    ["image/gif", "gif", "image/gif"],
    ["application/octet-stream", "jpg", "image/jpeg"],
    ["application/octet-stream", "image/png", "image/png"],
  ]) {
    const file = await imageFileFromCapturedMedia(
      { webPath: "http://fixture/media", metadata: { format } },
      async () =>
        new Response(fixtureImage, { headers: { "content-type": mime! } }),
    );
    expect(file.type).toBe(expected!);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(fixtureImage);
  }
  await expect(
    imageFileFromCapturedMedia(
      { webPath: "http://fixture/media", metadata: { format: "heic" } },
      async () =>
        new Response(fixtureImage, {
          headers: { "content-type": "image/heic" },
        }),
    ),
  ).rejects.toThrow("camera-media-unsupported-type");
});

test("whole native addition validates current count, per-file size, total bytes and advertised formats", async () => {
  const file = new File([fixtureImage], "owned.png", { type: "image/png" });
  const current = [{ id: "owned", file, previewUrl: "" }];
  const incoming = [file, file];
  expect(imageIntakeError(current, incoming, imageLimits)).toBeUndefined();
  expect(
    imageIntakeError(current, incoming, {
      ...imageLimits,
      maxImagesPerMessage: 2,
    })?.key,
  ).toBe("image.countLimit");
  expect(
    imageIntakeError(current, incoming, {
      ...imageLimits,
      maxImageBytes: file.size - 1,
    })?.key,
  ).toBe("image.tooLarge");
  expect(
    imageIntakeError(current, incoming, {
      ...imageLimits,
      maxMessageImageBytes: file.size * 3 - 1,
    })?.key,
  ).toBe("image.totalTooLarge");
  expect(
    imageIntakeError(current, incoming, {
      ...imageLimits,
      mediaTypes: ["image/jpeg"],
    })?.key,
  ).toBe("image.types");
  expect(current).toHaveLength(1);
});
