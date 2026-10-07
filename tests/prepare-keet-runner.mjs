import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const approved = join(root, ".scratch/keet-source-restoration/candidate");
const output = join(root, ".scratch/keet-source-restoration/runner-correction");
const approvedSHA =
  "c7219de5bf1596af8b27de3da38e3e75d375c7b8e7a9a975d822690a1aef31c2";
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
const hash = async (path) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
if (await Bun.file(join(output, "identity.json")).exists())
  throw new Error("Preserve existing runner identity");
if (await command(["git", "status", "--porcelain"]))
  throw new Error("Commit source before export");
const runnerHead = await command(["git", "rev-parse", "HEAD"]);
const identity = JSON.parse(
  await readFile(join(approved, "identity.json"), "utf8"),
);
if (
  identity.archiveSHA256 !== approvedSHA ||
  (await hash(join(approved, identity.archive))) !== approvedSHA
)
  throw new Error("Approved archive changed");
await mkdir(output, { recursive: true });
const original = join(output, "approved");
await mkdir(original);
await command([
  "tar",
  "-xzf",
  join(approved, identity.archive),
  "-C",
  original,
]);
for (const [name, directory] of [
  ["browser", "browser"],
  ["contracts", "contracts/package"],
  ["acceptance", "acceptance"],
]) {
  if (
    (await hash(join(original, `${name}.sha256`))) !==
    identity.manifests[name].sha256
  )
    throw new Error("Approved manifest changed");
  await command(
    ["shasum", "-a", "256", "-c", join(original, `${name}.sha256`)],
    join(original, directory),
  );
}
const stage = join(output, "stage");
const runner = join(stage, "runner");
await mkdir(runner, { recursive: true });
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
    join(runner, name),
    source
      .replaceAll(
        "../packages/contracts/src/server.ts",
        "@lamplit/contracts/server",
      )
      .replaceAll("../packages/contracts/src/index.ts", "@lamplit/contracts"),
  );
}
for (const name of ["package.json", "bun.lock", "LICENSE"])
  await copyFile(join(original, "acceptance", name), join(runner, name));
await copyFile(
  join(root, "docs/keet-source-restoration.md"),
  join(runner, "README.md"),
);
await writeFile(join(stage, "RUNNER_HEAD"), runnerHead + "\n");
const entries = [];
for (const name of (await readdir(runner)).sort())
  entries.push(`${await hash(join(runner, name))}  ${name}`);
await writeFile(join(stage, "runner.sha256"), entries.join("\n") + "\n");
await copyFile(join(stage, "runner.sha256"), join(output, "runner.sha256"));
const archive = "lamplit-keet-runner-correction.tgz";
await command(["tar", "-czf", join(output, archive), "."], stage);
const corrected = {
  spec: 3408,
  runnerHead,
  status:
    "correction candidate; Orc focused review required before native replacement",
  archive,
  archiveSHA256: await hash(join(output, archive)),
  runnerSHA256: await hash(join(runner, "keet-browser.mjs")),
  manifestSHA256: await hash(join(output, "runner.sha256")),
  approved: {
    appHead: identity.appHead,
    archive: identity.archive,
    archiveSHA256: approvedSHA,
    browser: identity.manifests.browser,
    contracts: identity.manifests.contracts,
  },
  profiles: {
    dm: "App/CFL default; DM decode/reload/history",
    "text-only": "Pi; native explanations only, no Keet image-byte coverage",
  },
  dependencyLocks:
    "Unmodified approved acceptance bun.lock and contracts/package/bun.lock; frozen install only",
  actualJointAcceptance: "pending Orc",
};
await writeFile(
  join(output, "identity.json"),
  JSON.stringify(corrected, null, 2) + "\n",
);
console.log(JSON.stringify(corrected, null, 2));
