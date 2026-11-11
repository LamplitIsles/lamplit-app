> Current delivery semantics are defined by spec #5706 and the
> [native delivery contract](native-durable-submissions.md). Earlier archive
> identities and failed-message candidates below are historical evidence;
> they do not establish acceptance of this contract.

# Default shared frontend and complete acceptance

Spec #3162 made the then-current CFL Framework7/Svelte app the default frontend;
spec #108 subsequently replaced Framework7 with Svelte and Konsta.
Standalone entry is `/`; hosted entry is `/chat`. Both serve the same App HTML
and root-relative `/assets/*` and `/icons/*` bytes. There is no `/slice` alias,
legacy frontend fallback, migration or separate App Worker. Native/domain and
management consumers remain in their owning repositories. Platform owns hosted
manifest, service worker, authentication and management independently; App's
standalone manifest has `/` identity, start URL and scope. App does not register
a service worker. No Composer redesign or Penpot board applies.

## Checks, in order

Use Bun 1.3.14, installed Chrome and test-owned state. Runners that support
`APP_ACCEPTANCE_BROWSER` may select a test-owned Playwright Chromium executable;
the composer touch fixture uses the installed Chrome channel. From the App checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run format:check
bun run test
bun run build
bun run test:browser
bun run test:panels-browser
bun run test:images-browser
bun tests/optimistic-send-browser.mjs
bun run test:compact-browser
bun run test:search-browser
bun run test:route-lifecycle-browser
bun tests/notifications-browser.mjs
```

`test:browser` runs the text runner followed by the local composer touch fixture.
The commands above also run panels, images, compact, search, notifications, route
lifecycle and submission timing. The composer touch fixture uses a
loopback test-owned host and checks that tap and hold do not request microphone
access. It has no external-host mode and does not validate native iPhone behavior.
Notifications use a recording native API fake. The route lifecycle regression uses
real intercepted requests and waits for held handlers to settle; genuine route
errors fail the process. Fixture hosts use canonical root paths and reject missing
assets and `/slice`, without SPA fallback. Text also boots `/chat` and checks
standalone PWA assets; this does not establish actual platform gateway acceptance.
The image runner's earlier recovery assertions are historical and must not be
treated as acceptance of #5706. Screenshots cover 390/1280; image/compact retain
320px overflow probes.

## One committed-source candidate

Commit verified source, then run `bun run prepare:default` from a clean checkout.
It builds once into ignored `.scratch/native-durable-submissions/candidate`, refusing
an existing identity. Historical artifacts are never overwritten. The single
`lamplit-native-durable-submissions.tgz` contains `browser/`, `contracts/package/`,
`acceptance/`, three per-file SHA256 manifests and `SOURCE_HEAD`. The acceptance
package includes the feature runners, local composer touch regression, route regression, their fixtures/helpers
(including `notification-permission.mjs` and the shared local/native
`optimistic-send-browser.mjs`), the notification acceptance guide,
licenses, source attribution and native-control docs. Its package pins Playwright;
compiled contracts retain their declared Chord, marked, and TypeBox dependencies.
`identity.json` records exact committed source HEAD, fixed baseline, archive hash
and manifest hashes. This is a candidate, not Owner approval. Both native workers
remain blocked until Owner reviews and approves these exact complete bytes.

Extract only into a new test-owned directory. Substitute the received archive
path; compare all four `shasum` results with `identity.json` before extraction:

```sh
shasum -a 256 lamplit-native-durable-submissions.tgz browser.sha256 contracts.sha256 acceptance.sha256
ACCEPTANCE_ROOT=$(mktemp -d /tmp/lamplit-default-acceptance.XXXXXX)
tar -xzf lamplit-native-durable-submissions.tgz -C "$ACCEPTANCE_ROOT"
(cd "$ACCEPTANCE_ROOT/browser" && shasum -a 256 -c ../browser.sha256)
(cd "$ACCEPTANCE_ROOT/contracts/package" && shasum -a 256 -c ../../contracts.sha256)
(cd "$ACCEPTANCE_ROOT/acceptance" && shasum -a 256 -c ../acceptance.sha256)
(cd "$ACCEPTANCE_ROOT/contracts/package" && bun install)
(cd "$ACCEPTANCE_ROOT/acceptance" && bun install)
```

These installs add dependencies inside the extraction, without building or changing
frozen source. For extracted App fixture acceptance, from `acceptance/` set
`APP_ACCEPTANCE_ASSETS=../browser` and run each of `bun browser.mjs`,
`bun voice-browser.mjs`, `bun panels-browser.mjs`, `bun images-browser.mjs`,
`bun compact-browser.mjs`, `bun search-browser.mjs`,
`bun notifications-browser.mjs`, then `bun route-lifecycle-browser.mjs` and `bun optimistic-send-browser.mjs` using
its submission controls described below. `voice-browser.mjs` is a
compatibility entry for the local composer touch regression; the packaged runner
uses `APP_ACCEPTANCE_ASSETS` (default `../browser`) and rejects external host/control
URLs. It requires installed Chrome and does not claim external voice acceptance.
The current submission runner supports a local socket fixture and external test-owned
hosts through the controls described below. It checks optimistic text display,
unknown-state reload without replay, explicit retry and local deletion at 390/1280;
it does not itself establish native acceptance. Set
`APP_ACCEPTANCE_EVIDENCE` to a separate
absolute test-owned directory for each feature. Repeat all three per-file checks
and archive/manifest hash checks after every native run; never rebuild or edit
approved files. Record native HEAD, fixture/fake-engine identity, command, exit
code, screenshots and before/after hashes. Owner approval of a changed candidate
is required before either backend consumes a replacement.

## Actual-host text controls

Every public request must reach the actual authenticated native adapter. Controls
are separate test infrastructure: reset/seed only test-owned native state, configure
fake model behavior, observe transport, or delay/fail delivery. Do not return
fabricated public DTOs, intercept browser public routes, substitute a mock backend,
change native auth/admission, or invoke installed real model/app-server executables.
Use the existing Pi/workerd and CFL/Node fixture patterns with fake loopback
model/official app-server services. Controls may run on a separate port.
Missing fixture support is a blocker to report to Owner, not an assertion to relax.

The text control accepts JSON POST and returns state after the action. It uses
`/__test/text` by default:

| Action              | Native fixture operation                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `reset`             | Clear only fixture session/history/receipts, reset fake execution count, select idle session. Return its actual public `sessionId`.        |
| `state`             | Observe `{ sessionId, executions }`; executions counts native starts, not RPCs or steering inputs.                                         |
| `complete`, `text?` | Release the current held fake native turn with that exact completed assistant text (default `完整回复`) and its native completion outcome. |

Keep fake turns held until `complete` or actual native stop. Text verifies completed
reply after offline/reconnect, refresh, stop before reply, explicit missing-operation
restoration under the actual session's localStorage key with no automatic/duplicate
execution, safe external links, keyboard/mouse menus, theme and language.
The external-link page is a separate test-owned loopback HTTP origin; no browser
route fulfillment or product API mock is used.

Voice input is no longer an App acceptance path. The composer touch runner uses
only a test-owned local host; it cannot validate a native host.

From the extracted `acceptance/` directory, after approved native fixtures start:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/text \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/text bun browser.mjs
```

Use `/chat` for hosted gateway acceptance. Optional `APP_ACCEPTANCE_USERNAME` and
`APP_ACCEPTANCE_PASSWORD` are synthetic fixture HTTP credentials only. Configure
synthetic host login/cookies through its native fixture; never use real credentials.
Retain native revoked-auth, owner/session/media/same-origin checks in backend tests.

## Remaining runners and deployment boundary

The [notification runner and physical checklist](desktop-companion-notifications.md)
verify browser API wiring in an isolated ChatHost fixture using packaged assets
and contracts. `APP_ACCEPTANCE_ASSETS` selects the extracted `browser/` bytes;
`APP_ACCEPTANCE_BROWSER` selects the test-owned executable. This runner has no
external/native-host mode. Its fake permission/delivery results do not establish
physical Safari/macOS notification display; the manual device checklist remains
separate and explicitly unverified until performed.

Panels require the native seed facts and media bytes in
[panels](companion-panels.md); external mode retains its existing native
failure/stale/scheduler test boundary. CFL uses `APP_ACCEPTANCE_INTERVAL_SECONDS=300`
for its native five-minute minimum; Pi/local fixture defaults to 90. Images,
compact and search use their existing unchanged control protocols in
[images](image-send-recovery.md), [compact](quiet-compaction.md) and
[search](conversation-search.md). Pass each feature's control URL and evidence
directory, with the same `APP_ACCEPTANCE_URL`, to its corresponding runner.

Prior specs #3062/#3096/#3119/#3142 have completed joint isolated native acceptance
and merged, according to their full FlickNote completion records. Their historical
artifacts remain evidence. The new canonical-root candidate still needs Owner
approval and exact-artifact Pi/CFL runs under #3163/#3164, plus hosted gateway/PWA
acceptance under #3165. Fixture passes are not those native/platform passes.
Physical-device keyboard/safe-area/install/service-worker behavior and real-provider
use remain later joint live checks. Workers do not deploy, merge, release, change
live services/configuration, restart services or develop on the NUC.

See the repository's [integration guide](integration.md) for adjacent
checkout production build/host commands. Owner runs each backend/platform's final
documented deploy procedure after reviewed joint acceptance; merging does not deploy.

For Matrix #3560 use the [complete Matrix handoff](matrix-source-ui.md) and
`bun tests/prepare-default.mjs --matrix-source-ui`. It preserves all default
runners and adds Matrix plus current collapsed-thinking acceptance, frozen locks
and a new candidate directory. Existing identities are never overwritten.

## Historical fast voice start candidate (#3734)

Previous candidates and their hashes remain historical evidence of the removed
recorder. The `--fast-voice-start` preparation mode remains available because
other acceptance modes share its packaging path, but a new candidate contains
the local composer touch regression, not the former PCM or native voice runner.
`voiceRunnerSHA256` identifies its compatibility entry; the acceptance manifest
also covers the composer runner and helpers. No current runner makes a native
voice-input acceptance claim.

## Message delivery runner (#5706)

`bun tests/optimistic-send-browser.mjs` defaults to a loopback socket host and the
test-owned `submissionsFixture`. `APP_ACCEPTANCE_ASSETS` selects the local browser
assets; `APP_ACCEPTANCE_BROWSER` selects the browser executable. To run against an
external test-owned host, set both `APP_ACCEPTANCE_URL` and
`APP_ACCEPTANCE_CONTROL_URL`; the external host serves its own assets, so
`APP_ACCEPTANCE_ASSETS` applies only to the local fixture. Optional
`APP_ACCEPTANCE_USERNAME` and `APP_ACCEPTANCE_PASSWORD` are for synthetic fixture
credentials. `APP_ACCEPTANCE_EVIDENCE` optionally names an existing test-owned
directory for screenshots.

The runner posts JSON controls: `reset`; `mode` with `slow`, `null`, `failed` or
`submitted` (and `hidden` where used); `release`; `publish`; `complete`; and
`state`. State must expose `submitCalls` and `submissions` for its assertions.
The local fixture also exposes `lookupCalls`; the runner does not require the old
finalization, retry or deletion counters. Native test controls must operate on
test-owned state and must not fabricate public receipts or bypass authorization.

The browser checks one immediate outgoing bubble with no sending label, an
unconfirmed input surviving reload without another submit, explicit retry of a
definite failure while preserving the current draft, and local deletion remaining
absent after reload. It runs at 390 and 1280 pixels. The separate
`tests/native-confirmed-delivery.test.ts` exercises the App socket contract with an
isolated fake, including queued stop and source identity. Neither fixture result
proves CFL or Pi native acceptance; each requires its own real native boundary and
an attributable matching App artifact. The former #3936 failed-message candidate
and its finalization/retry/delete controls are historical, superseded by #5706.
