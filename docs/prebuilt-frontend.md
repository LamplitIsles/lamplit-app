# Prebuilt frontend

Woodpecker checks pull requests and builds once on each push to `main`, then publishes the same
archives to Forgejo and the public GitHub mirror on main pushes. This workflow does not deploy
CFL or Shio. Publication is not established until the repository is activated,
secrets configured, and a real pipeline and both downloads are verified.

For the full lowercase App commit `SHA`, the archive is
`lamplit-app-SHA.tar.gz`:

- GitHub: `https://github.com/LamplitIsles/lamplit-app/releases/download/app-SHA/lamplit-app-SHA.tar.gz`
- Forgejo: `https://forgejo.n5.guion.io/api/packages/LamplitIsles/generic/lamplit-app/SHA/lamplit-app-SHA.tar.gz`

GitHub downloads are anonymous when the mirror and release are public. The
archive root has `browser/`, `contracts/dist/`, `licenses/`, and `manifest.json`.
It is gzip-compressed POSIX ustar, with only relative regular-file and directory
entries. File names are sorted; uid, gid and modification times are zero, modes
are normalized, and gzip omits the original name and timestamp. Overlong ustar
paths fail packaging instead of requiring GNU or PAX extension records.
The manifest's `revision` is the full SHA; `browser`, `contracts`, and
`licenses` map paths relative to each directory to lowercase SHA-256 hashes.
The browser contains `index.html`; contracts include the original compiled
`dist/cfl-browser-host-auth.js` and all other compiled files. Consumers should
verify every hash, revision and the auth marker, then compare the complete
compiled contracts hash map with their own compatible runtime before serving
`browser/`. The archive is separate from the CFL npm package.

The same build also produces the independent npm-compatible
`lamplit-contracts-SHA.tar.gz`, published alongside the frontend archive:

- GitHub: `https://github.com/LamplitIsles/lamplit-app/releases/download/app-SHA/lamplit-contracts-SHA.tar.gz`
- Forgejo: `https://forgejo.n5.guion.io/api/packages/LamplitIsles/generic/lamplit-app/SHA/lamplit-contracts-SHA.tar.gz`

It uses the same deterministic ustar/gzip settings and contains `package/` with
`package.json`, `LICENSE`, `dist/`, `lamplit-source.json`, and the maintained
Chord 1.0.0 MIT notice at `licenses/chord-1.0.0-MIT.txt`. The package
metadata retains the upstream exports and exact dependency versions. The source
file's `revision` is the full App commit, not a content digest. Every file in
`package/dist/` is copied from the frontend staging directory and is identical
to the corresponding `contracts/dist/` file; the frontend manifest is unchanged.
The package's dependencies are installed separately by the consumer and retain
their own licenses. The App package is Apache-2.0.

The build entry prints SHA-256 of each **complete compressed archive**. Record
the contract archive's digest from a trusted build log or other independently
verified channel alongside the full App commit in the consumer's source
configuration. Verify the downloaded bytes against that independently recorded
digest before extraction or installation; a digest or revision delivered only
inside the downloaded archive is not an independent trust anchor. For example,
with a trusted `CONTRACT_SHA256` and `SHA`:

```sh
printf '%s  %s\n' "$CONTRACT_SHA256" "lamplit-contracts-$SHA.tar.gz" | sha256sum -c -
npm install "./lamplit-contracts-$SHA.tar.gz"
```

A lockfile should also pin the package and its dependencies for frozen installs.
A matching compiled-contract hash proves byte equality, not application behavior.
The license directory includes App attribution and the license and notice files
found in the installed Bun package store, organized by dependency and version.
Only package identities in the current Bun lockfile are collected from the store,
so notices from stale local installations do not enter the archive. The pinned
Chord package omits its license file, so its [upstream notice](https://github.com/earendil-works/pi/blob/v1.0.0/LICENSE)
is maintained in `docs/licenses/` and copied into the archive.
The Konsta 5.5.0 package omits its MIT license file; its
[upstream notice](https://github.com/konstaui/konsta/blob/v5.5.0/LICENSE) is
maintained in `docs/licenses/` and included in the frontend archive.
The PhotoSwipe 5.4.4 and TanStack Virtual MIT notices are also maintained in
`docs/licenses/` and included, independently of the package-store notices.
The `sv-router` 0.19.0 MIT notice is collected from its installed package at
`licenses/dependencies/sv-router/0.19.0/LICENSE`.

The pipeline needs Woodpecker enabled for this repository and two secrets:
`forgejo_packages_token` with access to write and read the LamplitIsles generic
package, and `github_release_token` with GitHub repository contents write
permission. Both secrets can be configured at the LamplitIsles organization
scope with their event access restricted to Push. Organization-scoped secrets
are also available to other organization pipelines whose events meet that
restriction; use repository-scoped secrets to limit access to this repository.
This repository's workflow references the secrets only in its main-push publish
step; they are not embedded in artifacts or download URLs. Pushes that occurred
before the repository was enabled in Woodpecker are not replayed; a subsequent
push to `main` starts the workflow. The GitHub mirror must be public and receive
the App commit before release creation. Token presence, permissions, activation
and mirroring are not verified by this repository. The build step uses Dagger
0.21.7 and the existing runner relay, whose availability and
access have not been verified for this repository. Its linux/amd64 Bun 1.3.14
build mounts the `lamplit-app-bun-1.3.14-linux-amd64-v1` cache at `/bun-cache`,
with `BUN_INSTALL_CACHE_DIR=/bun-cache` and locked sharing. Dagger scopes this
cache to the App module; CFL uses a separate module cache even if its key is the
same. The local and CI entry invokes the App module from `dagger/` under the Git
root, so both are expected to resolve the same local module identity. Reuse also
requires the same Engine and has not been verified.
The cache holds downloads; the build graph still uses the App lockfile and
`bun install --frozen-lockfile`. The message-format plugin is pinned in the
lockfile and loaded from the web workspace's installed `node_modules`, so
Paraglide compilation and Vite builds do not fetch it from a CDN. Tools opening
the Inlang project must have the App dependencies installed locally.
Dagger may reuse a previously evaluated graph for identical inputs. Engine
persistence, available disk, cold and warm cache behavior, and resource use
are not verified. Production publication credentials never enter Dagger.

For the same build locally, use a clean checkout, Git, Node, tar/gzip, Dagger CLI 0.21.7 and an
authorized connection to the existing compatible Engine:

```sh
_EXPERIMENTAL_DAGGER_RUNNER_HOST="$YOUR_APPROVED_DAGGER_ADDRESS" sh scripts/build-frontend-dagger.sh
```

Use this entry for both local and CI builds. It verifies Git HEAD, the clean working tree and, in CI, that
HEAD equals `CI_COMMIT_SHA`. It rejects unexpected ignored files in projected
source directories; the Dagger input excludes Git metadata, dependencies,
generated output and local state. It runs a frozen install, App `check`, App
`test` (including the Dagger entry test), normal build and packaging, then
exports both archives named for that revision. The check generates Paraglide
messages before type checking. It checks both exported source revisions and the source again before
success and refuses to overwrite either existing archive. The container uses
the pinned Node 24 image for Node and npm alongside pinned Bun. This does not share the host's `node_modules`
or `~/.bun` with the Engine. The exported archives are untracked; move both out of the checkout before
running the entry again.

Each destination is attempted independently and the pipeline fails if either
fails. Before uploading, the publisher checks each existing asset against its
new archive; matching bytes are accepted and different bytes cause failure.
The GitHub commit is polled for a bounded period and the release tag must point
directly to that commit. Upload responses and subsequent downloads are checked;
network failures and incomplete uploads are failures, not proof of absence.
Inspect the destination and pipeline error before retrying. A retry compares
existing bytes and will not overwrite conflicts; a rebuild that produces
different bytes for the same commit must be investigated rather than replaced.
An incomplete GitHub upload may require an authorized maintainer to inspect and
remove the failed asset before retrying. The release is a prerelease and does
not move GitHub's latest release. No `latest` artifact alias is maintained.
