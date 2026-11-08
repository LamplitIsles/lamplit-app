import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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
    "packages/contracts/fixtures",
    "docs",
    "docs/licenses",
  ])
    await mkdir(join(root, dir), { recursive: true });
  for (const [path, content] of Object.entries({
    "apps/web/build/index.html": "<script src='/assets/app.js'></script>",
    "apps/web/build/assets/app.js": "hello",
    "apps/web/build/a2ui.html": '<script type="module" src="/assets/a2ui.js"></script><link rel="stylesheet" href="/assets/a2ui.css">',
    "apps/web/build/assets/a2ui.js": "export const surface = true;",
    "apps/web/build/assets/a2ui.css": ".surface { display: block; }",
    "packages/contracts/dist/workspace-media.js": 'export const workspaceMediaUrl = () => "test";',
    "packages/contracts/dist/workspace-media.d.ts": "export declare function workspaceMediaUrl(): string;",
    "packages/contracts/fixtures/a2ui-v1.json": '{"testOnly":true}',
    "packages/contracts/dist/cfl-browser-host-auth.js": marker,
    "packages/contracts/dist/client.js": 'export const client = "client";',
    "packages/contracts/dist/client.d.ts": "export declare const client: string;",
    "packages/contracts/dist/cfl-browser-host-auth.d.ts": "export declare const CFL_BROWSER_HOST_AUTH_PROTOCOL: string;",
    "packages/contracts/dist/server.js": 'export { replyChunks } from "./reply-chunks.js";',
    "packages/contracts/dist/server.d.ts": 'export { replyChunks } from "./reply-chunks.js";',
    "packages/contracts/dist/reply-chunks.js": 'import { Lexer } from "marked"; export const replyChunks = text => Lexer.lex(text);',
    "packages/contracts/dist/reply-chunks.d.ts": "export declare function replyChunks(text: string): unknown[];",
    "packages/contracts/dist/voice.js": 'export const voice = "voice";',
    "packages/contracts/dist/voice.d.ts": "export declare const voice: string;",
    "packages/contracts/dist/wire.js": 'export const wire = "wire";',
    "packages/contracts/dist/wire.d.ts": "export declare const wire: string;",
    "packages/contracts/dist/index.js":
      'import { fixture } from "typebox"; export { fixture };',
    "packages/contracts/dist/index.d.ts":
      "export declare const fixture: string;",
    "packages/contracts/package.json": await readFile(
      new URL("../packages/contracts/package.json", import.meta.url),
      "utf8",
    ),
    "packages/contracts/LICENSE": "contract license fixture",
    LICENSE: "license",
    "docs/IMPORTS.md": "imports",
    "docs/licenses/chord-1.0.0-MIT.txt": await readFile(
      new URL("../docs/licenses/chord-1.0.0-MIT.txt", import.meta.url),
      "utf8",
    ),
    "docs/licenses/konsta-5.5.0-MIT.txt": await readFile(
      new URL("../docs/licenses/konsta-5.5.0-MIT.txt", import.meta.url),
      "utf8",
    ),
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
    "a2ui.html",
    "assets/a2ui.css",
    "assets/a2ui.js",
    "assets/app.js",
    "index.html",
  ]);
  expect(Object.keys(manifest.contracts).sort()).toEqual([
    "dist/cfl-browser-host-auth.d.ts",
    "dist/cfl-browser-host-auth.js",
    "dist/client.d.ts",
    "dist/client.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/reply-chunks.d.ts",
    "dist/reply-chunks.js",
    "dist/server.d.ts",
    "dist/server.js",
    "dist/voice.d.ts",
    "dist/voice.js",
    "dist/wire.d.ts",
    "dist/wire.js",
    "dist/workspace-media.d.ts",
    "dist/workspace-media.js",
  ]);
  expect(Object.keys(manifest.licenses).sort()).toEqual([
    "NotoSansSC-OFL-1.1.txt",
    "capacitor-community-media-9.1.0-MIT.txt",
    "chord-1.0.0-MIT.txt",
    "konsta-5.5.0-MIT.txt",
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
  const a2ui = await readFile(join(extracted, "browser/a2ui.html"), "utf8");
  for (const pattern of [/src="\/([^" ]+\.js)"/, /href="\/([^" ]+\.css)"/]) {
    const referenced = a2ui.match(pattern)?.[1];
    expect(referenced).toBeDefined();
    expect(manifest.browser[referenced]).toBe(
      createHash("sha256")
        .update(await readFile(join(extracted, "browser", referenced)))
        .digest("hex"),
    );
  }
  expect(Object.keys(manifest.contracts).some(path => path.includes("fixtures/"))).toBe(false);

  expect(
    await readFile(join(extracted, "licenses/chord-1.0.0-MIT.txt"), "utf8"),
  ).toBe(
    await readFile(join(root, "docs/licenses/chord-1.0.0-MIT.txt"), "utf8"),
  );
  expect(
    await readFile(join(extracted, "licenses/konsta-5.5.0-MIT.txt"), "utf8"),
  ).toBe(
    await readFile(join(root, "docs/licenses/konsta-5.5.0-MIT.txt"), "utf8"),
  );
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

test("independent npm package is reproducible, installable and matches every frontend contract byte", async () => {
  const root = await fixture();
  const frontend = join(root, "frontend.tar.gz");
  const archive = join(root, "contracts.tar.gz");
  const second = join(root, "contracts2.tar.gz");
  await packageFrontend(
    root,
    sha,
    frontend,
    join(root, "font"),
    undefined,
    archive,
  );
  await packageFrontend(
    root,
    sha,
    join(root, "frontend2.tar.gz"),
    join(root, "font"),
    undefined,
    second,
  );
  expect(await readFile(archive)).toEqual(await readFile(second));
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const checksum = join(root, "trusted.sha256");
  await writeFile(checksum, `${digest}  ${archive}\n`);
  expect(spawnSync("sha256sum", ["-c", checksum]).status).toBe(0);
  await writeFile(archive, Buffer.from("tampered archive"));
  expect(spawnSync("sha256sum", ["-c", checksum]).status).not.toBe(0);
  await writeFile(archive, await readFile(second));
  const front = join(root, "front");
  const unpacked = join(root, "unpacked-contract");
  await mkdir(front);
  await mkdir(unpacked);
  execFileSync("tar", ["-xzf", frontend, "-C", front]);
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const manifest = JSON.parse(
    await readFile(join(front, "manifest.json"), "utf8"),
  );
  const pkg = JSON.parse(
    await readFile(join(unpacked, "package/package.json"), "utf8"),
  );
  expect(pkg.name).toBe("@lamplit/contracts");
  expect(pkg.exports["."].import).toBe("./dist/index.js");
  expect(pkg.exports["./server"].import).toBe("./dist/server.js");
  expect(pkg.exports["./reply-chunks"].import).toBe("./dist/reply-chunks.js");
  expect(pkg.exports["./fixtures/a2ui-v1.json"]).toBeUndefined();
  expect(pkg.files).not.toContain("fixtures");
  for (const entry of Object.values(pkg.exports)) {
    expect(typeof entry).toBe("object");
    for (const path of Object.values(entry)) {
      expect(path).toMatch(/^\.\/dist\/[a-z0-9-]+\.(?:js|d\.ts)$/);
      const relative = path.slice(2);
      const frontendBytes = await readFile(join(front, "contracts", relative));
      expect(await readFile(join(unpacked, "package", relative))).toEqual(
        frontendBytes,
      );
      expect(manifest.contracts[relative]).toBe(
        createHash("sha256").update(frontendBytes).digest("hex"),
      );
    }
  }
  expect(
    Object.keys(manifest.contracts).every((path) => path.startsWith("dist/")),
  ).toBe(true);
  expect(
    execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }),
  ).not.toContain("fixtures/");
  expect(pkg.dependencies).toEqual({
    "@earendil-works/chord": "1.0.0",
    marked: "18.0.14",
    typebox: "1.3.34",
  });
  expect(pkg.license).toBe("Apache-2.0");
  const chordNotice = await readFile(
    join(root, "docs/licenses/chord-1.0.0-MIT.txt"),
  );
  expect(
    await readFile(join(unpacked, "package/licenses/chord-1.0.0-MIT.txt")),
  ).toEqual(chordNotice);
  expect(await readFile(join(unpacked, "package/LICENSE"), "utf8")).toBe(
    "contract license fixture",
  );
  expect(
    JSON.parse(
      await readFile(join(unpacked, "package/lamplit-source.json"), "utf8"),
    ).revision,
  ).toBe(sha);
  for (const path of Object.keys(manifest.contracts))
    expect(await readFile(join(unpacked, "package", path))).toEqual(
      await readFile(join(front, "contracts", path)),
    );
  for (const name of ["workspace-media.js", "workspace-media.d.ts"]) {
    const path = `dist/${name}`;
    expect(manifest.contracts[path]).toBeDefined();
    expect(await readFile(join(unpacked, "package", path))).toEqual(
      await readFile(join(front, "contracts", path)),
    );
  }


  // npm resolves the real declared versions using local, test-owned fixtures only.
  const consumer = join(root, "consumer");
  const chord = join(root, "chord");
  const marked = join(root, "marked");
  const typebox = join(root, "typebox");
  for (const dir of [consumer, chord, marked, typebox]) await mkdir(dir);
  await writeFile(
    join(consumer, "package.json"),
    '{"private":true,"type":"module"}',
  );
  await writeFile(
    join(chord, "package.json"),
    '{"name":"@earendil-works/chord","version":"1.0.0"}',
  );
  await writeFile(
    join(marked, "package.json"),
    '{"name":"marked","version":"18.0.14","type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(marked, "index.js"),
    'export class Lexer { static lex(text) { return [{ raw: text }]; } }',
  );
  await writeFile(
    join(typebox, "package.json"),
    '{"name":"typebox","version":"1.3.34","type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(typebox, "index.js"),
    'export const fixture = "installed";',
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      archive,
      chord,
      marked,
      typebox,
    ],
    {
      cwd: consumer,
      stdio: "pipe",
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    },
  );
  expect(
    await readFile(
      join(
        consumer,
        "node_modules/@lamplit/contracts/licenses/chord-1.0.0-MIT.txt",
      ),
    ),
  ).toEqual(chordNotice);
  const result = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      'import { fixture } from "@lamplit/contracts"; import { replyChunks } from "@lamplit/contracts/reply-chunks"; import { replyChunks as fromServer } from "@lamplit/contracts/server"; if (fixture !== "installed" || replyChunks("a\\nb")[0].raw !== "a\\nb" || fromServer("x")[0].raw !== "x") process.exit(1);',
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  expect(result).toBe("");
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
  test("both destinations reject conflicting independent contract assets and inspect uncertain uploads", async () => {
    const name = `lamplit-contracts-${sha}.tar.gz`;
    const calls = [];
    const forge = async (url, options) => {
      calls.push([url, options.method ?? "GET"]);
      return new Response(Buffer.from("tampered"));
    };
    await expect(
      publishForgejo(sha, bytes, "fake", forge, name),
    ).rejects.toThrow("differs");
    expect(calls).toEqual([[expect.stringContaining(name), "GET"]]);
    let uploaded = false;
    const githubCalls = [];
    const github = async (url, options) => {
      const method = options.method ?? "GET";
      githubCalls.push([url, method]);
      if (url.includes("/git/commits/")) return Response.json({ sha });
      if (url.includes("/git/ref/tags/"))
        return Response.json({ object: { type: "commit", sha } });
      if (url.includes("/releases/tags/"))
        return Response.json({ id: 42, tag_name: `app-${sha}`, draft: false });
      if (method === "POST") {
        uploaded = true;
        throw new Error("connection lost");
      }
      if (url.includes("/releases/42/assets?"))
        return Response.json(
          uploaded ? [{ id: 8, state: "uploaded", name }] : [],
        );
      return new Response(Buffer.from("tampered"));
    };
    await expect(
      publishGithub(sha, bytes, "fake", github, async () => {}, name),
    ).rejects.toThrow("inspect destination");
    expect(githubCalls.filter(([, method]) => method === "POST")).toHaveLength(
      1,
    );
    githubCalls.length = 0;
    await expect(
      publishGithub(sha, bytes, "fake", github, async () => {}, name),
    ).rejects.toThrow("differs");
    expect(githubCalls.every(([, method]) => method === "GET")).toBe(true);
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
