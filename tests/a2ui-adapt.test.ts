import { describe, expect, test } from "bun:test";
import fixture from "../packages/contracts/fixtures/a2ui-v1.json";
import { adaptSurface } from "../apps/web/src/lib/companion/a2ui/adapt";

describe("A2UI media adaptation", () => {
  test("maps workspace media for Web and the iOS bridge, preserving encoding", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: { location: { origin: "https://chat.example" } },
      configurable: true,
    });
    try {
      const input = structuredClone(fixture);
      const image = input.createSurface.components.find(
        (n) => n.id === "image",
      )!;
      const video = input.createSurface.components.find(
        (n) => n.id === "video",
      )!;
      const audio = input.createSurface.components.find(
        (n) => n.id === "audio",
      )!;
      Object.assign(image, { url: "workspace:images%2F%2520.png" });
      Object.assign(video, {
        url: "workspace:clips%2Fdemo.mp4",
        posterUrl: "workspace:images%2Fposter.png",
      });
      Object.assign(audio, { url: "workspace:music%2Fdemo.wav" });
      const read = (native: boolean, id: string, key = "url") => {
        const message = adaptSurface(input, native).message as unknown as {
          createSurface: { components: Array<Record<string, string>> };
        };
        return message.createSurface.components.find(
          (node) => node.id === id,
        )?.[key];
      };
      const imagePath = "/api/chat/workspace-image?path=images%2F%2520.png";
      const videoPath =
        "/api/chat/workspace-media?kind=video&path=clips%2Fdemo.mp4";
      const audioPath =
        "/api/chat/workspace-media?kind=audio&path=music%2Fdemo.wav";
      const posterPath = "/api/chat/workspace-image?path=images%2Fposter.png";
      for (const [id, key, path] of [
        ["image", "url", imagePath],
        ["video", "url", videoPath],
        ["video", "posterUrl", posterPath],
        ["audio", "url", audioPath],
      ]) {
        expect(read(false, id!, key)).toBe(path);
        expect(read(true, id!, key)).toBe(
          `cfl-media://load/${encodeURIComponent(path!)}`,
        );
      }
      Object.assign(image, { url: `https://chat.example${imagePath}` });
      expect(read(true, "image")).toBe(
        `cfl-media://load/${encodeURIComponent(imagePath)}`,
      );
      Object.assign(image, { url: `https://other.example${imagePath}` });
      expect(read(true, "image")).toBe(`https://other.example${imagePath}`);
      for (const spelling of ["images%2f%2520.png", "images/%2520.png"]) {
        Object.assign(image, {
          url: `https://chat.example/api/chat/workspace-image?path=${spelling}`,
        });
        expect(read(false, "image")).toBe(imagePath);
        expect(read(true, "image")).toBe(
          `cfl-media://load/${encodeURIComponent(imagePath)}`,
        );
      }
      Object.assign(video, {
        url: "https://chat.example/api/chat/workspace-media?path=clips/demo.mp4&kind=video",
      });
      expect(read(false, "video")).toBe(videoPath);
      expect(read(true, "video")).toBe(
        `cfl-media://load/${encodeURIComponent(videoPath)}`,
      );
      Object.assign(image, {
        url: `https://chat.example${imagePath}&path=other.png`,
      });
      for (const native of [false, true])
        expect(() => read(native, "image")).toThrow();
      Object.assign(image, {
        url: `https://chat.example${imagePath}&extra=1`,
      });
      for (const native of [false, true])
        expect(() => read(native, "image")).toThrow();
      Object.assign(image, {
        url: "https://chat.example/api/chat/workspace-media?kind=image&path=photo.png",
      });
      for (const native of [false, true])
        expect(() => read(native, "image")).toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
