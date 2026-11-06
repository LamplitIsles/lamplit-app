import { expect, test } from "bun:test";
import {
  parseWorkspaceMediaPath,
  workspaceMediaUrl,
  validateA2UISurface,
  A2UISurfaceSchema,
  validate,
  type WorkspaceMediaKind,
} from "../packages/contracts/src/index.ts";
import fixture from "./fixtures/a2ui-workspace-media.json";

const cases: [string, WorkspaceMediaKind, string, string][] = [
  [
    "workspace:images%2F%E7%81%AF%20%E5%85%89.png",
    "image",
    "images/灯 光.png",
    "/api/chat/workspace-image?path=images%2F%E7%81%AF%20%E5%85%89.png",
  ],
  [
    "workspace:music%2F%2520.wav",
    "audio",
    "music/%20.wav",
    "/api/chat/workspace-media?kind=audio&path=music%2F%2520.wav",
  ],
  [
    "./sounds/track.MP3",
    "audio",
    "./sounds/track.MP3",
    "/api/chat/workspace-media?kind=audio&path=.%2Fsounds%2Ftrack.MP3",
  ],
  [
    "workspace:%2Fworkspace%2Fdemo.mp4",
    "video",
    "/workspace/demo.mp4",
    "/api/chat/workspace-media?kind=video&path=%2Fworkspace%2Fdemo.mp4",
  ],
  [
    "/workspace/a.JPG",
    "image",
    "/workspace/a.JPG",
    "/api/chat/workspace-image?path=%2Fworkspace%2Fa.JPG",
  ],
  [
    "workspace:images%2F%23%3F%26.gif",
    "image",
    "images/#?&.gif",
    "/api/chat/workspace-image?path=images%2F%23%3F%26.gif",
  ],
  [
    "workspace:music%2F%23%3F%26kind%3Dvideo%25.wav",
    "audio",
    "music/#?&kind=video%.wav",
    "/api/chat/workspace-media?kind=audio&path=music%2F%23%3F%26kind%3Dvideo%25.wav",
  ],
  [
    "workspace:%252e%252e%2Fclip.mp4",
    "video",
    "%2e%2e/clip.mp4",
    "/api/chat/workspace-media?kind=video&path=%252e%252e%2Fclip.mp4",
  ],
];

test("workspace references decode once and are encoded exactly once into the authenticated URL", () => {
  for (const [source, kind, path, expected] of cases) {
    expect(parseWorkspaceMediaPath(source, kind)).toBe(path);
    const result = workspaceMediaUrl(source, kind);
    expect(result).toBe(expected);
    const url = new URL(result!, "https://example.test");
    expect(url.searchParams.getAll("path")).toEqual([path]);
    expect(url.searchParams.getAll("kind")).toEqual(
      kind === "image" ? [] : [kind],
    );
    expect([...url.searchParams.keys()].sort()).toEqual(
      kind === "image" ? ["path"] : ["kind", "path"],
    );
  }
});

test("format is scoped by media kind and traversal, scheme and malformed paths fail closed", () => {
  const unsupported = [
    ["workspace:song.mp3", "image"],
    ["workspace:photo.png", "audio"],
    ["workspace:clip.mov", "video"],
    ["workspace:clip.mp4.exe", "video"],
    ["workspace:../track.wav", "audio"],
    ["workspace:dir/%2e%2e/clip.mp4", "video"],
    ["workspace:%2e%2e%2fimage.png", "image"],
    ["../song.wav", "audio"],
    ["workspace://outside/a.png", "image"],
    ["workspace:foo//bar.png", "image"],
    ["file:/tmp/a.png", "image"],
    ["workspace:file%3A%2Ftmp%2Fa.png", "image"],
    ["javascript:clip.mp4", "video"],
    ["data:clip.mp4", "video"],
    ["C:/music.wav", "audio"],
    ["workspace:C%3A%2Fmusic.wav", "audio"],
    ["workspace:/api/chat/media/a/original.png", "image"],
    ["workspace:dir%5Cfile.wav", "audio"],
    ["workspace:dir%00a.mp4", "video"],
    ["workspace:dir%0Aa.mp4", "video"],
    ["workspace:a%7F.png", "image"],
    ["workspace:a%QQ.png", "image"],
    ["workspace:%FF.png", "image"],
    ["workspace: song.wav", "audio"],
    ["workspace:foo.mp3 ", "audio"],
    ["workspace:", "image"],
    ["workspace:\ud800.png", "image"],
    ["workspace:a.png", "__proto__"],
  ];
  for (const [source, kind] of unsupported) {
    expect(
      parseWorkspaceMediaPath(source!, kind as WorkspaceMediaKind),
    ).toBeNull();
    expect(workspaceMediaUrl(source!, kind as WorkspaceMediaKind)).toBeNull();
  }
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif"])
    expect(workspaceMediaUrl(`workspace:a.${ext}`, "image")).not.toBeNull();
  for (const ext of ["wav", "mp3"])
    expect(workspaceMediaUrl(`workspace:a.${ext}`, "audio")).not.toBeNull();
  expect(workspaceMediaUrl("workspace:a.mp4", "video")).not.toBeNull();
});

test("workspace fixture is valid A2UI and media kinds and poster are validated", () => {
  expect(validate(A2UISurfaceSchema, fixture) as unknown).toEqual(fixture);
  expect(validateA2UISurface(fixture) as unknown).toEqual(fixture);
  for (const [id, url] of [
    ["image", "workspace:song.wav"],
    ["audio", "workspace:../song.wav"],
    ["video", "workspace:clip.js"],
  ]) {
    const bad = structuredClone(fixture);
    bad.createSurface.components.find((node) => node.id === id)!.url = url;
    expect(() => validateA2UISurface(bad)).toThrow();
  }
  const badPoster = structuredClone(fixture);
  badPoster.createSurface.components.find(
    (node) => node.id === "video",
  )!.posterUrl = "workspace:../poster.png";
  expect(() => validateA2UISurface(badPoster)).toThrow();
});

test("A2UI wire requires the workspace prefix while the standalone helper accepts paths", () => {
  const surface = (component: string, url: string) => ({
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: [{ id: "root", component, url }],
    },
  });
  for (const [component, kind, bare] of [
    ["Image", "image", "/workspace/photo.png"],
    ["AudioPlayer", "audio", "music.mp3"],
    ["Video", "video", "video/clip.mp4"],
  ] as const) {
    expect(workspaceMediaUrl(bare, kind)).not.toBeNull();
    expect(() => validateA2UISurface(surface(component, bare))).toThrow();
    expect(() =>
      validateA2UISurface(surface(component, `workspace:${bare}`)),
    ).not.toThrow();
    expect(() =>
      validateA2UISurface(
        surface(component, "https://media.example.test/resource"),
      ),
    ).not.toThrow();
  }
});
