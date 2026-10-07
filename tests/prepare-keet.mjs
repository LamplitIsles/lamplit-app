import {
  readdir,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".scratch/keet-source-restoration/candidate");
if (await Bun.file(join(output, "identity.json")).exists())
  throw new Error("Candidate exists; preserve its identity for Owner review");
async function command(args, cwd = root) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code) throw new Error(error || out);
  return out.trim();
}
const appHead = await command(["git", "rev-parse", "HEAD"]);
if (await command(["git", "status", "--porcelain"]))
  throw new Error("Commit all source before preparing the candidate");
await command(["bun", "run", "build"]);
const hash = async (path) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error("Unexpected artifact entry");
  }
  return result.sort();
}
async function copyTree(source, target) {
  for (const path of await files(source)) {
    const destination = join(target, relative(source, path));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
  }
}
await mkdir(output, { recursive: true });
const stage = join(output, "stage");
await copyTree(join(root, "apps/web/build"), join(stage, "browser"));
await copyTree(
  join(root, "packages/contracts/dist"),
  join(stage, "contracts/package/dist"),
);
for (const name of ["package.json", "LICENSE"])
  await copyFile(
    join(root, "packages/contracts", name),
    join(stage, "contracts/package", name),
  );
const acceptance = join(stage, "acceptance");
await mkdir(join(acceptance, "docs"), { recursive: true });
for (const name of [
  "keet-browser.mjs",
  "keet-fixture.ts",
  "fixture.ts",
  "panels-fixture.ts",
  "search-fixture.ts",
  "notification-permission.mjs",
  "static-assets.mjs",
]) {
  const source = await readFile(join(root, "tests", name), "utf8");
  await writeFile(
    join(acceptance, name),
    source
      .replaceAll(
        "../packages/contracts/src/server.ts",
        "@lamplit/contracts/server",
      )
      .replaceAll("../packages/contracts/src/index.ts", "@lamplit/contracts"),
  );
}
await writeFile(
  join(acceptance, "README.md"),
  (
    await readFile(join(root, "docs/keet-source-restoration.md"), "utf8")
  ).replace(/\(([a-z-]+\.md)\)/g, "(docs/$1)"),
);
for (const name of [
  "keet-source-restoration.md",
  "IMPORTS.md",
  "protocol.md",
  "integration.md",
])
  await copyFile(join(root, "docs", name), join(acceptance, "docs", name));
await copyFile(join(root, "LICENSE"), join(acceptance, "LICENSE"));
await writeFile(
  join(acceptance, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: {
        "@lamplit/contracts": "file:../contracts/package",
        "@playwright/test": "1.63.0",
      },
    },
    null,
    2,
  ) + "\n",
);
// Local linked contracts resolve dependencies from their own package directory.
await command(
  ["bun", "install", "--lockfile-only"],
  join(stage, "contracts/package"),
);
// Freeze the dependency resolution with the runner; consumers install these exact versions.
await command(["bun", "install", "--lockfile-only"], acceptance);
const manifests = {};
for (const [name, directory] of [
  ["browser", "browser"],
  ["contracts", "contracts/package"],
  ["acceptance", "acceptance"],
]) {
  const entries = [];
  for (const path of await files(join(stage, directory)))
    entries.push(
      `${await hash(path)}  ${relative(join(stage, directory), path)}`,
    );
  const manifest = `${name}.sha256`;
  await writeFile(join(output, manifest), entries.join("\n") + "\n");
  await copyFile(join(output, manifest), join(stage, manifest));
  manifests[name] = {
    files: entries.length,
    sha256: await hash(join(output, manifest)),
  };
}
await writeFile(join(stage, "SOURCE_HEAD"), appHead + "\n");
const archive = "lamplit-keet-source-restoration.tgz";
await command(["tar", "-czf", join(output, archive), "."], stage);
const runnerSHA256 = await hash(join(acceptance, "keet-browser.mjs"));
await rm(stage, { recursive: true }); // Only this invocation's staging tree.
const identity = {
  spec: 3408,
  appHead,
  baseline: "7d3834f12c5be11655b93a3d9b045e787bdf3460",
  status: "candidate; native use requires Orc acceptance of these exact bytes",
  archive,
  archiveSHA256: await hash(join(output, archive)),
  manifests,
  runners: [{ path: "acceptance/keet-browser.mjs", sha256: runnerSHA256 }],
  toolchain:
    "Bun 1.3.14; Playwright 1.63.0; installed Chrome or APP_ACCEPTANCE_BROWSER",
  localAcceptance: "test-owned App fixture; not native acceptance",
  actualPiCflAcceptance: "pending Orc-approved exact-artifact native runs",
};
await writeFile(
  join(output, "identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
console.log(JSON.stringify(identity, null, 2));
