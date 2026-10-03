# Conversation archive search

Design decisions reviewed on 2026-10-03; shared App implementation for spec #3142.
Native adapters and joint acceptance remain pending Owner approval of the candidate.

## Product behavior

Search the companion's current and past conversations, preserved pre-compaction
originals, existing supported imported records and other branches. CFL retains
FlickLog's existing `sessions` scope; Codex `archived_sessions` is excluded.

Search actual user/assistant text and native compaction summaries. Voice dictation
is searchable as submitted text. Label summary records in the search reader;
successful compaction still produces no marker or toast in the main timeline.
Exclude reasoning and tool output, including those parts of imported records.

Preserve CFL's Framework7 interaction: submit a query, select a hit, and read the
record with nearby context in the existing separate reader. This never switches
or resumes a conversation, changes the current branch, or alters the draft.
Select records using their native IDs, not text equality.

## Reuse boundary

Pi keeps its existing FTS5 search; CFL keeps FlickLog/Meilisearch and unchanged
`search/get/context`. Retain native matching; CFL keeps its current ranking and
result limits. There is no shared search algorithm, pagination requirement or
FlickLog modification.
Pi returns record-level FTS hits directly, without grouping by session or applying
a per-session hit quota. Rank by native FTS5 relevance and limit the total records
returned. Session identity remains metadata for locating the record and reading
context, not a search grouping or quota. Include summary hits through the same
native indexing/search mechanism.

The UI preserves loading, empty, search failure, read failure and retry states.
Keep the existing bounded-results presentation. Do not invent an exact global
count when the native search cannot supply one. Ignore responses from superseded
queries or record selections, as the current reader already does.

For both engines, external rewriting/replacement of history, source identity
revalidation, content hashes, deletion reconciliation and corrupt-archive repair
are excluded. Ordinary lookup of a record by ID remains necessary for displaying
it; lookup failure uses the existing read-error and retry interaction.

## Shared protocol

Add search and selected-record/context reads to the current runtime-validated
Chord service. Keep the same frontend for both hosts. Backend adapters map native
results into the existing UI's card and reader shape; native archives and indexes
stay where they are. Search results are on-demand reads, not replicated history.

Use the authenticated host's existing companion/instance scope for both search
and record reads. A supplied session or record ID does not select another owner's
instance. Keep CFL's existing workspace/device restriction and Pi's registry
membership checks. No new token, signing scheme or authorization system is needed.

Keep query length 1–500 and at most 20 displayed hits, matching the existing CFL
reader. Reuse native context limits where available: eight eligible records per
side and 12,000 Unicode code points in CFL. Pi should supply similarly bounded context
without a new general-purpose traversal framework.

Selected text remains complete when it fits the existing transport. Enforce the
existing 2 MiB frame boundary before sending; an oversized read is a normal read
failure and must not break ordinary chat. Do not impose the previously proposed
128 KiB text cutoff or introduce found/missing/too-large product states. Preserve
existing context-truncation feedback and safe text/mark highlighting.

## Required implementation

### App

Replace direct CFL HTTP calls in `ConversationSearch.svelte` with the common
service reads. Preserve the existing Framework7 layout and interaction. Adapt
missing native totals without redesigning the results header. No new attachment
reader, search filters, count-detail UI or search capability service.

### CFL

Inject the existing ConversationSearch dependency into the Chord backend and
map its `search/read` outputs. Reuse the same helper used by native HTTP and MCP.
Preserve native error behavior without parsing CLI stderr or classifying new
failure types. Do not duplicate Codex JSONL parsing or change FlickLog.

### Pi

Reuse the registry FTS5 query and return its record rows directly. The current
SQL already produces record rows; `groupSearchRows` adds session grouping and a
ten-hit-per-session cap afterward. The shared search path bypasses that grouping,
applies the result limit to records, and maps each row to one card. Keep native
BM25 relevance; use record recency, rather than session update time, for recency
tie-breaking. This changes the shared frontend search path; it does not require
rewriting the separate agent-facing `session_search` tool or adding a second index.
The shared search uses FTS text matching directly and does not accidentally expose
the agent tool's `re:` dispatch as a public regex feature. Extend the native search
projection to include compaction summaries, including summaries already stored. Use a targeted projection refresh for this missing record type; no full
index lifecycle, transcript migration, second content store or general rebuild
framework. Ensure only supported chat/summary content reaches the reader.

Read the selected record and nearby context from existing session storage or
imported archive nodes. Session storage has native entries and parent IDs;
imported `history_nodes` also has parent IDs. Before-context follows ancestors;
after-context follows unique successors and stops at a fork. Do not use adjacent
insertion rows as a substitute for the original path. Do not navigate the engine
or add parent-chain integrity/corruption validation.

Use current supported storage reads; no private SDK import or new SDK export is
required by the identified interfaces. Preserve existing native timestamp facts,
including unknown time zones in imports, without adding a timestamp subsystem.

## Verification

Use existing test-owned native fixtures and one shared App search acceptance flow
against both adapters. Representative cases: Chinese/English chat and summary
hits, a pre-compaction message, a branch/import context, repeated-text distinct
record selection, bounded results, native failure/retry, and a superseded query. Include multiple matching records
in one session and another session to verify there is no per-session quota or regrouping of record ranking.
Verify reading leaves the active conversation and draft unchanged. Verify the new
cross-session read stays within the existing owner scope at the appropriate host
seam; do not duplicate the full authentication test suite.

No rewritten-log probe, corrupt-graph matrix, identical-rank comparison or new
live environment is an acceptance requirement. Run checks relevant to each diff;
use existing artifact verification when the coordinated slice is implemented.

## Outside this slice

`archived_sessions`, source-integrity validation, deletion reconciliation,
pagination, semantic/OCR search, cross-panel search, a new attachment reader,
index-provider replacement and deployment changes.

## Repository evidence

- App `ConversationSearch.svelte`: existing card/context reader, direct CFL HTTP
  reads, loading/retry/truncation and stale-request handling.
- Pi `pi-registry.ts`: existing FTS5 matching and bounded grouped results.
- Pi `pi-session-storage.ts`: native entries/parent IDs; current index outbox
  includes user/assistant text but omits compactions.
- Pi `pi-v4-storage.ts`: supported entry/branch reads.
- Pi `history-archives.ts`: original imported nodes and parent IDs; current page
  reads use insertion order.
- CFL `conversation-search.ts`: existing FlickLog search/read dependency with
  workspace checks. The local installed FlickLog resolves to the inspected
  `experiments/flicklog` checkout.
- FlickNote ADR #2768: search remains available to independent deployments.

## Grilling closure · 2026-10-03

No unresolved user-facing decision remains. The agreed slice is shared search UI
and protocol, unchanged CFL search integration, and record-level Pi FTS search
with native compaction summaries and read-only context. A hit is one record, not
one session. A record's session metadata locates its context and does not group
or limit results.

Existing agent-facing search tools are not being redesigned by this slice. Only
callers directly affected by the shared protocol/index change need adjustment.
Missing native totals use the existing results header without a new count model
or provider explanation. Native provider/configuration failure retains the
existing search-error/retry state, with no new readiness endpoint or provisioning
workflow.

App schemas and host/client wiring are implemented below. Native summary projection
refresh belongs to Pi. These details do not expand the slice into FlickLog, platform
management, deployment or archive repair.

## Public App contract

`lamplit.chat.v1.search({ query })` trims a nonblank query (max 500 characters).
It returns `{ hits, estimatedTotalHits: number | null, limited: boolean }`, with
at most 20 individual cards. Each card has `id`, `kind: message | compaction`,
`sessionId`, `snippet`, and optional `sessionName`, `role: user | assistant`,
`phase`, `createdAt` (native source time string, including unknown import zones).
IDs are opaque native record references, not text matches. There are no cwd or
source-path fields. Literal `<mark>` delimiters highlight snippets; all other
content renders as plain text. Null totals display the returned count; `limited`
preserves the existing first-20 copy.

`searchRead({ id })` returns `{ record, context }`. Record uses the card metadata
with complete `content` instead of `snippet`. Context has
`targetSourceRecordIndex`, `truncated`, and `items`: each item has
`sourceRecordIndex`, `kind`, optional `role`, `content`, optional `truncated`.
Indexes identify native source records, not model-context positions. Include only
supported messages/summaries, eight nearby records per side (up to 17 with target),
with 12,000 context Unicode code points. Selected content remains complete independently
of the context excerpt. IDs and context indexes must be unique within their lists.
Host and browser validate both directions; a wrong selected identity is rejected.

The authenticated host chooses the companion archive scope. Native adapters must
reject records outside that scope, including cross-session reads; `sessionId` in
a card is metadata and never an authorization selector. Search/read do not refresh
replicated view, execute the engine, or switch the active session. Complete
serialized method replies exceeding the existing 2 MiB UTF-8 frame boundary fail
as ordinary RPC errors, leaving the socket and text chat usable. No text-specific
128 KiB cutoff, status taxonomy or compatibility HTTP path exists.

## Deterministic acceptance fixture

Run `bun run build && bun run test:search-browser` for the test-owned local host.
The runner uses real shared WebSocket methods, without intercepting public search.
Native hosts seed equivalent supported records with their own native stores/helper;
this fixture matcher is not a required native algorithm. Ranking may differ; fixture seeding must provide the following facts:

- 23 records match both `灯塔` and `lighthouse`; 22 belong to `archive-session`,
  one to `import-session`. Return 20 cards with `limited: true`; total may be null
  or a native supplied count. At least 19 returned hits belong to the first session,
  demonstrating no per-session quota. Include the original, repeated and summary
  records among these cards, without requiring identical ranking across engines.
  Native public IDs are returned by the test helper's `recordIds` mapping below;
  the runner selects their actual card positions and never substitutes search results.
- `archive-0` and `archive-1` have identical text prefix `灯塔 lighthouse repeated`
  but distinct identity/context; their before items read `before original branch`
  and `before imported branch`. Seed the first as preserved pre-compaction text,
  the second on a branch/import path. `archive-2` is a native compaction summary
  with `灯塔 lighthouse archiveSummary3142`, the only match for `archiveSummary3142`.
- Remaining text is `灯塔 lighthouse record N` for N=3..22; append unique token
  `archiveImported3142` to record 22. That token uniquely finds the imported record. `zz-no-match-zz` has no matches.
- Append literal ` <img src=x onerror=alert(1)>` to each seeded record content
  so native snippets include it. Use source time `2026-10-02T12:00:00Z`; snippets
  mark `灯塔`. This verifies safe plain-text rendering through the real native store.
- Reads include a before item, target and summary (`nearby summary`), with
  `truncated: true`. Local fixture indexes are 3/10/17; native source indexes may
  differ and must identify their actual target. No tool/reasoning
  records enter results/context. Repeated records select by identity, never equality.
  Seed the two repeated records beyond each other's eight-record context windows,
  with their distinct before marker closest to the target. Populate real surrounding
  path records (including a long nearby summary) to exceed the native context budget
  while retaining those marker prefixes; do not fake truncation in public responses.
  Extra surrounding records must not contain either search token. Native context may
  include more filler than the local fixture; the runner checks actual marker/target
  content and absence of the opposite before marker, not identical context indexes.

The separate **test-owned** control URL accepts POST JSON: `reset`,
`failure` with `method: search | searchRead` and `enabled`, `hold` with query/ID
`key`, `release`, and `state`. Hold delays just that native method response while
new reads proceed. Release completes the held response; the runner observes its
actual WebSocket reply before asserting stale protection. Failure injects a normal
adapter read failure, removable for retry. State returns `calls` (e.g.
`search:灯塔`, `read:<native-id>`), current `sessionId`, public chat `messages`,
`archiveSessionId` for the 22-record session and `recordIds` with `original`,
`repeated`, `summary`, `imported` native public IDs. These are test-helper facts,
not additions to the public search schema.
Reset clears test controls/calls and resets a test-owned idle chat. The runner
compares session/messages before/after archive reads and sends only its final test
message; no real history, credentials, paid providers or services are used.

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8787/slice/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8787/__test/conversation-search \
APP_ACCEPTANCE_EVIDENCE=/test-owned/evidence bun tests/search-browser.mjs
```

Optional `APP_ACCEPTANCE_USERNAME`/`APP_ACCEPTANCE_PASSWORD` support isolated host
HTTP authentication. Serve the candidate browser at the base URL, with authenticated
same-origin `/api/chat/socket`. The control URL may be on a separate test helper.
No production or live-state URL may be used. `APP_ACCEPTANCE_ASSETS` selects local
fixture assets only. Local contract tests additionally cover oversize read isolation
and invalid host/browser payloads; native tests verify their archive ownership seam.

## Candidate preparation and hash verification

After all source/docs are committed and checks pass, `bun run prepare:search`
builds once into `.scratch/conversation-search/candidate/`, refusing an existing
identity. It records exact source HEAD and produces `lamplit-web-search.tgz`,
`lamplit-contracts-search.tgz`, `lamplit-acceptance-search.tgz`, per-file SHA-256
manifests and `identity.json` with archive/manifest hashes. Keep scratch untracked.
Owner reviews these candidate bytes; native adapters start only after approval.
Never rebuild/refreeze approved bytes without Owner reapproval. Local fixture
success does not claim either native acceptance or Owner approval.

Extract the archives into test-owned `browser/`, `contracts/`, `acceptance/`
directories adjacent to each other. Check archive/manifest hashes against identity
using `shasum -a 256`, then in browser and acceptance run
`shasum -a 256 -c ../browser.sha256` / `../acceptance.sha256`; in
`contracts/package` run `shasum -a 256 -c ../../contracts.sha256` (adjust manifest
locations to extraction layout). First run `bun install` inside `contracts/package`
to install its declared Chord/TypeBox dependencies. Then in acceptance run
`bun install`, followed by the external command above as `bun search-browser.mjs`.
Bun links the sibling package; its own dependencies must be installed at that real
package location. This adds dependencies in test-owned extraction directories and
does not rebuild or modify the frozen package files. Native hosts also consume that package and serve frozen browser
bytes. Evidence includes 390px/1280px prompt/loading/results/reader/failure captures
and `results.json`. Both native acceptances and joint user review gate merge;
this repository does not deploy or merge.
