# Quiet native compaction

App spec #3119 owns the shared browser and contracts. Pi #3120 and CFL #3121
remain blocked until Owner review and the final frozen handoff. Local fixture
acceptance is evidence for the App; actual isolated Pi/workerd and CFL/Node
acceptance with fake native engines is a separate pending joint merge gate.

## Public native contract

`ChatView` requires `contextUsage: { tokens: number | null, capacity: number | null }`
and `compaction: null | { id: string | null, status: "running" | "complete" | "failed" }`.
Both observations belong to the enclosing authenticated `sessionId`. Counts are
finite, nonnegative and at most `Number.MAX_SAFE_INTEGER`; known capacity must be
positive. Zero is a real observation, null is missing. Tokens represent current
active context, including supported native estimation, never total billing.
The ring derives zero from missing usage, retains known capacity and adds no
unknown, question-mark or estimate copy. Existing numeric display shows `0 / 0`
when both fields are absent. Ring percentage is clamped at 100%.

`compact({ sessionId })` returns `{ sessionId, accepted: boolean }`. The common
host runtime-validates both payloads, checks current session ownership and refuses
known active turns or running compaction. The adapter must atomically recheck
native session ownership and idle admission itself; observation is not a lock.
A refused command returns `accepted: false` without starting/queuing work. A true
result acknowledges native admission only. The engine owns compact execution,
prompts, thresholds and lifecycle, including automatic compaction. Use its stable
lifecycle identity where available; otherwise `id: null`. Publish fresh immutable
observations through the existing backend subscription.

Completion immediately retires pre-compaction usage: the adapter publishes null
tokens and retains known capacity until a fresh valid post-compaction native
observation exists. This remains true across disconnect and history reload.
The browser retains validated native context usage directly: a complete snapshot
may already contain fresh post-compaction tokens when native refresh coalesces
completion and usage events. Those tokens must be visible immediately, without a
later update or reload, and on an initial snapshot while the latest lifecycle is
still complete. Do not republish a cached pre-compaction measurement.
Running and failure feedback remain visible. Complete lifecycle facts remain on
the native side and wire, but the UI renders no completion status, toast or
history marker. Native compaction records needed for continuation/search remain.

The exact bare `/compact` with no images uses this explicit service call and is
rejected by ordinary `submit`. `/compact` with images refuses and restores the
editable selection, matching CFL; commands with arguments remain ordinary text.
Busy/refused/offline commands preserve the draft. Native running state and the
in-flight command guard prevent duplicate clicks/concurrent sends. Session change
invalidates pending callbacks. Neither a lost response, timeout, reload nor
reconnect automatically executes compact again. There is no persisted compact
ledger or retry queue. Reconcile the native view; uncertain acknowledgement stays
visible until the owner can assess it. An explicit new command is a new action.

## Common browser acceptance

```sh
bun run check
bun run test
bun run build
bun run test:compact-browser
bun run test:images-browser
bun run test:browser
bun run test:panels-browser
bun tests/route-lifecycle-browser.mjs
```

Each runner uses test-owned memory, storage and a fake engine, without paid
providers, live state, credentials or external messages. The compact runner is
unchanged on either actual host and covers nullable/zero/normal capacity, command
suggestion, idle/busy/refused admission, running/failure, quiet manual/automatic
completion/history, refreshed usage, stale-session callbacks and lost-response
reconnect without replay. Existing image runner retains upload bytes, gallery,
paste, owner isolation, recovery/replacement and corrected route teardown checks.
Its presentation checks use pinned CFL's 72px native square and 44px remove target,
with a single horizontally scrolling row rather than the superseded 96px wrap.

On an **isolated test host only**, expose `POST /__test/quiet-compaction` (or supply
its URL). JSON actions below seed/control the fake native engine, not the public
production API. Both host test facades implement this exact interface unchanged:

| Action    | Fields                           | Observable effect                                                                     |
| --------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `reset`   | none                             | Clear test session/history, counters and fake native state; session `fixture-session` |
| `usage`   | `tokens`, `capacity` number/null | Publish a validated native context observation                                        |
| `busy`    | `enabled` boolean                | Set/clear a fake active native turn                                                   |
| `refuse`  | `enabled` boolean                | Native admission refuses even with idle shared view                                   |
| `hold`    | `enabled` boolean                | Delay the next accepted compact RPC result after publishing running                   |
| `release` | none                             | Resolve that held result with its original session; disable holding                   |
| `auto`    | none                             | Start fake native automatic compaction; publish running                               |
| `finish`  | `failed?` boolean                | Publish complete/failed; success nulls tokens and retains capacity                    |
| `session` | `sessionId` string               | Switch session, clear context/lifecycle/active state; preserve held old response      |
| `state`   | none                             | Read state without executing compact                                                  |

Every response has `{ sessionId, contextUsage, compaction, calls, executions,
submissions }`. `calls` counts manual adapter invocations (including native
refusal); `executions` counts native manual/automatic starts. `submissions` contains
ordinary submitted user inputs. A shared-host busy refusal does not increment
`calls`. The compact runner expects it to stay empty in compact-only scenarios.
`POST <control URL>/disconnect` closes test chat sockets and returns
`{ disconnected: true }`, keeping the fake native engine running. The host must
allow the usual authenticated browser reconnection. Test reset/release cleanup
must affect only this test instance. Tests own any SQLite/R2 directories and fakes.

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/slice/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:TEST_PORT/__test/quiet-compaction \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/compact \
bun compact-browser.mjs
```

The existing images/panels runners retain their documented control protocols and
`APP_ACCEPTANCE_*` interface. Authentication setup belongs to each isolated host;
no production accounts or paid providers are used. Missing actual-host controls
must be reported, not substituted with a weaker fixture claim.

## Candidate and Owner freeze

After committing the whole spec, `bun run prepare:compact` requires a clean
checkout, builds once, and creates ignored `.scratch/quiet-compaction/candidate`.
It records exact committed HEAD and SHA-256 archives/manifests for browser,
compiled contracts and acceptance runner package. It refuses to overwrite an
existing identity. These are candidate bytes, pending Owner review. Owner freezes
approved identical bytes for both backends; do not rebuild/refreeze independently.
If review changes code, prepare a new explicitly named candidate after preserving
the earlier review identity. Never relax runner assertions in backend forks.

After Owner handoff, verify archive hashes against `identity.json`, extract into
one test-owned directory with subdirectories `web`, `contracts`, `acceptance`:

```sh
mkdir -p web contracts acceptance
tar -xzf lamplit-web-compact.tgz -C web
tar -xzf lamplit-contracts-compact.tgz -C contracts
tar -xzf lamplit-acceptance-compact.tgz -C acceptance
(cd web && shasum -a 256 -c ../browser.sha256)
(cd contracts/package && shasum -a 256 -c ../../contracts.sha256)
(cd acceptance && shasum -a 256 -c ../acceptance.sha256)
(cd contracts/package && bun install)
(cd acceptance && bun install)
```

Point each actual host at the same extracted `web`, install the same extracted
`contracts/package` with its existing package manager, then run the unchanged
compact/images/panels runners from `acceptance` with test host URLs and separate
control/evidence destinations. Preserve the archive/manifests, exact host HEAD,
commands, fake-engine identity and runtime/browser results for Owner joint review.
For extracted fixture regression, set `APP_ACCEPTANCE_ASSETS=../web` while running
`bun browser.mjs` and `bun voice-browser.mjs` from `acceptance`; these two remain
fixture checks, not actual-host proofs.

No merge, deployment, native release or production frontend replacement is implied.
