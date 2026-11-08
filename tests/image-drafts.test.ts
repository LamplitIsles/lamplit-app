import { expect, test } from "bun:test";
import { imageIntakeError } from "../apps/web/src/lib/companion/client/image-drafts.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { imageLimits } from "./images-fixture.ts";

test("whole image addition validates current count, per-file size, total bytes and advertised formats", async () => {
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
