# Native durable submission handoff — spec #3435

App owns the only public schema and the complete shared Framework7 frontend.
Pi (#3436) and CFL (#3437) consume the same Orc-approved source/build/contracts/
runner identity. App fixture success establishes local readiness; actual Pi DO and
CFL handler/socket joint acceptance remains pending Orc. Do not merge or deploy
based on these fixture results. Do not adapt the runner or manufacture DTOs to
make a native implementation pass; return semantic conflicts to the App owner.

## Public boundary

The view is `version: 2`, Chord singleton `lamplit.chat.v2`, socket path
`/api/chat/socket`. The transport envelope still uses `version: 1`. Runtime
validation rejects old receipt states, `ChatMessage.delivery` and recovery state.
There is no old-wire fallback or second execution engine. Existing PWA pages must
reload/update to the matching frontend: the old service ID cannot subscribe to v2.

```ts
Submission = {
  operationId: UUID; text: string; images?: ImageRef[];
  replacementSourceIds?: string[];
}
Receipt = {
  operationId: string; state: "submitted" | "failed";
  messageId: string | null; turnId: string | null; error: string | null;
}
InputRecovery = {
  sourceId: string; operationId: UUID; text: string; images: ImageRef[];
  replacementEligible: boolean;
}
ChatBackend.submit(input: Submission): Promise<Receipt>
ChatBackend.lookup(operationId: string): Promise<Receipt | null>
ChatBackend.stop(turnId: string): Promise<{ stopped: boolean }>
```

`ChatService` has the same methods with Chord `Context` as the last parameter;
`openChat` supplies that context. Both host and client validate lookup nullability
and operation correlation. `submitted` proves durable reception. `failed` proves
not received, independent of reply execution; a nullable message/turn identity
never acts as another outcome classifier. Null lookup is no definitive result.
Repeated nulls or lost transport acknowledgements cannot authorize recovery.
Identical operation ID and full payload deduplicate; different content conflicts.
After explicit withdrawal before processing, retain a submitted receipt and add a
confirmed recovery item. Failed/stopped replies only publish stable notices.

Timeline user messages are persisted receptions. The App manages local
`sending`/`sent`/`failed`, merges by operation ID, and persists pending references.
Text-only submissions omit optional fields. Image upload, ordering, ownership and
replacement eligibility remain governed by [image recovery](image-send-recovery.md).
Original bytes survive in authorized native media; browser Files/previews remain
page-owned until observation/failure. A reload before image upload completes
cannot preserve those Files. The deterministic old local pending decoder preserves
text/images/IDs and admission facts; it never infers failure from network ambiguity
or resubmits automatically. Native storage conversion remains backend-owned.

## Reproducible local checks and freezing

From the App checkout, with committed source and a clean tree:

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run format:check
bun run test
bun run build
bun tests/optimistic-send-browser.mjs
bun tests/images-browser.mjs
bun tests/native-gallery-browser.mjs
bun tests/keet-browser.mjs
bun run prepare:default
```

`prepare:default` now creates `.scratch/native-durable-submissions/candidate/`,
refusing to overwrite an identity. It builds only this checkout, records the
source HEAD and SHA-256 manifests for browser/contracts/acceptance, and packages
`lamplit-native-durable-submissions.tgz`. The archive includes compiled contracts,
all relevant runners/fixtures/docs, and `SOURCE_HEAD`. Verify the archive hash and
all three manifests after extraction. Install contracts dependencies in their own
package directory before acceptance dependencies: Bun file-links that package and
resolves its runtime imports from the original directory.

```sh
(cd contracts/package && bun install)
(cd acceptance && bun install)
```

Run these only inside the test-owned extraction, then verify all manifest files
still match. Lockfiles created
by that isolated install are auxiliary evidence, never product compatibility.

Orc approves this final identity before either backend freezes its consumption.
A later App source or runner correction requires another identity and approval.
Local screenshots/results and final source, artifact and evidence hashes are
recorded in `.scratch/native-durable-submissions/implementation-report.md`.
The repository has no AGENTS.md; user/host instructions govern implementation.
README, protocol, integration, image documentation and CONTEXT cover this change.
No Penpot design change applies; actual mobile/desktop send, failure and recovery
states retain the existing Composer and Framework7 styles.

## Joint submission runner

From the extracted `acceptance/`, run the identical approved runner against each
backend's real handler/socket, isolated native store and fake model/tools:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/submissions \
APP_ACCEPTANCE_ASSETS=/absolute/extracted/browser \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/submissions \
bun optimistic-send-browser.mjs
```

Use test-only owner auth; optional `APP_ACCEPTANCE_USERNAME/PASSWORD` apply to the
browser, controls and separate socket correlation probes. Cookies from the isolated
browser context accompany the socket probes. Never use production credentials.
The native controls are test infrastructure, not production routes or replacement
chat adapters. Model/MCP/Keet external calls are fixtures/fakes. Controls must drive
real native submit/persistence/projection/recovery; do not forge public messages,
receipts, recovery DTOs or storage. Timing gates may hold transport result/publication
without changing the native submission result. In the slow scenario, `hidden` must
hold publication through acknowledgement until `publish`, so the App's persisted
`sent` state can be observed. A lost-ack initial/reconnected native snapshot may
already expose the persisted message.

Every JSON POST action returns native `{ executions, submissions, recovery,
messages, limits, album, submitCalls, lookupCalls }`. `submitCalls`/`lookupCalls`
count socket invocations (including retries), while `executions` counts actual fake
native runs, never HTTP uploads. `submissions` contains immutable original payloads,
including definitively failed attempts needed for fixture diagnostics. A same-ID
retry cannot create another native run or timeline entry.

| Action                                | Test-owned native effect                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `reset`                               | Reset this fixture's store/media/receipts/counters only; release old gates.                         |
| `mode`, `state: submitted`            | Normal durable submission and fake reply execution.                                                 |
| `mode`, `state: slow`, `hidden: true` | Hold next submission before durable reception; hold outgoing publication if supported.              |
| `mode`, `state: publishFirst`         | Persist and publish next input before releasing its RPC acknowledgement.                            |
| `mode`, `state: lost`, `hidden: true` | Persist input and lose its acknowledgement; lookup must find submitted.                             |
| `mode`, `state: null`                 | Lose acknowledgement before reception; lookup remains null; never synthesize recovery.              |
| `mode`, `state: failed`               | Definite nonreception with recoverable text and owned image originals.                              |
| `mode`, `state: withdrawn`            | Submit then explicitly withdraw before processing; publish recovery and retain submitted receipt.   |
| `release`                             | Release only the current timing gate.                                                               |
| `publish`                             | Release held native view publication.                                                               |
| `replyFailure`                        | Fail the current fake reply through native execution; publish `回复失败` notice, no input recovery. |
| `complete`                            | Finish fake turn with `完整图片回复` and actual generated-image membership, as in image runner.     |
| `consume`                             | Process/resolve recovery sources and remove them durably; preserve submitted receipts.              |
| `state`                               | Read diagnostics without mutation.                                                                  |

The runner checks immediate text/image bubbles, slow acknowledgement and publish
order, lost acknowledgement/reload/reconnect without replay, null without recovery,
definite rejection and original-image restoration, edited replacement, pre-processing
withdrawal, reply failure/targeted stop independence, exact-ID dedup/content conflict,
reload history uniqueness, and light/dark 390/1280 layouts. Local runs use
`tests/submissions-fixture.ts`; native runs must exercise actual native boundaries.
The runner waits for persisted `sent`, then exact-operation pending retirement;
publish-first retirement must precede ACK release. Sending/null display the existing
quiet sending label; confirmed/observed inputs do not. Native stop must retire the
active stop control, publish the existing `已停止回复` notice, and preserve the exact
stopped operation's `submitted` lookup result without input recovery.
The image runner continues 390/1280/320 ownership/media/history/album/recovery gates
using `submitted/withdrawn/failed` modes. Its full controls remain in the image doc.

Run existing browser, voice, panels, images, compact, search, route lifecycle and
Keet runners against the same approved artifact, with their documented isolated
controls. One ordinary reply and the Keet maintenance path must retain original
public text/source privacy and exclude internal attribution/context from timeline,
search and panels. The unchanged Keet runner supports both image profiles; native
provider prompts/maintenance requests require backend-side evidence in addition to
browser projection checks. Native-gallery verification uses the app's plugin fake;
it establishes preserved routing/bytes behavior, not physical device acceptance.
