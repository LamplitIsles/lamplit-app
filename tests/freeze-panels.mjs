import { readdir, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = resolve(root, ".scratch/companion-panels/artifacts");
await mkdir(output, { recursive: true });
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
async function command(args, cwd = root) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code) throw new Error(error);
  return out.trim();
}
const appHead = await command(["git", "rev-parse", "HEAD"]);
if (await command(["git", "status", "--porcelain"]))
  throw new Error("Commit source before freezing");
const browserFiles = await files(join(root, "apps/web/build"));
const browserManifest = [];
for (const path of browserFiles)
  browserManifest.push(
    `${await hash(path)}  ${relative(join(root, "apps/web/build"), path)}`,
  );
await writeFile(
  join(output, "browser.sha256"),
  browserManifest.join("\n") + "\n",
);
const stage = join(output, "contracts-stage");
await mkdir(join(stage, "package/dist"), { recursive: true });
for (const path of await files(join(root, "packages/contracts/dist")))
  await copyFile(
    path,
    join(
      stage,
      "package/dist",
      relative(join(root, "packages/contracts/dist"), path),
    ),
  );
for (const name of ["package.json", "LICENSE"])
  await copyFile(
    join(root, "packages/contracts", name),
    join(stage, "package", name),
  );
const contractsManifest = [];
for (const path of await files(join(stage, "package")))
  contractsManifest.push(
    `${await hash(path)}  ${relative(join(stage, "package"), path)}`,
  );
await writeFile(
  join(output, "contracts.sha256"),
  contractsManifest.join("\n") + "\n",
);
await command(
  ["tar", "-czf", join(output, "lamplit-web-panels.tgz"), "."],
  join(root, "apps/web/build"),
);
await command(
  ["tar", "-czf", join(output, "lamplit-contracts-panels.tgz"), "package"],
  stage,
);
// Cleanup is limited to this script's staging directory.
await rm(stage, { recursive: true });
const identity = {
  spec: 3062,
  appHead,
  baseline: "48d23a1776fce49d2d5489cd375f2f59c6b600fb",
  browserArchiveSHA256: await hash(join(output, "lamplit-web-panels.tgz")),
  browserManifestSHA256: await hash(join(output, "browser.sha256")),
  contractsArchiveSHA256: await hash(
    join(output, "lamplit-contracts-panels.tgz"),
  ),
  contractsManifestSHA256: await hash(join(output, "contracts.sha256")),
  browserFiles: browserFiles.length,
  viewports: [390, 1280],
  localAcceptance: "fixture-host",
  actualPiCflAcceptance: "pending Owner joint merge gate",
};
await writeFile(
  join(output, "identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
console.log(JSON.stringify(identity, null, 2));
