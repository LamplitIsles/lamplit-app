import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("contracts build emits the CFL browser-host auth marker", async () => {
  const output = await mkdtemp(join(tmpdir(), "lamplit-auth-contract-"));
  try {
    execFileSync(resolve("node_modules/.bin/tsc"), [
      "-p",
      "packages/contracts/tsconfig.build.json",
      "--outDir",
      output,
    ]);
    const manifest = await Bun.file("packages/contracts/package.json").json();
    expect(manifest.exports["./cfl-browser-host-auth"]).toEqual({
      types: "./dist/cfl-browser-host-auth.d.ts",
      import: "./dist/cfl-browser-host-auth.js",
    });
    const marker = join(output, "cfl-browser-host-auth.js");
    expect(await readFile(marker, "utf8")).toBe(
      'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n',
    );
    const contract = await import(pathToFileURL(marker).href);
    expect(contract.CFL_BROWSER_HOST_AUTH_PROTOCOL).toBe("better-auth");
    expect(
      await readFile(join(output, "cfl-browser-host-auth.d.ts"), "utf8"),
    ).toBe(
      'export declare const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n',
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
