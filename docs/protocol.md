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

| Member                                                          | Meaning                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `view`                                                          | Replicated main-session identity, recent messages, active turn, cursor and capabilities |
| `history(before)`                                               | Previous page of completed messages and user submissions                                |
| `submit({ operationId, text, images?, replacementSourceIds? })` | New input; the engine adapter starts or steers its native conversation                  |
| `lookup(operationId)`                                           | Reconcile admission after lost acknowledgement                                          |
| `compact({ sessionId })`                                        | Explicit native idle compaction; refusal preserves drafts, success has no chat message  |
| `stop(turnId)`                                                  | Stop this specific turn; a stale turn returns `stopped: false`                          |

Chord method contracts include an invocation context as their last parameter.
The browser helper supplies it. Socket cancellation is not passed into execution;
the native execution owner handles explicit stop.

## Optional assistant thinking

`ChatMessage.thinking?: string` carries actual assistant thinking block strings,
joined in original block order with `\n`. `text` remains the independent answer.
Omit thinking when absent; do not infer it from ordinary text or export signatures,
private prompts or tool arguments. The optional field leaves protocol v2 unchanged;
CFL can omit it. Search previews retain their existing text-only schema.
Thinking does not alter completion/failure/stop semantics or make thinking-only
and tool-call-only entries successful answers. See [UI and acceptance](collapsed-thinking.md).

## Delivery semantics

A reply is one complete agent message with a stable native identity. A turn can
produce multiple messages. No unfinished text/token deltas enter the public view.
A later failure or stop does not turn unfinished text into a successful message.
Completed messages are retained independently of a turn's final outcome.
Successful completion clears the active turn without adding a chat notice.
Failed and stopped results remain stable notice messages, independently of
assistant text. A stop before generation must still produce its stopped outcome.
Online sends appear immediately as normal-color outgoing bubbles, before image
preparation/upload or receipt. No delivery labels or success toast are shown.
Offline submission is blocked and leaves the draft editable. The App tracks only
`sending`, `sent`, and `failed`; these are local UI states, not engine persistence.
A `submitted` receipt retains the local echo until a persisted user message with
its operation ID appears. Observation wins over late errors. Replies failing or
stopping do not change submission success and never produce input recovery.

```ts
Receipt = { operationId: string; state: "submitted" | "failed";
  messageId: string | null; turnId: string | null; error: string | null }
submit(input: Submission): Promise<Receipt>
lookup(operationId: string): Promise<Receipt | null>
```

`submitted` proves durable reception; `failed` proves the input was not received.
The receipt is about submission, not model consumption or execution. Lookup
returns `null` when there is currently no definitive result. Repeated nulls,
timeouts, RPC errors and disconnection do not prove failure and cannot authorize
restoration or replacement. They retain the pending bubble and original identity
for reconciliation on reload/reconnect. The App never automatically replays input.

Same operation ID and identical text, ordered image references and replacement
source IDs deduplicate. Changing content under that ID must be rejected. This
identity is distinct from socket request, native turn and message identities.
Only definitively failed submissions or inputs explicitly withdrawn before
processing belong in `view.recovery`; its entries have no delivery state.
A withdrawn input retains a `submitted` receipt and can remain visible in history.
Replacement eligibility is authoritative and checked atomically by the native
adapter. Reply execution failures belong in timeline notices, not recovery.

The browser persists bounded reference-only pending inputs per origin/session.
It retains observed messages evicted from the live window and merges paged history
by message identity. Local old pending records are normalized once to the three
UI states without dropping text, images or operation IDs; unknown outcomes remain
sending and recorded admission remains sent. No old wire DTOs are accepted.

The view is version 2 and the Chord service is `lamplit.chat.v2`. This is the PWA
cutover boundary: an old page cannot subscribe to the new service or silently
accept the new view. Reload/update to the matching built frontend is required;
there is no negotiation or old-wire fallback. The transport envelope remains v1.

## Frames and validation

Calls use `{ type: "call", version: 1, id, call }`, where `call` is Chord's own
service-call grammar. Replies are `result` or `error`; subscriptions emit `update`
frames keyed by subscription ID. The wrapper handles framing and correlation,
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

## Streaming voice input

Voice is separate from Chord. The authenticated same-origin
`GET /api/voice/capability` returns exactly `{ available: boolean }`. This endpoint
is the authority for recording availability; the chat snapshot has no `voice`
capability field. Failed or invalid capability responses disable recording while
text chat stays usable. Recheck on app mount; the stream must also enforce current
authorization and speech availability rather than trusting a prior capability GET.

`/api/voice/stream` opens one transient recognition take per WebSocket. The host
sends `{ type: "ready" }` after speech setup. Only then does capture start. Audio is
binary signed PCM16 little-endian mono at actual 16,000 Hz: at most 300 seconds,
9,600,000 raw bytes, 16 KiB per nonempty even-length frame. The client bounds its
queued WebSocket output at 256 KiB and emits 100 ms frames (3,200 bytes). It requests
16 kHz from AudioContext and checks the actual rate; unsupported rates fail cleanly
without an application resampler or batch fallback.

Controls are strictly `{ type: "finish" }` or `{ type: "cancel" }`, at most 128
UTF-8 bytes. Finish follows the worklet's final partial PCM frame and flush
acknowledgement. The host then finishes the provider task. Cancel/disconnect
releases capture and provider resources. No audio enters chat replication,
attachments, persistent storage or model execution.

Server events are strictly `ready`, `{ type: "result", text }` or
`{ type: "error", code }`, at most 128 KiB UTF-8. Result requires nonblank finalized
text, at most 20,000 Unicode code points. Preserve these error codes:
`voice_disabled`, `config_unavailable`, `invalid_key`, `rate_limited`,
`upstream_error`, `timeout`, `cancelled`, `invalid_audio`, `transcript_invalid`.
Unknown properties/types/codes and invalid audio bounds are rejected by the public
`@lamplit/contracts/voice` validators. Hosts additionally enforce lifecycle order,
authorization, setup/finish timeouts and provider semantics.

The Qwen relay stores final sentences by positive sentence ID, replaces duplicate
finals and orders IDs before joining text. Interim updates are hidden and cannot
reopen a finalized sentence. Finish succeeds only with finalized, valid sentences
and no outstanding unfinished sentences. Backend adapters own this aggregation.

Only the final result, after finish, replaces the composer's saved selection. It
remains an editable draft until explicit send. Cancel, session change, disposal,
disconnect and a changed draft invalidate old results. Chat send still uses its
16,000 UTF-16-unit trimmed-text limit; a longer transcript remains editable, with
send disabled until shortened. No automatic send, interim preview or reply TTS.

## Companion panels

The same service now includes six bounded, validated read methods; see
[companion-panels](companion-panels.md) for exact request/response fields, native
adapter responsibilities and frozen acceptance commands. Reminder provenance is
persisted in the optional message `source` field. No panel reads use CFL-only JSON
endpoints, and image bytes remain on authenticated same-origin HTTP.

## Images and submitted-input recovery

The public [image contract](image-send-recovery.md) defines bounded authenticated
HTTP upload/media, original plus JPEG variants, `messages.images`, host-advertised
image limits and authoritative `view.recovery`. Submission identity includes ordered
references and explicit replacement source IDs. Upload is not admission; recovery
eligibility is native authority; a null lookup cannot authorize replacement.
Image data is never replicated over WS or stored in pending metadata.

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
