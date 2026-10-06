import { Capacitor } from "@capacitor/core";
import {
  Camera,
  CameraErrorCode,
  MediaTypeSelection,
  type ChooseFromGalleryOptions,
} from "@capacitor/camera";
import { imageFileFromCapturedMedia } from "./image-drafts.ts";

export function hasNativeCamera(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Camera");
}

export async function captureNativePhoto(
  takePhoto = () =>
    Camera.takePhoto({ saveToGallery: false, includeMetadata: true }),
): Promise<File | undefined> {
  try {
    return await imageFileFromCapturedMedia(await takePhoto());
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === CameraErrorCode.TakePhotoCancelled
    )
      return undefined;
    throw error;
  }
}

/** Materialize originals before they can become composer drafts. No thumbnail or encoding options. */
export async function chooseNativePhotos(
  remaining: number,
  choose: (
    options: ChooseFromGalleryOptions,
  ) => ReturnType<typeof Camera.chooseFromGallery> = (options) =>
    Camera.chooseFromGallery(options),
  fetchMedia: (url: string) => Promise<Response> = fetch,
): Promise<File[] | undefined> {
  if (remaining <= 0) return [];
  try {
    const { results } = await choose({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: true,
      limit: remaining,
      includeMetadata: true,
    });
    return await Promise.all(
      results.map((media) => imageFileFromCapturedMedia(media, fetchMedia)),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === CameraErrorCode.ChooseMediaCancelled
    )
      return undefined;
    throw error;
  }
}
