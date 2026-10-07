# Keet source presentation

FlickNote #3408 (tickets #3411/#3412) restores shared incoming Keet presentation.
The app owns display contracts and rendering; native ingress, durable storage,
model prompts and tools remain owned by CFL #3409 and Pi #3410.

`ChatMessage.source` is a backend-owned union. The existing reminder variant stays
unchanged. Keet uses only `{ kind: 'keet', channel: 'dm' | 'group', senderLabel,
destination }`. Both labels are nonblank, single-line strings of at most 512
Unicode code points, matching observed native name limits. Additional properties
are rejected. `Submission` does not accept a source; a browser cannot forge one.
Native adapters preserve this source in initial views, reconnect reads and history
pages. Message ID and timestamp use the existing message fields; native message
IDs, local time, reaction/group context and duplicated body text do not belong in
this display source.

`ChatMessage.text` must be the original visible text plus any existing user-visible
image availability explanation. The backend must keep attribution prompts and
model context private; the app cannot recover original text from a prompt string.
Image references use the existing authenticated media contract. Markdown follows
the current safe renderer (raw HTML is unsupported); source labels render as text.
Keet user input is incoming with a K avatar, Keet DM/Group label, sender and
destination, muted bubble and left accent in both palettes. Ordinary web input,
agent replies, reminders, composer and notification semantics remain unchanged.
There is no old-data migration or compatibility DTO.

## Owned acceptance

Run `bun run test`, `bun run check`, `bun run build`, then
`bun run test:keet-browser`. The runner uses the built real Framework7 composer
and test-owned Chord backend. It covers 320/390/1280px in light/dark, initial DM,
live group original text/explanation and profile-specific DM images, hostile literal source strings, safe Markdown, web send and
complete reply, reminder, reload, reconnect without replay and paginated history.
Screenshots/results go to ignored `.scratch/keet-source-restoration/browser`.
App-only fixtures do not establish native ingress or durable history correctness.
Final joint acceptance remains pending the Orc and real native adapter fixtures.

## Frozen handoff

After committing a clean checkout, `bun run prepare:keet` builds and exports
`.scratch/keet-source-restoration/candidate/lamplit-keet-source-restoration.tgz`,
three per-file SHA-256 manifests and `identity.json` with source HEAD, baseline,
archive hash, manifest hashes and runner identity. It refuses to overwrite an
existing identity. The archive includes built `browser/`, `contracts/package/`,
`SOURCE_HEAD`, and the compatible `acceptance/` runner with package manifest and
Bun lockfiles for both package directories. No live state, credentials or native source is included. Orc acceptance
of this exact commit/artifact gates downstream use; native consumers must neither
rebuild the app/contracts nor regenerate the candidate.

Extract to a new test-owned directory, compare the archive hash with identity,
and verify each manifest from its respective directory with `shasum -a 256 -c`.
Run `bun install --frozen-lockfile` first in `contracts/package/`, then in
`acceptance/` (do not regenerate either lockfile). Local linked contracts resolve
Chord and TypeBox from their own directory.
From that directory the same-artifact smoke command is:

```sh
APP_ACCEPTANCE_ASSETS=../browser \
APP_ACCEPTANCE_EVIDENCE=../evidence bun keet-browser.mjs
```

For joint acceptance the native worker mounts the frozen `browser/`, uses the
frozen `contracts/package/`, and starts an isolated native adapter with fake
providers. Set `APP_ACCEPTANCE_URL` to its loopback page and
`APP_ACCEPTANCE_CONTROL_URL` to its test-owned Keet control endpoint. Set
`APP_ACCEPTANCE_EVIDENCE` to a test-owned output directory; optional
`APP_ACCEPTANCE_BROWSER` selects a test-owned Playwright Chromium executable.
The runner uses no production authentication or credentials.

The control endpoint accepts POST JSON and returns success JSON only after its
owned native mutation is persisted and the shared view publication has settled:

| Action               | Required fixture behavior                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset`              | Clear only this fixture's session/messages/submissions.                                                                                                                                                                                                                                                                                   |
| `incoming`           | Inject a native DM/group event through the real adapter with `id`, `channel`, `senderLabel`, `destination`, original `text`, `hasImage: true` for image-bearing input and optional `images` only for the DM image profile; `history: true` places it before the current page. Do not directly inject the shared DTO in native acceptance. |
| `reminder`           | Publish one native reminder with its ordinary display source.                                                                                                                                                                                                                                                                             |
| `complete`           | Complete the ordinary web submission with text `普通回复`, using a fake provider.                                                                                                                                                                                                                                                         |
| `state`              | Return `{ submissions: string[] }` containing only ordinary web submission texts in order. An image-bearing `incoming` without materialized bytes must return `{ imageNote: string }` with its actual native user-visible explanation; the runner checks that nonblank explanation appears alongside the original text.                   |
| `/disconnect` suffix | POST forcibly disconnects this fixture's sockets, without clearing durable messages; return success JSON.                                                                                                                                                                                                                                 |

Native adapter fixtures should synthesize private attribution/group context containing
`native-only context sentinel`; the runner checks that it never appears. The App
fixture carries display DTOs only and cannot establish that native separation.

The corrected runner uses initial and historical DM images only in the `dm`
profile (App/CFL default). Group current/history/reload always checks original
text plus the real native explanatory note, with no image reference or bytes.
Set `APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only` for legacy Pi: image-bearing
DM and Group events must preserve original text and their native unavailable
explanation, with no fake media storage or image DTO. Its results explicitly
claim no Keet image-byte coverage. Native fixtures translate `hasImage` into
real native image-bearing input and return the actual resulting `imageNote`;
they must not synthesize DTOs or borrow ordinary web image storage. The App-owned
fixture models this display seam only, using an explicitly test-only explanation.
`images` in the default DM profile references the owned `keet-image` PNG, which
App/CFL fixtures map to authenticated test-owned bytes through their actual
supported materializer. Hostile source strings and long destinations remain.
IDs are fixture correlation inputs; assertions
use visible content/source, not native storage IDs. Preserve ordinary input and
reminder styling, exact original text, source labels, and draft across reconnect.
Neither native fixture may invoke a model, gallery/chat state, external Keet sends,
or production services. Hosted tenant/auth guards remain intact: this PR adds no
public hosted webhook, credential/routing provisioning, platform UI or deployment.

## Runner correction handoff

The approved c7219de5bf1596af8b27de3da38e3e75d375c7b8e7a9a975d822690a1aef31c2
archive, its browser/contracts bytes, lockfiles and source identity remain frozen.
The original archived native image assertions are superseded only after Orc
accepts the separate correction. Do not run `prepare:keet` for this repair.
After committing, run `bun tests/prepare-keet-runner.mjs`. This verifies the
approved archive and manifests without building, and exports a runner-only
archive, manifest and identity referencing the final runner commit and approved
browser/contracts hashes. It reuses the approved dependency lockfiles exactly.

Extract the approved archive into a fresh owned directory, verify its manifests,
and extract the correction archive alongside it: `runner/` is separate from the
original `acceptance/`. Install frozen dependencies in `contracts/package/` then
`runner/`. From `runner/`, run both owned fixture profiles:

```sh
APP_ACCEPTANCE_ASSETS=../browser APP_ACCEPTANCE_EVIDENCE=../evidence-dm bun keet-browser.mjs
APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only APP_ACCEPTANCE_ASSETS=../browser APP_ACCEPTANCE_EVIDENCE=../evidence-text-only bun keet-browser.mjs
```

For native runs use the same corrected runner plus the actual-host/control URL
settings above and the supported image profile. Orc focused review gates native
replacement; fixture smoke does not establish native or joint acceptance.
