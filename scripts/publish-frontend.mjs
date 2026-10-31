import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const github = "https://api.github.com/repos/LamplitIsles/lamplit-app";
const forgejo =
  "https://forgejo.n5.guion.io/api/packages/LamplitIsles/generic/lamplit-app";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function request(fetcher, url, token, options = {}) {
  try {
    return await fetcher(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("Network request failed; inspect destination before retry");
  }
}

async function checked(response, context, allowed = []) {
  if (!response.ok && !allowed.includes(response.status))
    throw new Error(
      `${context}: HTTP ${response.status}; inspect destination before retry`,
    );
  return response;
}

async function compare(response, artifact, context) {
  const actual = Buffer.from(await response.arrayBuffer());
  if (sha256(actual) !== sha256(artifact))
    throw new Error(`${context}: existing asset differs; inspect manually`);
}

export async function publishForgejo(
  revision,
  artifact,
  token,
  fetcher = fetch,
) {
  if (!token) throw new Error("Forgejo package secret missing");
  const url = `${forgejo}/${revision}/lamplit-app-${revision}.tar.gz`;
  const get = () => request(fetcher, url, token);
  let response = await checked(await get(), "Forgejo lookup", [404]);
  if (response.status === 404) {
    await checked(
      await request(fetcher, url, token, {
        method: "PUT",
        body: artifact,
        headers: { "Content-Type": "application/gzip" },
      }),
      "Forgejo upload",
    );
    response = await checked(await get(), "Forgejo verification");
  }
  await compare(response, artifact, "Forgejo");
}

export async function publishGithub(
  revision,
  artifact,
  token,
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  if (!token) throw new Error("GitHub release secret missing");
  const tag = `app-${revision}`;
  const name = `lamplit-app-${revision}.tar.gz`;
  const api = (path, options = {}) =>
    request(fetcher, `${github}${path}`, token, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
  let commit;
  for (let attempt = 0; attempt < 12; attempt++) {
    commit = await checked(
      await api(`/git/commits/${revision}`),
      "GitHub mirror lookup",
      [404],
    );
    if (commit.status !== 404) break;
    if (attempt < 11) await sleep(10_000);
  }
  if (commit.status === 404)
    throw new Error(
      "GitHub mirror has not received the commit; retry after synchronization",
    );
  if ((await commit.json()).sha !== revision)
    throw new Error("GitHub returned an unexpected commit");

  async function checkTag(allowMissing = false) {
    const response = await checked(
      await api(`/git/ref/tags/${tag}`),
      "GitHub tag lookup",
      allowMissing ? [404] : [],
    );
    if (response.status === 404) return false;
    const ref = await response.json();
    if (ref.object?.type !== "commit" || ref.object.sha !== revision)
      throw new Error(
        "GitHub tag does not point directly to the expected commit",
      );
    return true;
  }

  await checkTag(true);
  let releaseResponse = await checked(
    await api(`/releases/tags/${tag}`),
    "GitHub release lookup",
    [404],
  );
  if (releaseResponse.status === 404) {
    // The release API creates the tag if absent. If it already exists, it was checked above.
    releaseResponse = await checked(
      await api("/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: revision,
          name: tag,
          prerelease: true,
          make_latest: "false",
        }),
      }),
      "GitHub release creation",
    );
  }
  const release = await releaseResponse.json();
  if (
    release.tag_name !== tag ||
    release.draft ||
    !Number.isSafeInteger(release.id)
  )
    throw new Error("Unexpected GitHub release metadata");
  await checkTag();
  let asset;
  for (let page = 1; ; page++) {
    const response = await checked(
      await api(`/releases/${release.id}/assets?per_page=100&page=${page}`),
      "GitHub asset lookup",
    );
    const assets = await response.json();
    if (!Array.isArray(assets))
      throw new Error("Unexpected GitHub assets response");
    const matches = assets.filter((item) => item.name === name);
    if (matches.length > 1 || (asset && matches.length))
      throw new Error("Duplicate GitHub assets; inspect manually");
    if (matches.length) asset = matches[0];
    if (assets.length < 100) break;
  }
  if (asset) {
    if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.id))
      throw new Error("GitHub asset upload is incomplete; inspect manually");
    const response = await checked(
      await api(`/releases/assets/${asset.id}`, {
        headers: { Accept: "application/octet-stream" },
      }),
      "GitHub asset download",
    );
    await compare(response, artifact, "GitHub");
  } else {
    const uploadUrl = `https://uploads.github.com/repos/LamplitIsles/lamplit-app/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    await checked(
      await request(fetcher, uploadUrl, token, {
        method: "POST",
        body: artifact,
        headers: {
          "Content-Type": "application/gzip",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
      "GitHub asset upload",
    );
  }
  // Verify both the bytes and anonymous availability, including on retries.
  const url = `https://github.com/LamplitIsles/lamplit-app/releases/download/${tag}/${name}`;
  const response = await checked(
    await fetcher(url, { signal: AbortSignal.timeout(120_000) }),
    "GitHub public verification",
  );
  await compare(response, artifact, "GitHub public asset");
  await checkTag();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const revision = process.argv[2];
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("Expected a full lowercase commit SHA");
  const artifact = await readFile(process.argv[3]);
  const results = await Promise.allSettled([
    publishForgejo(revision, artifact, process.env.FORGEJO_PACKAGES_TOKEN),
    publishGithub(revision, artifact, process.env.GITHUB_RELEASE_TOKEN),
  ]);
  for (const [index, result] of results.entries()) {
    const destination = ["Forgejo", "GitHub"][index];
    if (result.status === "fulfilled") console.log(`${destination}: verified`);
    else
      console.error(
        `${destination}: ${result.reason instanceof Error ? result.reason.message : "failed; inspect before retry"}`,
      );
  }
  if (results.some((result) => result.status === "rejected"))
    process.exitCode = 1;
}
