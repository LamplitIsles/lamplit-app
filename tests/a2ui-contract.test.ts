import { expect, test } from "bun:test";
import fixture from "../packages/contracts/fixtures/a2ui-v1.json";
import { validateA2UISurface } from "../packages/contracts/src/a2ui.ts";

const clone = () => structuredClone(fixture);
test("fixed fixture covers the 13 supported components and an inline data model", () => {
  expect(
    new Set(
      fixture.createSurface.components.map((component) => component.component),
    ).size,
  ).toBe(13);
  expect(validateA2UISurface(fixture) as unknown).toEqual(fixture);
});
test("rejects unknown versions, components, properties, actions and functions", () => {
  const bad: unknown[] = [];
  const version = clone();
  version.version = "v0.9";
  bad.push(version);
  const catalog = clone();
  catalog.createSurface.catalogId = "other";
  bad.push(catalog);
  for (const property of [
    { action: { event: { name: "send" } } },
    { text: { call: "evil" } },
    { component: "TextField" },
    { html: "<script>" },
  ]) {
    const value = clone();
    Object.assign(value.createSurface.components[1], property);
    bad.push(value);
  }
  for (const value of bad) expect(() => validateA2UISurface(value)).toThrow();
});
test("rejects duplicate, dangling, shared, cyclic and unreachable component references", () => {
  for (const edit of [
    (v: any) => v.createSurface.components.push(v.createSurface.components[1]),
    (v: any) => v.createSurface.components[0].children.push("missing"),
    (v: any) => v.createSurface.components[0].children.push("title"),
    (v: any) => v.createSurface.components[0].children.push("root"),
    (v: any) =>
      v.createSurface.components.push({
        id: "unused",
        component: "Text",
        text: "x",
      }),
    (v: any) => (v.createSurface.components[1].text["@path"] = "/missing"),
  ]) {
    const value = clone();
    edit(value);
    expect(() => validateA2UISurface(value)).toThrow();
  }
});
test("enforces tree depth, component count and UTF-8 byte limits", () => {
  const chain = (count: number) => ({
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: Array.from({ length: count }, (_, i) =>
        i === count - 1
          ? { id: i ? `n${i}` : "root", component: "Text", text: "x" }
          : {
              id: i ? `n${i}` : "root",
              component: "Column",
              children: [`n${i + 1}`],
            },
      ),
    },
  });
  expect(() => validateA2UISurface(chain(16))).not.toThrow();
  expect(() => validateA2UISurface(chain(17))).toThrow();
  expect(() => validateA2UISurface(chain(101))).toThrow();
  const large = clone();
  large.createSurface.dataModel.title = "界".repeat(4096);
  Object.assign(large.createSurface.dataModel, { other: "界".repeat(2000) });
  expect(() => validateA2UISurface(large)).toThrow();
});
test("rejects non-JSON input without serializing away functions or nonfinite numbers", () => {
  const value = clone();
  Object.assign(value.createSurface.components[0], { ignored: () => 1 });
  expect(() => validateA2UISurface(value)).toThrow();
  const next = clone();
  Object.assign(next.createSurface.components[0], { weight: Infinity });
  expect(() => validateA2UISurface(next)).toThrow();
});

test("buttons are restricted to the local modal trigger action", () => {
  const button = (value: ReturnType<typeof clone>) =>
    value.createSurface.components.find((c) => c.component === "Button") as any;
  for (const action of [
    { event: { name: "send" } },
    { event: { name: "open_modal", context: {} } },
    { event: { name: "open_modal", wantResponse: true } },
    { functionCall: { "@call": "open_modal" } },
    undefined,
  ]) {
    const value = clone();
    button(value).action = action;
    expect(() => validateA2UISurface(value)).toThrow();
  }
  const unreferenced = clone();
  const modal = unreferenced.createSurface.components.find(
    (c) => c.component === "Modal",
  ) as any;
  modal.trigger = "modal-text";
  expect(() => validateA2UISurface(unreferenced)).toThrow();
  const standalone = {
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: [
        {
          id: "root",
          component: "Button",
          child: "label",
          action: { event: { name: "open_modal" } },
        },
        { id: "label", component: "Text", text: "Open" },
      ],
    },
  };
  expect(() => validateA2UISurface(standalone)).toThrow();
});

test("bindings use official @path and refer to an existing safe model key", () => {
  const missing = clone();
  Object.assign(missing.createSurface.components[0]!, {
    accessibility: { label: { "@path": "/missing" } },
  });
  expect(() => validateA2UISurface(missing)).toThrow();
  const old = clone();
  Object.assign(old.createSurface.components[1]!, { text: { path: "/title" } });
  expect(() => validateA2UISurface(old)).toThrow();
  const extension = clone();
  Object.assign(extension.createSurface.components[1]!, {
    ariaLabel: "private renderer prop",
  });
  expect(() => validateA2UISurface(extension)).toThrow();
  const invalidIcon = clone();
  Object.assign(invalidIcon.createSurface.components[2]!, { name: "unknown" });
  expect(() => validateA2UISurface(invalidIcon)).toThrow();
});

test("exact component and UTF-8 size boundaries are enforced independently", () => {
  const wide = (total: number) => ({
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: [
        {
          id: "root",
          component: "Column",
          children: Array.from({ length: total - 1 }, (_, i) => `n${i}`),
        },
        ...Array.from({ length: total - 1 }, (_, i) => ({
          id: `n${i}`,
          component: "Text",
          text: "x",
        })),
      ],
    },
  });
  expect(() => validateA2UISurface(wide(100))).not.toThrow();
  expect(() => validateA2UISurface(wide(101))).toThrow();
  const value = {
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: [{ id: "root", component: "Text", text: "x" }],
      dataModel: { a: "", b: "", c: "", d: "" },
    },
  };
  let remaining =
    16384 - new TextEncoder().encode(JSON.stringify(value)).byteLength;
  for (const key of ["a", "b", "c", "d"] as const) {
    const n = Math.min(4096, remaining);
    value.createSurface.dataModel[key] = "x".repeat(n);
    remaining -= n;
  }
  expect(remaining).toBe(0);
  expect(() => validateA2UISurface(value)).not.toThrow();
  value.createSurface.dataModel.d += "x";
  expect(() => validateA2UISurface(value)).toThrow();
});

test("object prototype keys cannot be used as surface or component ids", () => {
  const surface = clone();
  surface.createSurface.surfaceId = "__proto__";
  expect(() => validateA2UISurface(surface)).toThrow();
  const component = clone();
  component.createSurface.components[1]!.id = "constructor";
  expect(() => validateA2UISurface(component)).toThrow();
});

test("media accepts HTTPS without credentials and only approved relative media paths", () => {
  const media = (
    kind: "Image" | "Video" | "AudioPlayer",
    url: unknown,
    posterUrl?: unknown,
  ) => ({
    version: "1.0",
    createSurface: {
      surfaceId: "s",
      catalogId: fixture.createSurface.catalogId,
      components: [
        {
          id: "root",
          component: kind,
          url,
          ...(posterUrl === undefined ? {} : { posterUrl }),
        },
      ],
    },
  });
  for (const kind of ["Image", "Video", "AudioPlayer"] as const) {
    for (const url of [
      "https://cdn.example.test/a",
      "HTTPS://cdn.example.test:443/media?q=1#part",
      "https://[::1]/audio",
      "https://example.test/a%20b",
    ]) {
      expect(() => validateA2UISurface(media(kind, url))).not.toThrow();
    }
    for (const url of [
      "http://example.test/a",
      "javascript:alert(1)",
      "data:image/png;base64,eA==",
      "file:///tmp/file",
      "//example.test/a",
      "https://name@example.test/a",
      "https://name:pass@example.test/a",
      "https://@example.test/a",
      "https://example.test/%zz",
      "https://example.test/line\nbreak",
      " https://example.test/a",
      "https://example.test\\@evil.test/a",
      "https://",
      "/api/admin",
      { "@path": "/url" },
    ]) {
      expect(() => validateA2UISurface(media(kind, url))).toThrow();
    }
  }
  for (const url of [
    "/api/chat/media/image-1/original",
    "/api/chat/media/image_2/preview",
    "/api/chat/media/image/model",
  ]) {
    expect(() => validateA2UISurface(media("Image", url))).not.toThrow();
    expect(() =>
      validateA2UISurface(media("Video", "https://cdn.example.test/a", url)),
    ).not.toThrow();
  }
  const voice = `/api/audio/${"a".repeat(64)}.mp3`;
  expect(() => validateA2UISurface(media("AudioPlayer", voice))).not.toThrow();
  for (const url of [
    "/api/chat/media/image/original?token=x",
    "/api/chat/media/../original",
    "/api/chat/media/image/nope",
    "/api/audio/../../file.mp3",
    voice + "?token=x",
  ]) {
    for (const kind of ["Image", "Video", "AudioPlayer"] as const)
      expect(() => validateA2UISurface(media(kind, url))).toThrow();
  }
  expect(() =>
    validateA2UISurface(
      media("Video", "https://example.test/video", "javascript:alert(1)"),
    ),
  ).toThrow();
});
