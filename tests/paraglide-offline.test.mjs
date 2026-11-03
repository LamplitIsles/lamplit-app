import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("the installed message plugin compiles both locales without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamplit-paraglide-offline-"));
  try {
    await mkdir(join(root, "project.inlang"));
    await mkdir(join(root, "messages"));
    await mkdir(join(root, "node_modules/@inlang"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "project.inlang/settings.json"),
      await readFile("apps/web/project.inlang/settings.json"),
    );
    await writeFile(
      join(root, "messages/en.json"),
      JSON.stringify({ offline_probe: "Hello" }),
    );
    await writeFile(
      join(root, "messages/zh.json"),
      JSON.stringify({ offline_probe: "你好" }),
    );
    const plugin = await realpath(
      "apps/web/node_modules/@inlang/plugin-message-format",
    );
    await symlink(
      plugin,
      join(root, "node_modules/@inlang/plugin-message-format"),
      "dir",
    );
    const denyNetwork = join(root, "deny-network.cjs");
    await writeFile(
      denyNetwork,
      `
      const net = require("node:net");
      globalThis.fetch = async () => { throw new Error("network disabled"); };
      net.Socket.prototype.connect = () => { throw new Error("network disabled"); };
    `,
    );
    execFileSync(
      "node",
      [
        resolve("apps/web/node_modules/@inlang/paraglide-js/bin/run.js"),
        "compile",
        "--project",
        "./project.inlang",
        "--outdir",
        "./generated",
        "--emit-ts-declarations",
        "--strategy",
        "globalVariable",
        "preferredLanguage",
        "baseLocale",
      ],
      {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: `--require=${denyNetwork}` },
        stdio: "pipe",
        timeout: 25_000,
      },
    );
    const message = await import(
      pathToFileURL(join(root, "generated/messages/offline_probe.js")).href
    );
    expect(message.offline_probe({}, { locale: "en" })).toBe("Hello");
    expect(message.offline_probe({}, { locale: "zh" })).toBe("你好");
    expect(
      await readFile(
        join(root, "generated/messages/offline_probe.d.ts"),
        "utf8",
      ),
    ).toContain("offline_probe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
