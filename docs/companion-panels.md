# Companion panels contract and acceptance

Spec #3062 is implemented by this app. `@lamplit/contracts` is the public schema
and TypeScript authority for both engine adapters. Import its compiled root and
`/server` or `/client` exports; never import private web-app files.

## Reads on the existing connection

`ChatBackend` implements the six panel methods below, and `createChatHost` exposes
them on `lamplit.chat.v1`, through the existing authenticated `/api/chat/socket`.
All methods take exactly one object argument. `sessionId` must equal the host's
selected session; it is a stale-request check, never authorization to select a
session. The host authorizes every call and delivery. Panel failures return a
recoverable call error without closing chat. There is no legacy CFL JSON fallback.

| Method                | Input besides sessionId  | Response                                                              |
| --------------------- | ------------------------ | --------------------------------------------------------------------- |
| `relationship`        | none                     | `scope`, `current` mood/note/affinity/signature                       |
| `relationshipHistory` | `cursor: string \| null` | `scope`, newest-first `records` (max 20), `nextCursor`, `predecessor` |
| `diaryList`           | `cursor: string \| null` | newest-first `entries` (max 30), `nextCursor`                         |
| `diaryRead`           | `name: YYYY-MM-DD.md`    | `status: found` with name/text, or `missing`/`too-large` with name    |
| `album`               | `cursor: string \| null` | `images` (max 30), `nextCursor`                                       |
| `reminders`           | none                     | pending `reminders` (max 100; smaller native limits remain)           |

First-page cursors and end-of-list cursors are `null`. Every cursor is an opaque,
nonempty bounded string. Adapters must bind it to the method and selected session;
reject a cursor from another session or method. Relationship `scope` preserves the
engine's existing scope. The predecessor is the complete record immediately older
than the last visible record, including on pages with a next cursor, so the oldest
visible change has an accurate signed affinity delta. It is `null` when absent.
History records retain the imported state/change model, limits and mood enum.

Diary adapters list/read only date-named Markdown files under native `memory`.
They must confine paths there, exclude other workspace files and enforce the
128 KiB UTF-8 byte limit before returning `found`; `validatePanelResult` checks
bytes again at host and client boundaries. The schemas limit page sizes and names,
not filesystem access. List entries are deduplicated when appending.

Albums list registered session images only, sorted descending by `createdAt` and
then ID with a stable adapter-defined binary ordering. IDs are opaque strings.
Each metadata record contains `id`, `filename`, UTC epoch-ms `createdAt`, normalized
`origin` (`human`, `agent`, `historical`, `unknown`), `available`, `previewUrl` and
`originalUrl`. Unavailable records remain visible; URLs may be null. Available
records require both URLs. URLs are relative `/api/...` paths, never filesystem
paths or foreign origins. Serve original and preview image bytes using the host's
existing authenticated same-origin HTTP boundary; authorize each request and
avoid redirects to foreign origins. Do not send bytes through WebSocket or add
new storage. The app validates paths, deduplicates IDs, groups by the viewer's
local day/week and opens/saves the original. Browser save fetches authenticated
bytes; native save retains the existing Capacitor Media album flow. Browsing is
independent of the chat snapshot's `images: false` sending capability.

Reminders preserve `id`, optional `title`, `message`, UTC epoch-ms `nextAt`, and
native structured `schedule`: `once {at}` (epoch ms), `interval {everySeconds,
anchor?}` (seconds and optional signed epoch-ms anchor within the valid
JavaScript date range, including dates before 1970), `daily {hour, minute, timeZone}`,
or `weekly {hour, minute, timeZone, weekday}`. Time zones are IANA identifiers;
weekday 0 is Sunday. The app reads only; Agent tools still manage reminders.
Adapters keep native scheduling and admission receipts. Lateness strictly greater
than 60 seconds skips execution: once ends, repeating schedules advance to the
next future occurrence. At or below 60 seconds, use the existing due flow. Edits
and deletion do not rewrite immutable admitted occurrences. No replay queue or
restart compensation is added here.

A persisted chat message may carry `source: {kind: "reminder", reminderId,
occurrenceId?}`. Preserve it in live snapshots and history. The app renders that
message incoming with an **App reminder** badge, even when native storage uses a
user-role input. It must never look like human input. Reading panels creates no
chat turn.

Only the four connected panels are exposed. Search, attachment sending and TTS
remain hidden. Opening, manual refresh, completed chat turns and reconnect refresh
the visible panel and relationship summary; there is no polling or whole-library
replication. Connection/session/request generations prevent late responses from
replacing a newer panel. Relationship loading/failure never gates chat or voice.

## Local checks and frozen handoff

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run format:check
bun run test
bun run build
bun run test:browser
bun run test:panels-browser
# Commit reviewed source first; freezing requires a clean checkout.
bun run freeze:panels
```

The last command writes ignored `.scratch/companion-panels/artifacts/`:
`lamplit-web-panels.tgz`, `browser.sha256`, `lamplit-contracts-panels.tgz`,
`contracts.sha256`, and `identity.json`. The identity records source HEAD, fixed
baseline, archive and per-file manifest SHA256 values and the local acceptance
boundary. Commit hashes describe source; archive/manifest hashes identify the
exact bytes accepted by both backends. Preserve this handoff; rebuilding creates
a new artifact identity and requires a new same-artifact acceptance run.

The browser suite uses the production build, test-owned fixture host, ephemeral
port and isolated Chrome contexts at 390 and 1280. Screenshots are in
`.scratch/companion-panels/browser/`. It checks history predecessors/paging,
diary paging/Markdown/missing/too-large, album day/week/unavailable/paging/original
save bytes, reminder schedules/source, empty/error/retry and late detail results.
The text and voice suites additionally check completed IM messages and streaming
voice draft insertion, cancellation/failure and disabled availability.

## Actual-backend commands and fixture requirements

Actual Pi/workerd and CFL/Node acceptance is **pending**. Owner dispatches their
separate specs #3063/#3064 after app inspection; both must use the same frozen
browser archive/manifest and compiled contracts. No repository merges before the
Owner/user joint gate. Local fixture acceptance does not claim native scheduler,
filesystem, authentication or engine acceptance.

Create a test-owned directory and extract the handoff (commands run in app):

```sh
HANDOFF="$PWD/.scratch/companion-panels/artifacts"
ACCEPTANCE_ROOT=$(mktemp -d /tmp/lamplit-panels-acceptance.XXXXXX)
mkdir "$ACCEPTANCE_ROOT/web" "$ACCEPTANCE_ROOT/contracts"
tar -xzf "$HANDOFF/lamplit-web-panels.tgz" -C "$ACCEPTANCE_ROOT/web"
tar -xzf "$HANDOFF/lamplit-contracts-panels.tgz" -C "$ACCEPTANCE_ROOT/contracts"
(cd "$ACCEPTANCE_ROOT/web" && shasum -a 256 -c "$HANDOFF/browser.sha256")
(cd "$ACCEPTANCE_ROOT/contracts/package" && shasum -a 256 -c "$HANDOFF/contracts.sha256")
```

In Pi, install the compiled package with its npm toolchain:
`npm install "$ACCEPTANCE_ROOT/contracts/package"`. In CFL, use
`pnpm --filter @lamplitisles/partner add "@lamplit/contracts@file:$ACCEPTANCE_ROOT/contracts/package"`.
Backend workers own their lockfile updates and deterministic adapter fixes.
Run Pi `npm run typecheck`, `npm run lint`, `npm test`; run CFL
`pnpm --filter @lamplitisles/partner check` and
`pnpm --filter @lamplitisles/partner test` in their respective repositories.

For a real local Pi host, the backend worker prepares a **test-owned** Wrangler
config derived from `wrangler.slice.jsonc`, with `assets.directory` set to the
extracted `$ACCEPTANCE_ROOT/web`, fake model/ASR loopback endpoints, synthetic
fixture authentication, and local bindings. Run:

```sh
npx wrangler dev --config "$ACCEPTANCE_ROOT/pi-fixture.jsonc" \
  --local --persist-to "$ACCEPTANCE_ROOT/pi-state" --port 8951
```

For CFL the backend worker prepares a **test-owned** TOML config, native workspace
and fake official app-server/ASR, with all data and Codex home paths under
`$ACCEPTANCE_ROOT`. Run:

```sh
LAMPLIT_APP_ASSETS="$ACCEPTANCE_ROOT/web" \
  pnpm --filter @lamplitisles/partner start -- "$ACCEPTANCE_ROOT/cfl-fixture.toml"
```

These are integration command templates with explicit fixture-config prerequisites,
not ready-made configurations for backends that have yet to implement the panels.
Never use live TOML, `.dev.vars`, storage, Codex home or model credentials. Workers
record their actual fake-service launch/seeding commands and reviewed HEADs.

`tests/panels-fixture.ts` exports `panelsFixture()` with 25 relationship records,
35 date names/images, all four schedules, and `fixtureImage` original PNG bytes.
Backend workers seed their native stores from these values (fixture image URLs are
examples; each adapter supplies its own authenticated paths). Use the same state,
reasons, dates, filenames, unavailable second image, missing second diary entry,
too-large third diary entry, pending reminders, and a persisted reminder-source
message. For filesystem admission also seed a non-date Markdown file, a multibyte
128 KiB entry and one byte over it; native tests must prove confinement, sorting,
cursor scope and the >60s/<=60s scheduler rule with test clocks. Fake model replies
must contain `fixture reply`, and fake ASR returns `recognized final`. Alternative
reply/transcript values can be supplied through the environment below.

With those real hosts running, execute from app:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8951/slice/ \
APP_ACCEPTANCE_USERNAME=owner APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
APP_ACCEPTANCE_EVIDENCE=.scratch/companion-panels/pi-browser \
  bun run test:panels-browser
APP_ACCEPTANCE_URL=http://127.0.0.1:8952/slice/ \
APP_ACCEPTANCE_INTERVAL_SECONDS=300 \
APP_ACCEPTANCE_EVIDENCE=.scratch/companion-panels/cfl-browser \
  bun run test:panels-browser
```

`APP_ACCEPTANCE_INTERVAL_SECONDS` must be a positive safe integer and defaults
to 90 for the local fixture and Pi. CFL seeds its native minimum five-minute
interval (`everyMinutes=5`), exposes `everySeconds=300` and retains its native
`createdAt` anchor; use 300 as shown above without changing the scheduler.
The runner HEAD may advance independently; the accepted browser/contracts
artifact HEAD and hashes remain those recorded in the handoff report.

Set `APP_ACCEPTANCE_REPLY` (regular expression) and `APP_ACCEPTANCE_TRANSCRIPT`
(exact string) if the fake providers use different fixed text. External mode tests
the actual host's public RPC, metadata/image bytes, application source, completed
reply and real browser microphone-to-draft path; it skips local fixture failure
injection. Backend native tests must cover their own error/empty/retry, stale
session, revoked auth, persistence and scheduling behavior. Recheck the expanded
web manifests after each host run and record their hashes, reviewed backend HEADs,
commands and screenshots for Owner's joint gate. Do not merge or deploy here.
