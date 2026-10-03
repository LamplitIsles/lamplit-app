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
const output = resolve(root, ".scratch/conversation-search/candidate");
if (await Bun.file(join(output, "identity.json")).exists())
  throw new Error(
    "Candidate identity exists; Owner reviews these bytes before final freeze",
  );
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
await command(["bun", "run", "build"]);
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
  ["tar", "-czf", join(output, "lamplit-web-search.tgz"), "."],
  join(root, "apps/web/build"),
);
await command(
  ["tar", "-czf", join(output, "lamplit-contracts-search.tgz"), "package"],
  stage,
);
// Cleanup is limited to this script's staging directory.
await rm(stage, { recursive: true });
const runnerStage = join(output, "acceptance-stage");
await mkdir(runnerStage, { recursive: true });
for (const name of [
  "search-browser.mjs",
  "search-fixture.ts",
  "fixture.ts",
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
  join(root, "docs/conversation-search.md"),
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
  ["tar", "-czf", join(output, "lamplit-acceptance-search.tgz"), "."],
  runnerStage,
);
await rm(runnerStage, { recursive: true });
const identity = {
  spec: 3142,
  appHead,
  baseline: "93a4d8272f470c68471d173794ff57354b28da8f",
  status: "candidate; pending Owner review and final freeze",
  browserArchiveSHA256: await hash(join(output, "lamplit-web-search.tgz")),
  browserManifestSHA256: await hash(join(output, "browser.sha256")),
  contractsArchiveSHA256: await hash(
    join(output, "lamplit-contracts-search.tgz"),
  ),
  contractsManifestSHA256: await hash(join(output, "contracts.sha256")),
  acceptanceArchiveSHA256: await hash(
    join(output, "lamplit-acceptance-search.tgz"),
  ),
  acceptanceManifestSHA256: await hash(join(output, "acceptance.sha256")),
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
