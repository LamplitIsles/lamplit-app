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
const matrix = process.argv.includes("--matrix-source-ui");
const thinking = matrix || process.argv.includes("--collapsed-thinking");
const output = join(
  root,
  matrix
    ? ".scratch/matrix-source-ui/candidate"
    : thinking
      ? ".scratch/collapsed-thinking/candidate"
      : ".scratch/native-durable-submissions/candidate",
);
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
  ...(matrix ? ["matrix-browser.mjs", "matrix-fixture.ts"] : []),
  ...(thinking ? ["thinking-browser.mjs", "thinking-fixture.ts"] : []),
  "browser.mjs",
  "voice-browser.mjs",
  "panels-browser.mjs",
  "images-browser.mjs",
  "optimistic-send-browser.mjs",
  "compact-browser.mjs",
  "search-browser.mjs",
  "notifications-browser.mjs",
  "notification-permission.mjs",
  "route-lifecycle-browser.mjs",
  "static-assets.mjs",
  "fixture.ts",
  "panels-fixture.ts",
  "images-fixture.ts",
  "submissions-fixture.ts",
  "native-gallery-browser.mjs",
  "keet-browser.mjs",
  "keet-fixture.ts",
  "compact-fixture.ts",
  "search-fixture.ts",
]) {
  const source = await readFile(join(root, "tests", name), "utf8");
  await writeFile(
    join(acceptance, name),
    source
      .replaceAll(
        "../packages/contracts/src/server.ts",
        "@lamplit/contracts/server",
      )
      .replaceAll("../packages/contracts/src/index.ts", "@lamplit/contracts")
      .replaceAll(
        "../packages/contracts/src/client.ts",
        "@lamplit/contracts/client",
      )
      .replaceAll(
        "../packages/contracts/dist/voice.js",
        "@lamplit/contracts/voice",
      ),
  );
}
await writeFile(
  join(acceptance, "README.md"),
  (
    await readFile(join(root, "docs/default-shared-frontend.md"), "utf8")
  ).replace(/\(([a-z-]+\.md)\)/g, "(docs/$1)"),
);
for (const name of [
  ...(matrix ? ["matrix-source-ui.md"] : []),
  ...(thinking ? ["collapsed-thinking.md"] : []),
  "companion-panels.md",
  "image-send-recovery.md",
  "quiet-compaction.md",
  "conversation-search.md",
  "desktop-companion-notifications.md",
  "integration.md",
  "protocol.md",
  "default-shared-frontend.md",
  "ui-baseline-and-compaction.md",
  "IMPORTS.md",
  "native-durable-submissions.md",
  "keet-source-restoration.md",
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
if (thinking) {
  // Freeze dependency resolution as in the existing Keet preparation.
  await command(
    ["bun", "install", "--lockfile-only"],
    join(stage, "contracts/package"),
  );
  await command(["bun", "install", "--lockfile-only"], acceptance);
}
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
const archive = matrix
  ? "lamplit-matrix-source-ui.tgz"
  : thinking
    ? "lamplit-collapsed-thinking.tgz"
    : "lamplit-native-durable-submissions.tgz";
await command(["tar", "-czf", join(output, archive), "."], stage);
const thinkingRunnerSHA256 = thinking
  ? await hash(join(acceptance, "thinking-browser.mjs"))
  : undefined;
const matrixRunnerSHA256 = matrix
  ? await hash(join(acceptance, "matrix-browser.mjs"))
  : undefined;
await rm(stage, { recursive: true }); // Only this invocation's staging tree.
const identity = {
  spec: matrix ? 3560 : thinking ? 3522 : 3435,
  appHead,
  baseline: matrix
    ? "364e5a169a42ea17a4b57b9876d2191a7bd085a7"
    : thinking
      ? "407aaf72979e0c05442697c6aaa758da845d88e0"
      : "75f6d3fe7789c8cc28922ae98caa8385459e4c65",
  status: "candidate; native workers blocked until Owner approval",
  archive,
  archiveSHA256: await hash(join(output, archive)),
  manifests,
  ...(thinking ? { thinkingRunnerSHA256 } : {}),
  ...(matrix ? { matrixRunnerSHA256 } : {}),
  runners: [
    ...(matrix ? ["matrix"] : []),
    ...(thinking ? ["thinking"] : []),
    "browser",
    "voice",
    "panels",
    "images",
    "compact",
    "search",
    "notifications",
    "route-lifecycle",
    "optimistic-send (same runner for App fixture and native hosts)",
    "keet",
    "native-gallery (plugin fake only)",
  ],
  localAcceptance: "test-owned App fixture; not native acceptance",
  actualPiCflAcceptance: "pending Owner-approved exact-artifact native runs",
};
await writeFile(
  join(output, "identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
console.log(JSON.stringify(identity, null, 2));
