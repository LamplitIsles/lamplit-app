import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageFrontend } from "../scripts/package-frontend.mjs";
import { publishForgejo, publishGithub } from "../scripts/publish-frontend.mjs";

const sha = "a".repeat(40);
const marker = 'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n';
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "frontend-test-"));
  dirs.push(root);
  for (const dir of [
    "apps/web/build/assets",
    "packages/contracts/dist",
    "docs",
    "docs/licenses",
  ])
    await mkdir(join(root, dir), { recursive: true });
  for (const [path, content] of Object.entries({
    "apps/web/build/index.html": "<script src='/assets/app.js'></script>",
    "apps/web/build/assets/app.js": "hello",
    "packages/contracts/dist/cfl-browser-host-auth.js": marker,
    "packages/contracts/dist/client.js": "client",
    LICENSE: "license",
    "docs/IMPORTS.md": "imports",
    "docs/licenses/chord-1.0.0-MIT.txt": "chord notice fixture",
    "docs/licenses/skeleton-elements-4.0.1-MIT.txt": "skeleton notice fixture",
    "docs/licenses/capacitor-community-media-9.1.0-MIT.txt": await readFile(
      new URL(
        "../docs/licenses/capacitor-community-media-9.1.0-MIT.txt",
        import.meta.url,
      ),
      "utf8",
    ),
    font: "font license",
  }))
    await writeFile(join(root, path), content);
  return root;
}

test("archive contains a usable browser, byte-exact contracts, licenses and CFL manifest; packaging is repeatable", async () => {
  const root = await fixture();
  const first = join(root, "one.tar.gz"),
    second = join(root, "two.tar.gz");
  await packageFrontend(root, sha, first, join(root, "font"));
  await packageFrontend(root, sha, second, join(root, "font"));
  expect(await readFile(first)).toEqual(await readFile(second));
  const extracted = join(root, "unpacked");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", first, "-C", extracted]);
  const manifest = JSON.parse(
    await readFile(join(extracted, "manifest.json"), "utf8"),
  );
  expect(manifest.revision).toBe(sha);
  expect(Object.keys(manifest.browser).sort()).toEqual([
    "assets/app.js",
    "index.html",
  ]);
  expect(Object.keys(manifest.contracts).sort()).toEqual([
    "dist/cfl-browser-host-auth.js",
    "dist/client.js",
  ]);
  expect(Object.keys(manifest.licenses).sort()).toEqual([
    "NotoSansSC-OFL-1.1.txt",
    "capacitor-community-media-9.1.0-MIT.txt",
    "chord-1.0.0-MIT.txt",
    "lamplit-app-Apache-2.0.txt",
    "lamplit-app-IMPORTS.md",
    "skeleton-elements-4.0.1-MIT.txt",
  ]);
  const { createHash } = await import("node:crypto");
  for (const group of ["browser", "contracts", "licenses"])
    for (const [path, hash] of Object.entries(manifest[group]))
      expect(
        createHash("sha256")
          .update(await readFile(join(extracted, group, path)))
          .digest("hex"),
      ).toBe(hash);
  expect(
    await readFile(
      join(extracted, "contracts/dist/cfl-browser-host-auth.js"),
      "utf8",
    ),
  ).toBe(marker);
  expect(await readFile(join(extracted, "browser/assets/app.js"), "utf8")).toBe(
    "hello",
  );
  expect(
    await readFile(join(extracted, "licenses/chord-1.0.0-MIT.txt"), "utf8"),
  ).toBe("chord notice fixture");
  expect(
    await readFile(
      join(extracted, "licenses/capacitor-community-media-9.1.0-MIT.txt"),
      "utf8",
    ),
  ).toBe(
    await readFile(
      join(root, "docs/licenses/capacitor-community-media-9.1.0-MIT.txt"),
      "utf8",
    ),
  );
  expect(
    await readFile(
      join(extracted, "licenses/skeleton-elements-4.0.1-MIT.txt"),
      "utf8",
    ),
  ).toBe("skeleton notice fixture");
});

test("packaging rejects incompatible marker", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "packages/contracts/dist/cfl-browser-host-auth.js"),
    "wrong",
  );
  await expect(
    packageFrontend(root, sha, join(root, "out.tar.gz"), join(root, "font")),
  ).rejects.toThrow("marker");
});

describe("publication", () => {
  const bytes = Buffer.from("archive");
  test("Forgejo checks matching retries and refuses conflicting assets without upload", async () => {
    let methods = [];
    const fetcher = async (_url, options) => {
      methods.push(options.method ?? "GET");
      return new Response(bytes);
    };
    await publishForgejo(sha, bytes, "fake", fetcher);
    expect(methods).toEqual(["GET"]);
    methods = [];
    await expect(
      publishForgejo(sha, Buffer.from("other"), "fake", fetcher),
    ).rejects.toThrow("differs");
    expect(methods).toEqual(["GET"]);
  });
  test("Forgejo inspects after successful upload and does not replay an uncertain upload", async () => {
    const methods = [];
    const fetcher = async (_url, options) => {
      methods.push(options.method ?? "GET");
      return methods.length === 1
        ? new Response(null, { status: 404 })
        : methods.length === 2
          ? new Response(null, { status: 201 })
          : new Response(bytes);
    };
    await publishForgejo(sha, bytes, "fake", fetcher);
    expect(methods).toEqual(["GET", "PUT", "GET"]);
    let calls = 0;
    await expect(
      publishForgejo(sha, bytes, "fake", async () => {
        if (++calls === 1) return new Response(null, { status: 404 });
        throw new Error("connection lost");
      }),
    ).rejects.toThrow("inspect destination");
    expect(calls).toBe(2);
  });
  test("GitHub verifies mirror, tag and public matching asset on retry", async () => {
    const methods = [];
    const fetcher = async (url, options) => {
      methods.push([url, options.method ?? "GET"]);
      if (url.includes("/git/commits/")) return Response.json({ sha });
      if (url.includes("/git/ref/tags/"))
        return Response.json({ object: { type: "commit", sha } });
      if (url.includes("/releases/tags/"))
        return Response.json({ id: 42, tag_name: `app-${sha}`, draft: false });
      if (url.includes("/releases/42/assets?"))
        return Response.json([
          { id: 7, state: "uploaded", name: `lamplit-app-${sha}.tar.gz` },
        ]);
      return new Response(bytes);
    };
    await publishGithub(sha, bytes, "fake", fetcher);
    expect(methods.every(([, method]) => method === "GET")).toBe(true);
    await expect(
      publishGithub(sha, Buffer.from("other"), "fake", fetcher),
    ).rejects.toThrow("differs");
  });
  test("GitHub waits for mirror and rejects conflicting tag before publishing", async () => {
    let calls = 0;
    await expect(
      publishGithub(
        sha,
        bytes,
        "fake",
        async () => {
          calls++;
          return new Response(null, { status: 404 });
        },
        async () => {},
      ),
    ).rejects.toThrow("mirror");
    expect(calls).toBe(12);
    const paths = [];
    await expect(
      publishGithub(sha, bytes, "fake", async (url) => {
        paths.push(url);
        return url.includes("/git/commits/")
          ? Response.json({ sha })
          : Response.json({ object: { type: "commit", sha: "b".repeat(40) } });
      }),
    ).rejects.toThrow("tag");
    expect(paths.length).toBe(2);
  });
  test("GitHub creates a release only after the mirror has the commit, verifies its tag and publishes once", async () => {
    const methods = [];
    let tagCreated = false;
    const fetcher = async (url, options) => {
      const method = options.method ?? "GET";
      methods.push([url, method]);
      if (url.includes("/git/commits/")) return Response.json({ sha });
      if (url.includes("/git/ref/tags/"))
        return tagCreated
          ? Response.json({ object: { type: "commit", sha } })
          : new Response(null, { status: 404 });
      if (url.includes("/releases/tags/"))
        return new Response(null, { status: 404 });
      if (url.endsWith("/releases") && method === "POST") {
        const body = JSON.parse(options.body);
        expect(body.target_commitish).toBe(sha);
        expect(body.tag_name).toBe(`app-${sha}`);
        tagCreated = true;
        return Response.json(
          { id: 42, tag_name: body.tag_name, draft: false },
          { status: 201 },
        );
      }
      if (url.includes("/releases/42/assets?"))
        return method === "POST"
          ? Response.json({}, { status: 201 })
          : Response.json([]);
      return new Response(bytes);
    };
    await publishGithub(sha, bytes, "fake", fetcher);
    expect(methods.filter(([, method]) => method === "POST").length).toBe(2);
    expect(methods.at(-1)[0]).toContain("/git/ref/tags/");
  });
});
