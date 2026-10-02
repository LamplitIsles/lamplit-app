import {
  readdir,
  mkdir,
  copyFile,
  writeFile,
  rm,
  readFile,
} from "node:fs/promises";
import { resolve, join, relative } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = resolve(root, ".scratch/image-send-recovery/artifacts-review2");
if (await Bun.file(join(output, "identity.json")).exists())
  throw new Error("Artifact already frozen; consume the existing identity");
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
// Runner-only revision: reuse the Owner-reviewed browser/contracts bytes.
const previous = resolve(
  root,
  ".scratch/image-send-recovery/artifacts-review1",
);
const reviewed = JSON.parse(
  await readFile(join(previous, "identity.json"), "utf8"),
);
if (reviewed.appHead !== "ebde803fb955349c8bd05de259f13ca14b63f668")
  throw new Error("Unexpected reviewed product identity");
for (const [name, key] of [
  ["lamplit-web-images.tgz", "browserArchiveSHA256"],
  ["browser.sha256", "browserManifestSHA256"],
  ["lamplit-contracts-images.tgz", "contractsArchiveSHA256"],
  ["contracts.sha256", "contractsManifestSHA256"],
]) {
  if ((await hash(join(previous, name))) !== reviewed[key])
    throw new Error(`Reviewed artifact hash mismatch: ${name}`);
  await copyFile(join(previous, name), join(output, name));
}
const runnerStage = join(output, "acceptance-stage");
await mkdir(runnerStage, { recursive: true });
for (const name of [
  "images-browser.mjs",
  "route-lifecycle-browser.mjs",
  "images-fixture.ts",
  "panels-fixture.ts",
]) {
  const source = await readFile(join(root, "tests", name), "utf8");
  await writeFile(
    join(runnerStage, name),
    source
      .replaceAll(
        "../packages/contracts/src/server.ts",
        "@lamplit/contracts/server",
      )
      .replaceAll("../packages/contracts/src/index.ts", "@lamplit/contracts"),
  );
}
await copyFile(
  join(root, "docs/image-send-recovery.md"),
  join(runnerStage, "README.md"),
);
await writeFile(
  join(runnerStage, "package.json"),
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
const runnerManifest = [];
for (const path of await files(runnerStage))
  runnerManifest.push(`${await hash(path)}  ${relative(runnerStage, path)}`);
await writeFile(
  join(output, "acceptance.sha256"),
  runnerManifest.join("\n") + "\n",
);
await command(
  ["tar", "-czf", join(output, "lamplit-acceptance-images.tgz"), "."],
  runnerStage,
);
await rm(runnerStage, { recursive: true });
const identity = {
  spec: 3096,
  appHead: reviewed.appHead,
  browserSourceHead: reviewed.appHead,
  contractsSourceHead: reviewed.appHead,
  acceptanceSourceHead: appHead,
  acceptanceReview: "pending Owner focused review",
  baseline: "d61a2dcb046d903501f624971cc62ad339cead22",
  browserArchiveSHA256: await hash(join(output, "lamplit-web-images.tgz")),
  browserManifestSHA256: await hash(join(output, "browser.sha256")),
  contractsArchiveSHA256: await hash(
    join(output, "lamplit-contracts-images.tgz"),
  ),
  contractsManifestSHA256: await hash(join(output, "contracts.sha256")),
  acceptanceArchiveSHA256: await hash(
    join(output, "lamplit-acceptance-images.tgz"),
  ),
  acceptanceManifestSHA256: await hash(join(output, "acceptance.sha256")),
  browserFiles: reviewed.browserFiles,
  viewports: [390, 1280, 320],
  localAcceptance: "fixture-host",
  actualPiCflAcceptance: "pending Owner joint merge gate",
};
await writeFile(
  join(output, "identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
console.log(JSON.stringify(identity, null, 2));
