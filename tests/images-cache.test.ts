import { expect, test } from "bun:test";
import {
  imageHttp,
  type ImageBackend,
} from "../packages/contracts/src/server.ts";
import { mediaUrl } from "../packages/contracts/src/index.ts";
import { imagesFixture, imageLimits } from "./images-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";

const owner = () => ({ sessionId: "fixture-session", limits: imageLimits });
const auth = async () => owner();
const url = (variant: "original" | "preview" | "model" = "original") =>
  `http://fixture${mediaUrl("test-image", variant)}`;
const get = (
  variant: "original" | "preview" | "model" = "original",
  validator?: string,
) =>
  new Request(url(variant), {
    headers: validator ? { "if-none-match": validator } : {},
  });
const noStore = (response: Response | undefined, status: number) => {
  expect(response?.status).toBe(status);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("etag")).toBeNull();
};

test("media GET revalidates actual bytes for every variant and validator", async () => {
  const fixture = imagesFixture();
  const original = btoa(String.fromCharCode(...fixtureImage));
  const jpeg = btoa(String.fromCharCode(255, 216, 255, 224));
  const upload = {
    sessionId: owner().sessionId,
    operationId: crypto.randomUUID(),
    images: [
      {
        id: crypto.randomUUID(),
        order: 0,
        name: "test.png",
        mediaType: "image/png" as const,
        original,
        preview: jpeg,
        model: jpeg,
      },
    ],
  };
  const uploaded = await imageHttp(
    new Request("http://fixture/api/chat/images", {
      method: "POST",
      headers: { origin: "http://fixture", "content-type": "application/json" },
      body: JSON.stringify(upload),
    }),
    fixture.imageBackend,
    auth,
  );
  expect(uploaded?.status).toBe(200);
  expect(uploaded?.headers.get("cache-control")).toBe("no-store");
  const result = (await uploaded!.json()) as {
    images: Array<{ ref: { attachmentId: string } }>;
  };
  const id = result.images[0]!.ref.attachmentId;
  const tags: string[] = [];
  for (const variant of ["original", "preview", "model"] as const) {
    const request = (validator?: string) =>
      new Request(`http://fixture${mediaUrl(id, variant)}`, {
        headers: validator ? { "if-none-match": validator } : {},
      });
    const response = await imageHttp(request(), fixture.imageBackend, auth);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe(
      "private, max-age=2592000",
    );
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await response!.arrayBuffer());
    expect(bytes).toEqual(
      variant === "original"
        ? fixtureImage
        : Uint8Array.from([255, 216, 255, 224]),
    );
    const tag = response!.headers.get("etag")!;
    expect(tag).toMatch(/^"[a-f0-9]{64}-/);
    tags.push(tag);
    for (const validator of [tag, `W/${tag}`, `"other,tag", W/${tag}`, "*"]) {
      let authorizations = 0,
        reads = 0;
      const response304 = await imageHttp(
        request(validator),
        {
          ...fixture.imageBackend,
          async media(...args) {
            reads++;
            return fixture.imageBackend.media(...args);
          },
        },
        async () => {
          authorizations++;
          return owner();
        },
      );
      expect(response304?.status).toBe(304);
      expect(response304?.headers.get("etag")).toBe(tag);
      expect(response304?.headers.get("cache-control")).toBe(
        "private, max-age=2592000",
      );
      expect((await response304!.arrayBuffer()).byteLength).toBe(0);
      expect([authorizations, reads]).toEqual([2, 1]);
    }
    expect(
      (await imageHttp(request('"other"'), fixture.imageBackend, auth))?.status,
    ).toBe(200);
    expect(
      (await imageHttp(request('"old,*,tag"'), fixture.imageBackend, auth))
        ?.status,
    ).toBe(200);
    expect(
      (
        await imageHttp(
          request(`"old,*,tag", W/${tag}`),
          fixture.imageBackend,
          auth,
        )
      )?.status,
    ).toBe(304);
    for (const validator of [
      `, W/${tag}`,
      `"other",, W/${tag}`,
      `W/${tag},`,
      `, "old,*,tag",, W/${tag},`,
      `${",".repeat(16)}W/${tag}`,
      `W/${tag}${",".repeat(16)}`,
    ])
      expect(
        (await imageHttp(request(validator), fixture.imageBackend, auth))
          ?.status,
      ).toBe(304);
    for (const validator of [
      `${",".repeat(17)}W/${tag}`,
      `W/${tag}${",".repeat(17)}`,
      `*, ${tag}`,
      `${tag}, *`,
      "*,",
      `${tag}, broken`,
    ])
      expect(
        (await imageHttp(request(validator), fixture.imageBackend, auth))
          ?.status,
      ).toBe(200);
  }
  expect(new Set(tags).size).toBe(3); // Identical preview/model bytes remain distinct representations.
  expect(
    (
      await imageHttp(
        new Request(`http://fixture${mediaUrl(id, "model")}`, {
          headers: { "if-none-match": tags[1]! },
        }),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(200);
});

test("same media URL revalidates the bytes returned in each context", async () => {
  let context: "a" | "b" | "missing" = "a";
  const values = {
    a: Uint8Array.from([1, 2, 3]),
    b: Uint8Array.from([4, 5, 6]),
    missing: null,
  };
  const scopedAuth = async () => ({ sessionId: context, limits: imageLimits });
  const backend: ImageBackend = {
    upload: async () => {
      throw new Error("unused");
    },
    media: async (id) => {
      expect(id).toBe("test-image");
      const bytes = values[context];
      return bytes ? { bytes, mediaType: "image/png" } : null;
    },
  };
  const first = await imageHttp(get(), backend, scopedAuth);
  const tag = first!.headers.get("etag")!;
  context = "b";
  const changed = await imageHttp(get("original", tag), backend, scopedAuth);
  expect(changed?.status).toBe(200);
  expect(new Uint8Array(await changed!.arrayBuffer())).toEqual(values.b);
  expect(changed!.headers.get("etag")).not.toBe(tag);
  context = "missing";
  noStore(await imageHttp(get("original", tag), backend, scopedAuth), 404);
});

test("session changes while media is being read cannot return 304", async () => {
  let sessionId = "a";
  const auth = async () => ({ sessionId, limits: imageLimits });
  const bytes = Uint8Array.from([1, 2, 3]);
  const backend: ImageBackend = {
    upload: async () => {
      throw new Error("unused");
    },
    media: async () => ({ bytes, mediaType: "image/png" }),
  };
  const tag = (await imageHttp(get(), backend, auth))!.headers.get("etag")!;
  let started!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = imageHttp(
    get("original", tag),
    {
      ...backend,
      async media() {
        started();
        await gate;
        return { bytes, mediaType: "image/png" };
      },
    },
    auth,
  );
  await reading;
  sessionId = "b";
  release();
  noStore(await pending, 403);
});

test("conditional GET follows current context, authorization and bounds", async () => {
  let value: { bytes: Uint8Array; mediaType: string } | null = {
    bytes: Uint8Array.from([1, 2, 3]),
    mediaType: "image/png",
  };
  let reads = 0;
  const backend: ImageBackend = {
    upload: async () => {
      throw new Error("unused");
    },
    media: async () => {
      reads++;
      return value;
    },
  };
  const first = await imageHttp(get(), backend, auth);
  const tag = first!.headers.get("etag")!;
  value = { bytes: Uint8Array.from([4, 5, 6]), mediaType: "image/png" };
  const changed = await imageHttp(get("original", tag), backend, auth);
  expect(changed?.status).toBe(200);
  expect(new Uint8Array(await changed!.arrayBuffer())).toEqual(
    Uint8Array.from([4, 5, 6]),
  );
  expect(changed!.headers.get("etag")).not.toBe(tag);
  value = { bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/gif" };
  expect((await imageHttp(get("original", tag), backend, auth))?.status).toBe(
    200,
  );
  value = null;
  noStore(await imageHttp(get("original", tag), backend, auth), 404);
  noStore(await imageHttp(get("original", "*"), backend, auth), 404);
  value = { bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/png" };
  const before = reads;
  noStore(
    await imageHttp(get("original", tag), backend, async () => null),
    401,
  );
  expect(reads).toBe(before);
  for (const replacement of [null, { ...owner(), sessionId: "other" }]) {
    let calls = 0;
    noStore(
      await imageHttp(get("original", tag), backend, async () =>
        ++calls === 1 ? owner() : replacement,
      ),
      403,
    );
    expect(calls).toBe(2);
  }
  for (const [variant, bytes, mediaType] of [
    ["original", new Uint8Array(32 * 1024 * 1024 + 1), "image/png"],
    ["preview", new Uint8Array(160_001), "image/jpeg"],
    ["model", new Uint8Array(320_001), "image/jpeg"],
    ["preview", new Uint8Array(1), "image/png"],
    ["original", new Uint8Array(1), "text/html"],
  ] as const) {
    value = { bytes, mediaType };
    noStore(await imageHttp(get(variant, "*"), backend, auth), 400);
  }
  for (const [variant, size] of [
    ["preview", 160_000],
    ["model", 320_000],
  ] as const) {
    value = { bytes: new Uint8Array(size), mediaType: "image/jpeg" };
    expect((await imageHttp(get(variant), backend, auth))?.status).toBe(200);
  }
  value = { bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/png" };
  noStore(
    await imageHttp(new Request(url(), { method: "POST" }), backend, auth),
    405,
  );
  noStore(
    await imageHttp(
      new Request("http://fixture/api/chat/images", {
        method: "POST",
        headers: { origin: "http://other" },
      }),
      backend,
      auth,
    ),
    403,
  );
});
