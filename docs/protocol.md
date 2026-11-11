# Chat protocol v2

The browser opens a same-origin WebSocket at `/api/chat/socket`. A connection is
an observation/control channel; closing it never means stopping engine execution.
Static assets and media continue to use HTTP. `GET /api/chat/appearance` returns
validated display names, optional companion/user avatar URLs and optional
landscape/portrait backgrounds from the deployment's existing configuration.
The endpoint and its assets use the same owner authentication as chat; responses
are not cached. Empty names use the chat name and the localized user label.
Reloading the page reads updated configuration.

`lamplit.chat.v2` is a Chord singleton with:

| Member                                                                 | Meaning                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `view`                                                                 | Replicated main-session identity, recent messages, active turn, cursor and capabilities |
| `history(before)`                                                      | Previous page of source messages and its opaque continuation cursor                     |
| `submit({ operationId, text, images?, files? })`                       | Submit one logical message and return a correlated native outcome                      |
| `lookup(operationId)`                                                 | Inspect a logical message's current confirmed outcome, or unknown                      |
| `compact({ sessionId })`                                               | Explicit native idle compaction; refusal preserves drafts, success has no chat message  |
| `stop(turnId)`                                                         | Stop this specific turn; a stale turn returns `stopped: false`                          |

Chord method contracts include an invocation context as their last parameter.
The browser helper supplies it. Socket cancellation is not passed into execution;
the native execution owner handles explicit stop.

## Assistant voice messages

`ChatMessage.voice?: { id: string }` identifies a standalone incoming voice
message. The ID is exactly 64 lowercase hexadecimal characters; it is an
opaque reference, not a transcript. The corresponding authenticated,
same-origin MP3 is read from `/api/audio/<id>.mp3`. A voice message has the
same stable message identity and history behavior as other chat messages.
The reference carries no duration or waveform samples. The UI's decorative
bars show playback progress without claiming to represent the audio waveform.

## Optional assistant thinking

`ChatMessage.thinking?: string` carries actual assistant thinking block strings,
joined in original block order with `\n`. `text` remains the independent answer.
Omit thinking when absent; do not infer it from ordinary text or export signatures,
private prompts or tool arguments. The optional field leaves protocol v2 unchanged;
CFL can omit it. Search previews retain their existing text-only schema.
Thinking does not alter completion/failure/stop semantics or make thinking-only
and tool-call-only entries successful answers. See [UI and acceptance](collapsed-thinking.md).

## Delivery semantics

A turn can produce multiple independently identified entries. Text, images,
voice and user messages use the order supplied by the backend in each view and
history page. Continuity across pages depends on the provider's cursor and
ordering semantics, as described below.
An in-progress text entry uses `textState: "streaming"`; its completed form uses
the same message ID and may use `textState: "complete"`.
A later failure or stop does not turn unfinished text into a successful message.
Completed messages are retained independently of a turn's final outcome.
Successful completion clears the active turn without adding a chat notice.
Failed and stopped results remain stable notice messages, independently of
assistant text. A stop before generation must still produce its stopped outcome.
Outgoing messages appear immediately as ordinary bubbles. A `submitted` receipt
means reliable native acceptance, not merely storage or an intermediate queue
acknowledgement. A `failed` receipt means definite failure to deliver that input;
a reply that later fails or stops does not revoke accepted input. `null`, transport
errors and timeouts mean unknown. They neither prove failure nor authorize replay.
Sending while a response is active continues to steer that active turn in real
time; it does not wait for the turn to finish.

Submit and lookup results are correlated to the logical operation ID. Lookup may
return `failed` only when the native host can prove that it describes the current
attempt; otherwise it returns `null`. The frontend retains definite failures and
allows explicit retry or local discard. Retry after submission uses the same
operation ID and content. Before submission, retrying failed file staging uses a
new operation ID while preserving the displayed logical message if the required
originals remain available. Unknown outcomes are never automatically replayed;
once no send is in flight, the item may be removed from this device without
marking it failed or deleting native history that may appear later. The native host
must establish the identity and deduplication boundary required for safe retry;
the shared socket cannot manufacture one. Accepted input cannot be delivered twice.
Each receipt also carries a positive safe integer `attempt`: first 1, then advanced
by the native host for each explicit retry after definite failure. A host with
durable source identity preserves the sequence across restart. The host publishes
only proven current-attempt results, and the client fences local retries and
compares attempts so a late older result cannot overwrite the current one.

A queued input removed by stop is failed only on affirmative evidence that it was
not processed. A missing history item or missing lookup result is not such evidence.
If that evidence cannot be recovered after disconnection, the result remains
unknown. Backends recheck authenticated owner/session before handing work to the
native execution owner and use a pre-commit guard where that owner supports one.
Work already handed off may complete after revocation; reconcile the actual or
unknown outcome without replay. Responses and events remain authorized per
connection, and remote revocation is not atomic with native commit. Backends
notify the existing subscription of observable changes. See
[native delivery](native-durable-submissions.md) and [attachments](image-send-recovery.md).

The view remains version 2 and the Chord service remains `lamplit.chat.v2`.
Deploy matching clients and host together: there is no negotiation or old-wire
fallback. Current clients require projected reply boundaries and do not consume
the former independent timeline events. The transport envelope remains v1.

## Final reply body evidence

`ChatView.replyCompletedTurnId?: string` is explicit native-host evidence that the
**final reply body** for the current turn is complete, independently of execution
cleanup (spec #4156). Publish it in the same view update as the final preserved
body and removal of `streamingReply`. Only equality with a non-null `activeTurnId`
suppresses the bottom typing row. A completed non-final agent item, history entry,
missing preview, or ended turn does not establish finality.

Omission means no evidence; snapshot refresh removes an omitted field. Hosts omit
it for a new turn/session and after execution ends, stops or fails. Reconnect
replaces the observed view with the fresh authoritative snapshot; no completion
cache is carried between sessions or turns. During an observation disconnect,
the last completed-body evidence remains attached to its observed turn, so typing
does not reappear merely because the socket closed. Running status, Stop and
queued/steered submission continue to follow execution and connection authority.
Image-generation indicators retain precedence. The field is transient, not history.

The App schema/renderer and owned socket/browser fixture establish this contract.
Native producers must independently prove which engine phase identifies a final
reply and publish it atomically; App DTO fixture success is not native proof.

## Frames and validation

Calls use `{ type: "call", version: 1, id, call }`, where `call` is Chord's own
service-call grammar. Replies are `result` or `error`; subscriptions emit `update`
frames keyed by subscription ID. Definite delivery results use
`{ type: "deliveryResult", subscriptionId, receipt }` under that same
subscription. The backend emits `{ type: "deliveryResult", scope, receipt }`
using the current process-local session scope. `openChat` accepts a fourth,
independent receipt callback, installed before the subscription starts; it may
run before `openChat` resolves. Events before subscription readiness, during a
disconnect, or after closure are not replayed; lookup after readiness/reconnect
reconciles missed results. The wrapper handles framing and correlation,
not a second RPC service model. Chord control calls discover and subscribe services.

TypeBox validates public application payloads; Chord validates its service and
state-operation grammar. Browser snapshots and method results are also checked at
runtime. The service token and schemas are shared by both backends and frontend.

Each subscription has an independent Chord state encoder/decoder. A new provider
or connection starts with a fresh snapshot; its path dictionary is not reused.
Snapshot delivery is queued before activated subscription updates. The latest view
contains at most 30 messages; earlier history is paginated. Transport frames are
limited to 2 MiB and queued/buffered output to 4 MiB. Slow consumers reconnect and
rehydrate rather than silently dropping deltas.

Each inbound command and outgoing frame passes the host authorization check.
The Pi adapter supplies connection-specific hosted-session verification so one
connection's identity cannot leak into another's delivery callback.

## Voice input compatibility contract

The App no longer records audio, performs speech-to-text, or opens the voice input
stream. Existing hosts, including CFL, still consume `@lamplit/contracts/voice`;
its public export, schemas, validators, constants and wire semantics remain intact.
This input compatibility contract is separate from [assistant voice messages](#assistant-voice-messages)
and from streamed text replies.

For compatible hosts, `GET /api/voice/capability` returns `{ available: boolean }`
and `/api/voice/stream` is a same-origin authenticated WebSocket. Audio is mono
PCM16 little-endian at 16 kHz, limited to 300 seconds, 9,600,000 raw bytes and
16 KiB per even-length frame. Client controls are `finish` and `cancel`; server
events are `ready`, `result` with nonblank bounded text, or `error` with a listed
voice error code. The public validators enforce frame, control, event and transcript
bounds; hosts remain responsible for authentication, lifecycle and provider behavior.
CFL's existing backend implementation and tests are unchanged by this App change.

## Companion panels

The same service now includes six bounded, validated read methods; see
[companion-panels](companion-panels.md) for exact request/response fields, native
adapter responsibilities and frozen acceptance commands. Reminder provenance is
persisted in the optional message `source` field. No panel reads use CFL-only JSON
endpoints, and image bytes remain on authenticated same-origin HTTP.

## Images and message delivery

The [image contract](image-send-recovery.md) defines authenticated uploads,
media references and limits. Upload is not native message acceptance. Ordered
attachment references belong to the logical submission; unresolved delivery is
looked up, never automatically replayed.

## Native context and compaction

The required session-scoped `contextUsage` and `compaction` fields and explicit
`compact` member are defined in [quiet compaction](quiet-compaction.md). They use
the same runtime-validated Chord service. Missing native usage remains nullable on
the wire. Native completion invalidates stale tokens until fresh usage exists;
it never adds a terminal notice or historical marker to chat. Native running and
failed lifecycle facts remain observable. Commands are not submission operations,
are not stored in pending input and are never replayed after a lost response.

## Conversation archive reads

`search({ query })` and `searchRead({ id })` are on-demand, runtime-validated reads
on `lamplit.chat.v2`; they never alter replicated view or execute the engine.
See [search schemas and bounds](conversation-search.md#public-app-contract) for
individual message/summary cards, nullable totals, native metadata, opaque record
identity and bounded nearby context. No cwd/source paths cross the public boundary.
An oversized serialized method reply becomes an RPC error before delivery, retaining
the normal chat connection; slow-consumer output backpressure still reconnects.

## Default frontend boundary

The app uses root-relative assets at standalone `/` and hosted `/chat`; `/slice`
is removed without alias. Public endpoint paths and schemas remain unchanged.
Platform owns hosted manifest/service worker/auth and management independently.
See [complete regression and native handoff](default-shared-frontend.md) for the
current single artifact and test-only controls; those controls are not public APIs.

## Native incoming sources

`MessageSourceSchema` accepts existing reminders and the minimal Keet display
variant: `{ kind: 'keet', channel: 'dm' | 'group', senderLabel, destination }`.
Labels are nonblank single-line strings bounded to 512 Unicode code points.
Source is accepted only from backend views/history, never browser submissions.
Native adapters provide original visible `ChatMessage.text` and image references;
attribution prompts, model context and native message identifiers stay private.
See [Keet presentation and same-artifact acceptance](keet-source-restoration.md).

Matrix extends the same closed union with `{ kind: 'matrix', senderId,
senderDisplayName, roomId }`. IDs are nonempty; display name may be empty. All
three are bounded to 255 UTF-16 units by shared schema/format validation. No extra
single-line rules or payload/context fields are admitted. Adapters provide original
body and authored time separately; web submissions cannot supply provenance.
See [Matrix presentation and native acceptance](matrix-source-ui.md).

## In-progress answers

`ChatView.streamingReply?` is `{ id, turnId, createdAt, text, ends }`, using the
same bounded nonempty ID, nullable turn ID, number time and string text conventions
as messages. It contains only available answer text, never thinking, signatures,
tool arguments or output. Omission means there is no current preview. The shared
host refresh copies or deletes this field alongside messages in the Chord view.

When the provider emits a preview and its corresponding in-progress or completed
entry, it must supply the same authoritative source ID; the host cannot infer
that association from text or time. A duplicate preview and message with the same
ID is rendered once. Pi's intended completed-only integration does not require a
preview-to-entry mapping; the App fake does not prove that integration is deployed.
Retry/stop/error/session reset must reconcile to native truth. A preview does not
establish final-body evidence or admission. See [sentence replies](sentence-replies.md).

## Reply projection and history recovery

The shared host projects an ordinary assistant source as its original `text` and
ordered `ends` offsets in UTF-16 code units. Each segment is the range from the
previous end (or zero) to the next end. The source text is retained once, including
any unpublished tail or trailing whitespace; the client renders the supplied
ranges and does not derive its own boundaries. `ends` may be empty. Ordinary
complete LF/CRLF lines publish as they arrive, while explicitly started multiline
blocks are buffered; a final unfinished line is emitted at completion. Blank-only
tails do not create bubbles. A non-leading-pipe `A | B` line is immediate, and
later Setext or reference definitions do not revise prior lines.

An ordinary assistant source here has role `agent` and no `source`, `imageState`
or `voice`; user, notice, external and media messages do not require reply ends.
Raw backend input may omit `ends` because the host computes them. `openChat`
requires and validates ends on delivered ordinary replies and previews: offsets
must increase, stay within the source and not split a UTF-16 surrogate pair.
Segment identity is scoped by session, authoritative source ID and ordinal. A
single source remains a single paginated message even if it displays many segments.

For an active reply, the host protects already published text and boundaries;
an unpublished tail or unfinished block may be rewritten and resegmented. A
conflict with published segments or an overlapping completed source is rejected,
not silently substituted. History is compared against overlapping current or
initial view sources; the host cannot compare an absent source to an unknown
older page. A rejected background change retains the last published view; command
errors and unknown submission outcomes must not cause automatic resubmission.

Backend `subscribe(changed)` delivers in-process changes to the shared host, which
updates the existing Chord view. It is not a second wire channel. A provider sends
absolute source messages and state, including an explicit `afterId` for a new or
reordered message; larger structural changes may supply an ordered window and
cursor. An update to an existing source keeps its position unless an anchor is
given. The host computes reply ends and reports conflicts without publishing the
conflicting view. Ordinary reply deltas do not require a fresh backend window,
receipt lookup or media read.

An explicit provider `{type: "error"}` means the host can no longer guarantee
its view is current: it closes all of its connections with the existing reconnect
signal. A source or projection conflict is reported while retaining the published
view and connections. Closing observation does not cancel a dispatched submission;
clients inspect its receipt or unknown outcome instead of resending it.

The host subscribes before reading its initial view. Changes received while the
read is pending are temporarily retained in order and applied before the first
view is published; only adjacent updates of the same source without intervening
structure or state are coalesced. A provider supplies an in-process session scope
and sends a new scope with a session change, so late changes from the earlier
lifetime are ignored even if the session ID later recurs. The initializer's
optional abort signal cancels the initial `read` signal and closes the subscription
on failure or cancellation. Temporary memory can grow with changes during a slow
initial read; cancelling the provider's own work requires it to honor the signal. This
handoff does not establish a global atomic snapshot across independent native,
admission and media sources. Providers must ensure that applying the buffered
changes to the initial read does not regress facts already included in that read,
and must eventually deliver subsequent facts omitted from it. Their known
ordering limits remain.

There are no independent timeline item or structure frames and no
automatic reread of already loaded historical items. Changes to media outside the
live window therefore do not automatically update a loaded page. The current
schema permits `imageState: "preparing" | "ready" | "failed" | "unknown"`;
`ready` requires one available image and the other states have no images. `unknown`
means the result cannot be verified. Providers must expose generated images in
history only when complete and readable; the shared schema itself does not enforce
that provider behavior.

The Web controller retains loaded messages when the live window changes and can
expose multiple gaps between retained old and new sources. A visible pending gap
is filled on demand, at most one history page per `fillGap(id)` call, with no
background full-history scan. Errors can be retried; a repeated cursor or reaching
the end without the retained boundary leaves an unavailable gap. Empty pages with
a new continuation cursor can advance. Session and connection changes fence late
results; a normal continuous reconnect does not scan history.

This relies on a provider's opaque `before` cursor yielding ordered, contiguous
source pages, preserving source IDs and usable across a same-session reconnect;
an expired cursor must fail explicitly. A page may be empty with a continuation;
`before: null` denotes the end of that provider's range. The existing wire does
not prove these properties or distinguish all remote pending/outcome records from
durable history. The controller excludes locally known pending inputs from its
overlap check, but cross-device unknown pending, retroactive materialization or
provider page order differing from cursor order can still make continuity
unprovable. No persistent coverage ledger, event replay or universal detection
of such gaps is implied.

## Output image references

`ChatMessage.images` in both `view` and `history` preserves every stored reference
in order, for any message role. It has no image-count ceiling: the six-image
intake limit applies to Submission and upload, not saved output.
Each reference still requires the strict `ImageRefSchema` fields; unknown fields
and invalid media IDs/types remain errors. The existing 2 MiB frame and 4 MiB
outgoing queue protections still bound transport; this does not authorize
truncating images or splitting a native message identity.

## Reconstructing a Chat channel

The server channel exposes `getSubscription()` and
`restoreSubscription(checkpoint: unknown): Promise<void>`. `ChatSubscription` is
exactly `{ version: 1, subscriptionId, serviceId: "lamplit.chat.v2", mode: "singleton" }`;
the nonempty ID is bounded to 100 JavaScript characters. Only this identity is
retained, never snapshots, codec state, calls or results. `null` restores an empty
channel; malformed metadata closes the channel.

`connect(socket, authorize, { onSubscriptionChange })` awaits the optional
persistence callback before acknowledging subscribe/unsubscribe. Callback failure
closes the channel without success acknowledgment. Explicit unsubscribe persists
`null`; `close()` only disposes local resources, so a host may detach without
clearing its checkpoint. Metadata getters and callbacks receive detached copies.
Restoration and incoming calls are serialized. Restoration reauthorizes and queues
an existing-protocol reset under the original subscription ID, with a fresh
encoder, before activating subsequent deltas. Every outgoing frame is authorized
again. Close during an await prevents later delivery or subscription resurrection.
The attachment owner must restore before dispatching the waking message; ordinary
business calls are never replayed. This does not require a browser rebuild.

## Demand-driven connection recovery

A healthy idle Chat connection sends no periodic catalogue RPC, ping, or application
probe. The initial subscription and ordinary business calls remain. Readiness means
a validated conversation snapshot and installed update subscription, not socket open.
Silent carrier loss and missed autonomous updates may remain undiscovered until an
actual request, lifecycle recovery, or transport event; recovery obtains a fresh snapshot.

The 10-second opening and 30-second request bounds remain. A history or lookup
deadline rejects only that read; its backend work may still occupy a read slot until
it finishes. Other request deadlines, send failure, close, or error invalidate the
carrier once. Valid business errors reject only their request; caller-context
cancellation does not invalidate the carrier.
A dispatched submission with a lost acknowledgement stays unconfirmed: reconcile
its original operation ID and receipt, never replay submit, stop, or compact.
