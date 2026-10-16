# Sentence replies

Spec: FlickNote #4085; paired native Chat #4086; research #4084.

Ordinary companion answers display in sentence bubbles by default. Available
text grows immediately inside the current bubble; the next sentence opens the
next bubble. There is no reveal queue, pacing timer or simulated typing. Settings
→ Appearance and language → Reply display switches between Sentences and Whole
reply, immediately and across reloads. Local storage failures leave the current
page usable. History, older pages and complete-only arrivals show all text at once.

One source contribution retains its images, thinking disclosure, time and avatar
grouping. Copy from any sentence copies the full source answer (currently available
text for a preview). User, Keet, Matrix, reminder and notice bodies are excluded.
Search remains the complete-record reader; notifications observe completed messages.
Near-bottom readers follow growth; earlier reading remains anchored.

`Intl.Segmenter("en", { granularity: "sentence" })` gives a fixed content policy
independent of interface language. Marked 18.0.14 is a direct dependency matching
the installed renderer's parser. Inspected renderer exports offer IncrementalParser,
not an assumed standalone lexer. The splitter uses Marked's typed `Lexer.lex`
and raw/token fields. Completed plain sentences before the first rich inline span
keep their source offsets and bubbles as the available text grows. The current
sentence and the remaining rich paragraph tail stay together, including unfinished
link/code/math delimiters. Rich inline spans,
URLs, code, tables, lists, blockquotes, math and unfinished rich syntax remain
conservative larger chunks. Reference definitions or normalized source whose
raw offsets cannot be guaranteed keep the whole answer. Source spans are lossless;
common title abbreviations are joined, and punctuation/whitespace alone does not
open an extra bubble. This is not a universal English abbreviation/NLP guarantee.

## Checks

```sh
bun run build
bun test tests/sentence-replies.test.ts tests/sentence-stream.test.ts
bun tests/sentence-browser.mjs
```

The socket/controller test covers field addition, growth, removal, atomic final
replacement, reconnect, no partial pending storage and completion-only notifications.
The browser checks history/older pages, default/toggle/reload, held text growth,
full copy, reconnect, final replacement, stop/failure/session and scroll behavior,
at 390px and 1280px. App-only checks also cover committed same-ID replacement;
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
candidate unchanged; repairs create a new commit/candidate. Orc reviews and
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
Use a distinct fixture prompt, never the supplied answer marker as the user body.
The runner targets known answer marker text, never chosen native IDs/timestamps
or total transcript row counts.

Every successful control returns JSON with `{ held: boolean, generationId:
string | null, executions: number, completed: boolean }`. `generationId` is a
fixture-owned provider execution identity stable across observation disconnects,
not necessarily the public preview ID. `executions` counts actual fake-provider
requests since reset. `completed` is true only for the `complete` action.

| Action JSON                                                 | Meaning                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"action":"reset"}`                                        | Fresh test-owned session/history, zero executions. Seed ordinary completed answer `历史第一句。历史第二句。` with thinking `一次思考`; seed older answer `更早第一句。更早第二句。`. Native may add filler records so the older marker is behind a genuine history cursor; do not add other thinking disclosures. |
| `{"action":"start","text":"正在"}`                          | Actually submit a native fixture prompt; open the fake provider and emit this answer prefix. Return only once the real upstream stream is unfinished and open (`held:true`, nonempty generationId, executions incremented).                                                                                       |
| `{"action":"advance","text":"正在生成第一句"}`              | Append only the new suffix through the same held native provider stream; no terminal frame.                                                                                                                                                                                                                       |
| `{"action":"complete","text":"正在生成第一句。最终正文。"}` | Append suffix then terminal frame; await native completion/final history reconciliation, returning `held:false, completed:true`.                                                                                                                                                                                  |
| `{"action":"status"}`                                       | Observe actual provider hold/execution status without starting a request or advancing text.                                                                                                                                                                                                                       |
| `{"action":"stop"}`                                         | Abort via actual Chat/native stop; reconcile native stop outcome, including existing `已停止回复` notice. No new completed partial answer.                                                                                                                                                                        |
| `{"action":"fail"}`                                         | Fail the held fake provider through native failure handling; retain existing `回复失败` outcome. No new completed partial answer.                                                                                                                                                                                 |
| `{"action":"session"}`                                      | Switch to a fresh test-owned native session, clearing previous preview authority/history.                                                                                                                                                                                                                         |

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
