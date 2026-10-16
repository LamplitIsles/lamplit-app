# Source-line reply messages

Spec: FlickNote #4105; acceptance profile #4128; research #4103. #4085/#4086 describe the historical first delivery.

Ordinary companion answers display as independent messages at their **source LF or
CRLF line breaks** by default. Multiple sentences on one source line stay together;
CSS wrapping does not create a message. Consecutive blank lines produce no empty
messages, but all original whitespace remains in the source spans. Entirely blank replies
produce no display row while their preserved source remains untouched. The unfinished
last line grows immediately, without a reveal queue, pacing timer or fake typing.
Settings → Appearance and language → Reply display switches between Source lines
and Whole reply, immediately and across reloads. Local storage failure leaves the
current page usable. History and older pages use the same projection.

Every display message has a visible Framework7 avatar and footer using the source
reply's timestamp. Long-press Copy takes only that message's exact Markdown source
span; Whole reply copies the complete source. Thinking appears once; images keep
their original order and association. Display splitting adds no durable records or
notifications. User, Keet, Matrix, reminder and notice bodies are excluded; search
remains the complete-record reader.

Marked 18.0.14 and the installed renderer's KaTeX extension identify necessary
structure. Lists (including nesting), fences, tables and block math stay intact;
ordinary lines after them resume splitting. Quoted prose lines retain quote depth.
A completed inline span crossing lines protects only those lines, including
paired inline HTML through its closing tag (with nested pairs and void tags).
The following source line resumes normal splitting. An unfinished
span protects the current tail until closure. An introduction on its own source
line remains separate from the following list, including introductions ending in
a colon. No punctuation, abbreviation, language heuristic or character threshold
creates message boundaries.

Offsets are UTF-16 source boundaries mapped through normalized CRLF. Copy spans
are separate from render tokens, which share the full source's reference links.
Quote render wrappers never enter Copy or persistence. Tokens still use
SvelteMarkdown's URL/attribute sanitation and our unsupported-HTML renderer. Whole
mode uses that same renderer contract. No public protocol or persistence changed.

Installed `@humanspeak/svelte-markdown` 1.8.5 supports `string | Token[]` and exports
IncrementalParser. A full Marked parse owns source boundaries, shared references and
paragraph/inline semantics. Projection clips that original tree before a fresh
public IncrementalParser cleans the projected tokens, supplied through a Marked
block extension rather than lexing each fragment as a new document. Cleaned HTML
may normalize tags, attributes and lengths; its render tree never drives source
offsets. This preserves continuation-line semantics and exact Copy spans.
Unsupported HTML still displays through the existing escaped-tag renderer, with
the same URL/attribute sanitation. Each Markdown
instance retains only its previous identical render-token value to keep inner DOM
nodes stable; comparison includes resolved reference links, so late definitions
still update the visible link. Single-dollar math cannot span source lines in the
installed extension; ordinary dollar amounts do not protect following lines.
Supported multiline `\(...\)` and block math retain their token spans. No
streaming state machine or global render cache was added. Research #4103's former natural-language boundary recommendation
was superseded by the user's source-newline clarification in #4105. SentenceX,
sentence-splitter, remend and streaming-markdown are unnecessary for this policy;
no dependency, WASM initialization or NLP layer was added.

## Checks

```sh
bun run build
bun test tests/sentence-replies.test.ts tests/newline-units.test.ts tests/sentence-stream.test.ts
bun tests/sentence-browser.mjs
```

The socket/controller test covers field addition, growth, removal, atomic final
replacement, reconnect, no partial pending storage and completion-only notifications.
The browser checks history/older pages, default/toggle/reload, held text growth,
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
