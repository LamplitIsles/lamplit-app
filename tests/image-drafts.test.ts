import { expect, test } from "bun:test";
import {
  imageIntakeError,
  MAX_PHOTO_INPUT_BYTES,
} from "../apps/web/src/lib/companion/client/image-drafts.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { imageLimits } from "./images-fixture.ts";

test("image selection bounds local input and GIF bytes while deferring encoded photo limits", async () => {
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
      maxImageBytes: 1,
      maxMessageImageBytes: 1,
    }),
  ).toBeUndefined();
  const gif = new File([fixtureImage], "a.gif", { type: "image/gif" });
  expect(
    imageIntakeError([], [gif], { ...imageLimits, maxImageBytes: gif.size - 1 })
      ?.key,
  ).toBe("image.tooLarge");
  expect(
    imageIntakeError([], [gif, gif], {
      ...imageLimits,
      maxMessageImageBytes: gif.size * 2 - 1,
    })?.key,
  ).toBe("image.totalTooLarge");
  const large = new File(
    [new Uint8Array(MAX_PHOTO_INPUT_BYTES + 1)],
    "large.png",
    { type: "image/png" },
  );
  expect(imageIntakeError([], [large], imageLimits)?.key).toBe(
    "image.tooLarge",
  );
  expect(
    imageIntakeError(current, incoming, {
      ...imageLimits,
      mediaTypes: ["image/jpeg"],
    })?.key,
  ).toBe("image.types");
  expect(current).toHaveLength(1);
});
