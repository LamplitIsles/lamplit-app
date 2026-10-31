import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function dependencyNotices(store, destination) {
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = join(store, entry.name, "node_modules");
    let names;
    try {
      names = await readdir(modules, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!name.isDirectory() || name.name.startsWith(".")) continue;
      const paths = name.name.startsWith("@")
        ? (await readdir(join(modules, name.name), { withFileTypes: true }))
            .filter((item) => item.isDirectory())
            .map((item) => join(modules, name.name, item.name))
        : [join(modules, name.name)];
      for (const path of paths) {
        const pkg = JSON.parse(
          await readFile(join(path, "package.json"), "utf8"),
        );
        if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
          throw new Error("Dependency has no name or version");
        const target = join(
          destination,
          encodeURIComponent(pkg.name),
          encodeURIComponent(pkg.version),
        );
        for (const file of await readdir(path, { withFileTypes: true })) {
          if (
            !file.isFile() ||
            !/^(license|licence|notice)(\.|$)/i.test(file.name)
          )
            continue;
          await mkdir(target, { recursive: true });
          const bytes = await readFile(join(path, file.name));
          const output = join(target, file.name);
          try {
            await writeFile(output, bytes, { flag: "wx" });
          } catch (error) {
            if (
              error.code !== "EEXIST" ||
              !(await readFile(output)).equals(bytes)
            )
              throw new Error(
                `Conflicting dependency notice: ${pkg.name}@${pkg.version}/${file.name}`,
              );
          }
        }
      }
    }
  }
}

async function hashes(directory, relative = "") {
  const result = {};
  for (const entry of (
    await readdir(join(directory, relative), { withFileTypes: true })
  ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(relative, entry.name);
    if (entry.isDirectory())
      Object.assign(result, await hashes(directory, path));
    else if (entry.isFile())
      result[path] = createHash("sha256")
        .update(await readFile(join(directory, path)))
        .digest("hex");
    else throw new Error(`Unexpected non-file resource: ${path}`);
  }
  return result;
}

export async function packageFrontend(
  root,
  revision,
  output,
  fontLicense,
  dependencyStore,
) {
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("Expected a full lowercase commit SHA");
  const stage = await mkdtemp(join(tmpdir(), "lamplit-frontend-"));
  try {
    // Refuse links before copying: an archive must contain only self-contained files.
    await hashes(join(root, "apps/web/build"));
    await hashes(join(root, "packages/contracts/dist"));
    await cp(join(root, "apps/web/build"), join(stage, "browser"), {
      recursive: true,
    });
    await cp(
      join(root, "packages/contracts/dist"),
      join(stage, "contracts/dist"),
      { recursive: true },
    );
    await mkdir(join(stage, "licenses"));
    await cp(
      join(root, "LICENSE"),
      join(stage, "licenses/lamplit-app-Apache-2.0.txt"),
    );
    await cp(
      join(root, "docs/IMPORTS.md"),
      join(stage, "licenses/lamplit-app-IMPORTS.md"),
    );
    await cp(fontLicense, join(stage, "licenses/NotoSansSC-OFL-1.1.txt"));
    for (const name of [
      "capacitor-community-media-9.1.0-MIT.txt",
      "chord-1.0.0-MIT.txt",
      "skeleton-elements-4.0.1-MIT.txt",
    ])
      await cp(
        join(root, "docs/licenses", name),
        join(stage, "licenses", name),
      );
    if (dependencyStore)
      await dependencyNotices(
        dependencyStore,
        join(stage, "licenses/dependencies"),
      );
    const manifest = {
      revision,
      browser: await hashes(join(stage, "browser")),
      contracts: await hashes(join(stage, "contracts")),
      licenses: await hashes(join(stage, "licenses")),
    };
    if (
      !manifest.browser["index.html"] ||
      !manifest.contracts["dist/cfl-browser-host-auth.js"]
    )
      throw new Error("Browser index or compiled auth marker missing");
    const marker = await readFile(
      join(stage, "contracts/dist/cfl-browser-host-auth.js"),
      "utf8",
    );
    if (
      marker !==
      'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n'
    )
      throw new Error("Unexpected compiled auth marker");
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    execFileSync(
      "tar",
      [
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=u=rwX,go=rX",
        "--use-compress-program=gzip -n",
        "-cf",
        resolve(output),
        "-C",
        stage,
        "browser",
        "contracts",
        "licenses",
        "manifest.json",
      ],
      { stdio: "inherit" },
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(join(root, "apps/web/package.json"));
  const fontLicense = join(
    dirname(require.resolve("@fontsource/noto-sans-sc/package.json")),
    "LICENSE",
  );
  await packageFrontend(
    root,
    process.argv[2],
    process.argv[3],
    fontLicense,
    join(root, "node_modules/.bun"),
  );
}
