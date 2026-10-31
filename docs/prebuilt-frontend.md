# Prebuilt frontend

Woodpecker is intended to build once on each push to `main` and publish the same
archive to Forgejo and the public GitHub mirror. This workflow does not deploy
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
The license directory includes App attribution and the license and notice files
found in the installed Bun package store, organized by dependency and version.
The pinned Chord and Skeleton Elements packages omit their license files, so
their versioned upstream notices are maintained in `docs/licenses/` and copied
into the archive: [Chord 1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/LICENSE)
and [Skeleton Elements 4.0.1](https://github.com/nolimits4web/skeleton-elements/blob/v4.0.1/LICENSE).
The browser also imports `@capacitor-community/media` 9.1.0, whose package
declares MIT but contains no license or copyright notice. The archive includes
its versioned upstream metadata, canonical MIT permission text, and an explicit
statement that no upstream copyright statement was found.

The pipeline needs Woodpecker enabled for this repository and two secrets:
`forgejo_packages_token` with access to write and read the LamplitIsles generic
package, and `github_release_token` with GitHub repository contents write
permission. The GitHub mirror must be public and receive the App commit before
release creation. Token presence, permissions, activation and mirroring are not
verified by this repository. Secrets are only exposed to the main-push publish
step, not embedded in artifacts or download URLs. The build step uses Dagger
0.21.7 and the existing runner relay, whose availability and access have not
been verified for this repository. Its linux/amd64 Bun 1.3.14 build mounts the
Orc-coordinated `lamplit-app-bun-1.3.14-linux-amd64-v1` cache at `/bun-cache`,
with `BUN_INSTALL_CACHE_DIR=/bun-cache` and locked sharing. Dagger scopes this
cache to the App module; CFL uses a separate module cache even if its key is the
same. The local and CI entry invokes the App module from `dagger/` under the Git
root, so both are expected to resolve the same local module identity. Reuse also
requires the same Engine and has not been verified.
The cache holds downloads; the build graph still uses the App lockfile and
`bun install --frozen-lockfile`.
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
generated output and local state. It runs the focused artifact tests, frozen
install, normal build and packaging in order, then exports one archive named
for that revision. It checks the exported manifest revision and the source
again before success and refuses to
overwrite an existing archive. This does not share the host's `node_modules`
or `~/.bun` with the Engine. The exported archive is untracked; move it out of
the checkout before running the entry again.

Each destination is attempted independently and the pipeline fails if either
fails. Before uploading, the publisher checks any existing asset against the
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
