> Current submission cutover: spec #3435 uses service/view v2. Follow
> [native durable submission handoff](native-durable-submissions.md) for the current
> candidate path, controls and immutable identity. Earlier archive identities below
> are historical evidence, not acceptance of this contract.

# Default shared frontend and complete acceptance

Spec #3162 makes the existing CFL Framework7/Svelte app the default frontend.
Standalone entry is `/`; hosted entry is `/chat`. Both serve the same App HTML
and root-relative `/assets/*` and `/icons/*` bytes. There is no `/slice` alias,
legacy frontend fallback, migration or separate App Worker. Native/domain and
management consumers remain in their owning repositories. Platform owns hosted
manifest, service worker, authentication and management independently; App's
standalone manifest has `/` identity, start URL and scope. App does not register
a service worker. No Composer redesign or Penpot board applies.

## Checks, in order

Use Bun 1.3.14, installed Chrome (or a test-owned Playwright Chromium executable
selected by `APP_ACCEPTANCE_BROWSER`) and test-owned state. From the App checkout:

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

`test:browser` runs text and voice separately: seven feature runners in total
(text, voice, panels, images, compact, search, notifications), plus the route
lifecycle regression and the shared submission timing/recovery runner. Notifications use a recording native API fake; the other
App runners inject denied permission so they never request real OS permission.
The route lifecycle regression uses real intercepted requests and waits for held
handlers to settle; genuine route errors fail the process. All fixture hosts use
canonical root paths and reject missing assets and `/slice`, without SPA fallback.
Text also boots `/chat`, compares its HTML with `/`, fetches deployed script/style,
manifest and icon URLs and checks standalone PWA scope. This models App entries;
it does not claim acceptance of the actual platform gateway. Images check actual
original/model variants, authenticated media, native limits and recovery. Voice
checks actual browser 16 kHz AudioWorklet PCM and release, not batch audio.
Screenshots cover 390/1280; image/compact also retain 320px overflow probes.

## One committed-source candidate

Commit verified source, then run `bun run prepare:default` from a clean checkout.
It builds once into ignored `.scratch/native-durable-submissions/candidate`, refusing
an existing identity. Historical artifacts are never overwritten. The single
`lamplit-native-durable-submissions.tgz` contains `browser/`, `contracts/package/`,
`acceptance/`, three per-file SHA256 manifests and `SOURCE_HEAD`. The acceptance
package includes all seven feature runners, route regression, their fixtures/helpers
(including `notification-permission.mjs` and the shared local/native
`optimistic-send-browser.mjs`), the notification acceptance guide,
licenses, source attribution and native-control docs. Its package pins Playwright;
compiled contracts retain their declared Chord/TypeBox dependencies.
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
its submission controls described in the v2 handoff.
The latter supports isolated image/WS fixtures and actual native hosts through
test-owned submission controls. It verifies receipt/view ordering, persisted App
pending state, stop outcome and 390/1280 light/dark screenshots. Configure actual-host
URLs as described in `native-durable-submissions.md`. Set
`APP_ACCEPTANCE_EVIDENCE` to a separate
absolute test-owned directory for each feature. Repeat all three per-file checks
and archive/manifest hash checks after every native run; never rebuild or edit
approved files. Record native HEAD, fixture/fake-engine identity, command, exit
code, screenshots and before/after hashes. Owner approval of a changed candidate
is required before either backend consumes a replacement.

## Actual-host text and voice controls

Every public request must reach the actual authenticated native adapter. Controls
are separate test infrastructure: reset/seed only test-owned native state, configure
fake model/speech behavior, observe transport, or delay/fail delivery. Do not return
fabricated public DTOs, intercept browser public routes, substitute a mock backend,
change native auth/admission, or invoke installed real model/app-server executables.
Use the existing Pi/workerd and CFL/Node fixture patterns with fake loopback
model/official app-server and speech services. Controls may run on a separate port.
Missing fixture support is a blocker to report to Owner, not an assertion to relax.

Both new controls accept JSON POST and return state after the action. Text uses
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

Voice uses `/__test/voice` by default:

| Action                                      | Native fixture operation                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset`                                     | Reset fixture chat, counters and speech takes; enabled speech, transcript `recognized final`, no held final result.                                                                                                                          |
| `state`                                     | Observe `{ executions, takes }` from actual authenticated native voice transport.                                                                                                                                                            |
| `speech`, `text?`, `hold?`, `availability?` | Configure fake speech final transcript/held completion. Availability `enabled`/`disabled` follows native speech configuration; `unreachable` fails capability delivery (e.g. 503) after native authentication. Do not forge capability JSON. |
| `complete`, `text?`                         | Complete the held fake native chat turn, as for text.                                                                                                                                                                                        |
| `disconnect`                                | Close this fixture's chat observation sockets, preserving native turn ownership. Normal native reconnection remains enabled.                                                                                                                 |
| `result`, `takeId`, `text`                  | Release an old held fake speech result; the native cancelled/closed take may discard it. Never inject a result directly into the browser.                                                                                                    |
| `error`, `takeId`, `code`                   | Make that fake speech upstream fail with the specified native mapped error (`upstream_error` in this suite).                                                                                                                                 |

Each observed take has `{ id, bytes, controls, closed, finishedBytes, firstFrame,
nonzero }`. `id` is a stable test observation ID; `bytes` counts PCM bytes admitted
on the actual voice transport; `controls` is ordered client `finish`/`cancel`;
`closed` reflects transport cleanup; `finishedBytes` is the byte count at finish;
`firstFrame` is the bounded first PCM frame as a byte array; `nonzero` observes
whether any admitted frame has nonzero audio. Observe at the native transport seam,
not provider chunk sizes. Fake speech must hold an otherwise valid recognized
result without changing native transcript aggregation/validation.

The runner preserves streaming-before-finish, exact 3200-byte first frame,
nonzero PCM, actual 16000 Hz, selected draft replacement, edit/explicit send,
finish ordering, cancel/stale result, fresh take, upstream failure, chat-disconnect
cleanup, oversized transcript, actual-rate mismatch, microphone denial, navigation
cleanup, disabled/unreachable capability and continued text assertions. Browser
resource probes wrap real capture/AudioContext; rate-mismatch/denial deliberately
exercise capture failures. No recording bytes are saved into product state.

From the extracted `acceptance/` directory, after approved native fixtures start:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/text \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/text bun browser.mjs
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/voice \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/voice bun voice-browser.mjs
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
