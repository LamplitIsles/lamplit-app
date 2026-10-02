# Chat protocol v1

The browser opens a same-origin WebSocket at `/api/chat/socket`. A connection is
an observation/control channel; closing it never means stopping engine execution.
Static assets and future media continue to use HTTP.

`lamplit.chat.v1` is a Chord singleton with:

| Member                          | Meaning                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `view`                          | Replicated main-session identity, recent messages, active turn, cursor and capabilities |
| `history(before)`               | Previous page of completed messages and user submissions                                |
| `submit({ operationId, text })` | New input; the engine adapter starts or steers its native conversation                  |
| `lookup(operationId)`           | Reconcile admission after lost acknowledgement                                          |
| `stop(turnId)`                  | Stop this specific turn; a stale turn returns `stopped: false`                          |

Chord method contracts include an invocation context as their last parameter.
The browser helper supplies it. Socket cancellation is not passed into execution;
the native execution owner handles explicit stop.

## Delivery semantics

A reply is one complete agent message with a stable native identity. A turn can
produce multiple messages. No unfinished text/token deltas enter the public view.
A later failure or stop does not turn unfinished text into a successful message.
Completed messages are retained independently of a turn's final outcome.
Native terminal results are projected as stable notice messages, independently
of assistant text: completed, failed or stopped. A stop before generation must
still produce its stopped outcome.
The browser retains observed messages that leave the bounded live window and
merges them with paged history by stable identity.

Receipts distinguish `accepted`, `consumed`, `unconsumed`, `uncertain`, `missing`, and `rejected`.
Unconsumed means the native owner proves an admitted input was removed before
consumption; it is kept visible and never automatically resubmitted.
Accepted means durable admission, not model-context consumption or completed
execution. Pending user messages can carry delivery state until native consumption
is observed. The native adapters decide these facts; the frontend does not infer
them from HTTP/RPC success.

The operation ID survives reconnect and is distinct from a transport request ID,
a native turn ID and a native message ID. Same operation ID plus same content is
idempotent; different content under the same ID is rejected. The browser persists
unconfirmed submissions per origin/session and queries their outcomes after
reconnect. It offers explicit retry only after a `missing` result, rechecks that
result, and reuses the same operation ID. It does not automatically resend uncertain
operations.

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
