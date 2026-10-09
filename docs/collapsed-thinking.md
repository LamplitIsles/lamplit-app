# Collapsed thinking (#3522; Chat counterpart #3523)

The existing Framework7 companion transcript shows actual assistant thinking once
per grouped message unit, above its answer/images. The small muted native disclosure
is initially collapsed on mount, reload and newly loaded history. Its label stays
**不许你看的小想法**, and the native arrow indicates state. Enter/Space toggle it;
visible keyboard focus and a 44px summary target support keyboard and touch use.
The existing safe Markdown renderer handles content in normal page flow without
a nested scrolling region. Absent/empty thinking produces no disclosure.

The public optional `ChatMessage.thinking: string` is independent of `text`. Native
Chat projects only actual assistant thinking strings joined with newline in their
original order. It never infers thinking from answer prose, exposes private prompts,
signatures or tool arguments, changes model settings, rewrites history or changes
completed-message delivery/submission/failure/stop semantics. App ignores thinking
on non-agent entries. Empty thinking-only records still have no answer bubble;
backend empty-reply notices and tool-call-only handling stay authoritative. Copy
uses the answer's original Markdown only. Search previews/reader contracts are
unchanged and remain text-only.

## Isolated runner

Build with `bun run build`, then run `bun tests/thinking-browser.mjs`. This uses
only test-owned DTO fixtures and local assets. It checks 320/390/1280px light/dark,
collapsed/expanded/long Markdown, absent/empty/wrong-role/only thinking, failure
notices (exactly two, each visible: thinking-only successful stop and explicit
failure), no thinking-only answer/disclosure, keyboard/touch target, answer-only
copy, reload/history/reconnect and draft preservation. Screenshots/results default
to `.scratch/collapsed-thinking/browser`.
Fixture tests do not establish native Chat projection or joint acceptance.

For a native test-owned host, set `APP_ACCEPTANCE_URL` to its served frontend and
`APP_ACCEPTANCE_CONTROL_URL` to its isolated control endpoint. POST controls:
`{action:"reset"}` clears only that fixture session; `{action:"message", message,
history?:boolean}` injects an equivalent native completed record, projected through
the real adapter (actual thinking blocks, never hand-authored public DTOs).
Return a successful JSON response only after publication. `message` has the public
ChatMessage shape (agent/user/notice, stable id, text, optional thinking, createdAt,
null operationId/turnId); controls translate those expectations into native input.
A thinking-only successful stop preserves the native `回复失败` notice; the explicit
failure control contributes a second notice. The DTO fixture models both outcomes,
and the runner requires exactly two visible failure notices, without a thinking-only
answer bubble or disclosure.
POST `<control-url>/disconnect` disconnects fixture sockets without stopping work.
No providers/models/tools, live credentials/state or production endpoints are used.
`APP_ACCEPTANCE_ASSETS`, `APP_ACCEPTANCE_BROWSER`, and `APP_ACCEPTANCE_EVIDENCE`
select test-owned assets, Chrome executable and evidence directory. Installed Chrome
is the default; Bun 1.3.14 and Playwright 1.63.0 are the existing toolchain.

## Immutable handoff

After committing clean source, run
`bun tests/prepare-default.mjs --collapsed-thinking`. Existing preparation exports
compiled contracts, browser bytes, all acceptance runners (including thinking),
and documentation into `.scratch/collapsed-thinking/candidate`. `identity.json`
binds source HEAD to archive SHA256 and browser/contracts/acceptance manifest
hashes; `SOURCE_HEAD` and per-file manifests are inside the archive. An existing
identity is never overwritten. For a correction, run this unchanged preparation
in a test-owned clean detached checkout at the correction commit; retain the
original candidate/report/evidence as immutable history and deliver the new
candidate identity for focused Orc review before replacement consumption. Extract
in a test-owned location; verify archive and manifest hashes, install with `bun install --frozen-lockfile` in both
`contracts/package` and `acceptance`, then from `acceptance` run
`bun thinking-browser.mjs` with `APP_ACCEPTANCE_ASSETS=../browser` for local fixture
acceptance or the native URL/control variables above. Chat installs the extracted
compiled contracts package and serves these same browser bytes without rebuilding.

Chat consumption is blocked until Orc independently approves identity. Native
projection must additionally demonstrate original block order, answer independence,
absence, preserved failure/stop and thinking-only/tool-call-only behavior. App local
completion is not joint acceptance; merge and deployment remain unauthorized.

## Guidance inspected

README, protocol/integration docs and the CFL baseline guidance were inspected.
The existing Framework7/Markdown design remains primary; no corresponding Penpot
design is identified. No repository AGENTS.md/CLAUDE.md exists, so none was created.
The portable/host instructions were read. Baseline/compaction, search, images,
notifications and panel guidance needs no edit because their behavior is unchanged.
