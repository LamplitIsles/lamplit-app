# Source-line reply messages

Current implementation: FlickNote #60. Historical specifications and acceptance
records below describe earlier implementations.

The shared chat host projects each ordinary assistant reply as its original source
text plus ordered UTF-16 `ends`. A complete ordinary LF or CRLF source line becomes
visible immediately. Explicitly started multiline Markdown structures, such as
fenced code and leading-pipe tables, remain buffered until complete; an unfinished
final tail is published at completion. Blank-only tails do not create a bubble.
An ordinary `A | B` line is published immediately: a later table separator does
not revise it. Setext headings and reference definitions supplied later likewise
do not rewrite an already published segment.

View and history use the same host projection. Web slices the supplied source at
those ends; it does not derive reply boundaries. A displayed segment's identity is
its session, authoritative source ID, and ordinal. This identity is shared by
preview and final only when the backend supplies the same authoritative source ID.
Pi is planned to provide completed native entries without streaming preview; that
cross-repository integration remains separate from App fake verification.

The original source remains available once per source record, including whitespace
outside visible segments. Copy on an individual bubble uses that bubble's source
slice. User input, external messages, media and notices retain their own behavior.
There is no Whole reply/Source lines preference or independent timeline wire.
The client validates projected reply ends; the raw backend is not required to
calculate them. Marked is a direct contracts dependency; the server's existing
incremental segmenter and Web Markdown rendering have separate responsibilities.

History continuation and reconnect gaps use the existing paginated history
interface. When the controller cannot establish a continuous retained range, it
exposes a gap for user-interface-driven, one-page-at-a-time reconciliation; an
unavailable cursor or missing boundary must remain visible as unresolved. This
is not a guarantee that cross-device pending items, retroactive changes or differing
provider history order can be detected from the existing wire.

## Historical delivery and acceptance records (legacy)

The following sections document the earlier #4156/#4150 acceptance profile and
frozen artifact workflow. References to Whole reply mode, client-side splitting,
old fixture commands or past acceptance do not describe the current #60 protocol
and are not evidence that its current cross-repository integration has passed.

## Reply typing and finality (#4156)

The bottom typing row remains while subsequent source lines generate, including
when several completed lines are already visible. Explicit current-turn final-body
evidence removes it in the same update that reveals the exact final tail, in both
Source lines and Whole reply modes. Execution may continue: header running state,
Stop and queued/steered input remain truthful. Non-final item completion cannot
hide typing. See [the public final-body contract](protocol.md#final-reply-body-evidence).

`bun tests/reply-typing-browser.mjs` exercises the actual built Partner/Companion
DOM over an owned socket at mobile/desktop widths, including held execution after
final body, atomic DOM observations, stale evidence, omission, reconnect, new
turn/session and stop/failure. It is App fixture evidence, not native integration.
Use `APP_ACCEPTANCE_BROWSER` for a local Chromium executable.

## Checks

```sh
bun run build
bun test tests/sentence-replies.test.ts tests/newline-units.test.ts tests/sentence-stream.test.ts
bun tests/sentence-browser.mjs
# Fast actual socket/DOM regression, at both mobile and desktop widths:
bun tests/sentence-browser.mjs --atomic-only
```

The socket/controller test covers field addition, growth, removal, atomic final
replacement, reconnect, no partial pending storage and completion-only notifications.
The browser checks history/older pages, default/toggle/reload, atomic complete-line reveal with a held tail,
local/whole copy, visible avatars/source times, source newlines, same-line sentences, screenshot-shaped Markdown, reconnect, final replacement, stop/failure/session and scroll behavior,
at 390px and 1280px. The screenshot-shaped fixture reconstructs visible structure, not an unknown
production Markdown/event trace. Browser checks use real mobile touch holds and
desktop mouse holds before menu Copy. App-only checks also cover committed same-ID replacement;
that test does not require native committed-entry rewriting. Existing source/image,
thinking, search and reading runners supply regression coverage.

## Immutable handoff

Commit all source, then:

```sh
bun tests/prepare-default.mjs --sentence-replies
```

This established preparation path builds once into an exclusive
`.scratch/sentence-replies/candidate-<HEAD>/lamplit-sentence-replies.tgz`. It freezes
compiled `contracts/package`, `browser`, `acceptance` runners/fixtures/docs and
locked dependency metadata. `SOURCE_HEAD` identifies source; the three `*.sha256`
files list every component file. `identity.json` beside the archive records source
commit/tree, archive hash, component manifest hashes and runner hash. Preserve the
candidate unchanged; repairs create a new commit/candidate. The same combined
archive includes `source.tgz`, an exact `git archive` of that HEAD, also delivered
beside the archive with its SHA-256 in identity.json. This excludes local evidence
and generated output; it is the source for the frozen build. The sentence exporter installs with the frozen
lockfile and builds inside that extracted snapshot, never from a changing checkout. Orc reviews and
approves the precise identity before Chat consumption. No deployment is implied.

Extract into a new test-owned directory, verify the archive hash against the
approved identity, then verify each component before installation:

```sh
(cd browser && shasum -a 256 -c ../browser.sha256)
(cd contracts/package && shasum -a 256 -c ../../contracts.sha256)
(cd acceptance && shasum -a 256 -c ../acceptance.sha256)
(cd contracts/package && bun install --frozen-lockfile)
cd acceptance
bun install --frozen-lockfile
APP_ACCEPTANCE_ASSETS=../browser bun sentence-browser.mjs
```

For Chat native acceptance, serve **the frozen browser** from the test-owned
native fixture and use the frozen compiled contracts in that fixture:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:<gateway>/chat \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:<gateway>/__test/sentence-replies \
APP_ACCEPTANCE_ASSETS=../browser \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence \
bun sentence-browser.mjs
```

`APP_ACCEPTANCE_PROFILE` accepts only `default` (also used when omitted) and `cfl`;
unknown values fail before starting a host or browser. Default App/Pi/Chat checks
retain one seeded thinking disclosure. CFL retains its existing privacy policy:
seed the same completed/older answer text with the optional `thinking` field omitted,
expect zero thinking elements, and keep `CFL_REASONING_PRIVATE_SENTINEL` out of the
DOM. The native CFL fake engine must seed that sentinel as official reasoning and
independently verify its absence from view/history/notifications. Select the same
profile for local fixture and approved frozen native acceptance:

```sh
APP_ACCEPTANCE_PROFILE=cfl APP_ACCEPTANCE_ASSETS=../browser bun sentence-browser.mjs
```

The profile changes only test fixture thinking and its explicit assertions;
all answer/user, copy, rich content and lifecycle checks still run. App rich
thinking remains positively checked under default, and absent under CFL.
Local fixture PASS is not native CFL proof; #4126 owns the native run after
Orc approves the exact new #4128 archive. Earlier #4105 archives remain immutable.

Optional `APP_ACCEPTANCE_BROWSER` selects a local Chrome executable. The runner
uses fresh isolated browser contexts, fictional gateway auth if the fixture needs
it, and the actual `/api/chat/socket`. It never starts a live model. External mode
does not create/use an App DTO host. `APP_ACCEPTANCE_ASSETS` is used by the local
App server; the external native host must independently serve that exact directory.

## Native semantic fixture controls

POST JSON to `APP_ACCEPTANCE_CONTROL_URL`. These are test-only controls, not
production protocol additions. Chat must implement them via supported native
ingress/appendEntry and its held fake SSE provider, never by injecting ChatView.
All text inputs are answer text; native submission may add actual user messages.
Use the fixture prompt `Test-owned sentence acceptance input`, never the supplied
answer marker as the user body. The runner scopes answer assertions to incoming
message bubbles and explicitly checks the outgoing prompt's count, exact content
and visibility in isolated cases; display toggles must preserve user content.
The App fixture's first start in an empty session includes this real user record,
so user and agent bubbles coexist in local handoff regressions. These are App DTO
fixtures, not native ingress proof. The runner never relies on chosen native
IDs/timestamps or total transcript row counts.

Every successful control returns JSON with `{ held: boolean, generationId:
string | null, executions: number, completed: boolean }`. `generationId` is a
fixture-owned provider execution identity stable across observation disconnects,
not necessarily the public preview ID. `executions` counts actual fake-provider
requests since reset. `completed` is true only for the `complete` action.

The reset table describes default; under `cfl`, omit thinking as specified above.

| Action JSON                                                 | Meaning                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"action":"reset"}`                                        | Fresh test-owned session/history, zero executions. Seed ordinary completed answer `历史第一行。同行第二句。\n历史第二行。` with thinking `一次思考`; seed older answer `更早第一行。\n更早第二行。`. Native may add filler records so the older marker is behind a genuine history cursor; do not add other thinking disclosures. |
| `{"action":"start","text":"正在"}`                          | Actually submit a native fixture prompt; open the fake provider and emit this answer prefix. Return only once the real upstream stream is unfinished and open (`held:true`, nonempty generationId, executions incremented).                                                                                                       |
| `{"action":"advance","text":"正在生成第一句"}`              | Append only the new suffix through the same held native provider stream; no terminal frame.                                                                                                                                                                                                                                       |
| `{"action":"complete","text":"正在生成第一句。最终正文。"}` | Append suffix then terminal frame; await native completion/final history reconciliation, returning `held:false, completed:true`.                                                                                                                                                                                                  |
| `{"action":"status"}`                                       | Observe actual provider hold/execution status without starting a request or advancing text.                                                                                                                                                                                                                                       |
| `{"action":"stop"}`                                         | Abort via actual Chat/native stop; reconcile native stop outcome, including existing `已停止回复` notice. No new completed partial answer.                                                                                                                                                                                        |
| `{"action":"fail"}`                                         | Fail the held fake provider through native failure handling; retain existing `回复失败` outcome. No new completed partial answer.                                                                                                                                                                                                 |
| `{"action":"session"}`                                      | Switch to a fresh test-owned native session, clearing previous preview authority/history.                                                                                                                                                                                                                                         |

`advance` and `complete` cumulative text must extend the emitted prefix; reject
non-prefix input or missing held provider with a non-2xx error. Reject unknown
actions and a second `start` while held. No text rewrite or DTO injection is
required. The runner uses monotonic text, including its long scrolling stream.

POST `<control URL>/disconnect` closes **observation sockets only**, returning
`{"disconnected":true}` after closure; it must not cancel or restart generation.
The runner waits for preview removal and restored native snapshot, then calls
`status` and asserts held/generationId/executions are unchanged before completion.
Native retry/privacy/tool-round coverage belongs to native runtime tests.

App fixture additionally supports `{"action":"update","text":"..."}` for
same-ID completed source replacement and `excluded` for local source regression
fixtures. External/native runner never calls either. App DTO passing results are
not native acceptance; preserve both evidence sets and approved archive identity.

## Combined current-main handoff

Sentence artifacts now include current-main structured search from PR23 (#4006)
and the PR24 output-image contract fix. `SearchCard.snippet` is exclusively
`{ segments: [{ text, highlighted }] }`; old strings are rejected. Preserved
message image references have no count ceiling, while submission/upload/recovery
input limits remain six. Neither change alters `streamingReply` omission or its
answer-only fields. No compatibility layer or second artifact pin is needed.

The same archive contains `sentence-browser.mjs` and `search-browser.mjs`, with
both hashes in `identity.json`. After verifying/installing the frozen archive
as above, run both against the same frozen browser/contracts:

```sh
APP_ACCEPTANCE_ASSETS=../browser bun sentence-browser.mjs
APP_ACCEPTANCE_ASSETS=../browser bun search-browser.mjs
```

For native search acceptance, use `APP_ACCEPTANCE_URL` and the search fixture's
`APP_ACCEPTANCE_CONTROL_URL` as specified in
[conversation search](conversation-search.md). Sentence controls stay as defined
above. The two native-compatible runners consume one combined artifact; earlier
fixed-base sentence candidates remain historical and must not be relabeled.
The independent `--structured-search-snippets` exporter mode and existing modes
retain their original output names and identities.
