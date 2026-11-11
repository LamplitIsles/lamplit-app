# Native-confirmed message delivery — spec #5706

App owns the public Chat contract. CFL (#5707) and lamplit-chat (#5708) must
implement it using their own execution owner's evidence and the exact approved
App artifact. Passing App fixture tests does not prove native acceptance. No
native acceptance, deployment or production data cleanup is implied here.

## Outcomes and identity

A submitted operation has one stable operation ID and text and/or ordered
attachment references. A correlated `submitted` receipt means the native
execution owner reliably accepted the input. Host storage and a temporary native
queue acknowledgement do not by themselves establish this. A `failed` receipt
means definite failure of that input, not failure of a later companion reply.
Lookup may return either proven outcome or `null` for unknown. A lookup failure
must be provably for the current attempt; when it cannot exclude an old failure,
return `null`. Timeouts, disconnections, missing history and null are unknown.
No request is automatically replayed after an uncertain outcome.

```ts
submit(input: { operationId: UUID; text: string; images?: ImageRef[]; files?: FileRef[] }): Promise<Receipt>
lookup(operationId: UUID): Promise<Receipt | null>
type Receipt = { operationId: UUID; attempt: number; state: "submitted" | "failed";
  messageId: string | null; turnId: string | null; error: string | null }
```

`attempt` is a positive safe integer, starting at 1 for the logical operation.
The native host advances it for each explicit retry after a definite failure;
it never advances because an outcome is unknown. A host with durable source
identity must preserve this sequence across restart. Every submit result, lookup
result and delivery event uses the same current attempt; stale asynchronous
native work must not be published as the current attempt. A result already in
transport can arrive late, so the consumer must compare attempts and its local
retry/connection lifecycle before applying it. A local retry remains fenced until
the current attempt can be associated; the logical operation ID stays unchanged.

The owning socket binds the request to its authenticated session. The shared host
rejects a response from an obsolete session lifetime. The native adapter rechecks
owner and session before handing work to the native execution owner and uses a
pre-commit guard when that owner supports one. Work already handed off may still
complete after authorization is revoked; reconcile its actual or unknown outcome
without replay. Responses and events remain subject to authorization, so a revoked
connection receives neither. Remote revocation and native commit are not assumed
to be atomic. A new message during an active reply continues to steer that turn in
real time.

The frontend owns the failure presentation and explicitly retries or discards a
definitely failed message locally. A retry after submission uses the same
operation ID and content. A file-staging failure before submission can instead
be explicitly retried with a new operation ID while preserving the displayed
logical message, if the necessary originals remain available. Once no send is
in flight, the frontend can also remove an unknown submitted item locally; that
does not mark it failed, resend it or delete native history that may appear later.
The native host must verify owner and session, preserve immutable identity, and
ensure an explicit retry cannot consume an already accepted input again. Any
identity or deduplication capability must be established from actual native
behavior; adding an ID to a DTO does not provide it. The frontend associates
asynchronous results with its local request and session generations.

If stop definitively removes an unprocessed queued message, the host may report
that message failed. If the failure cannot be proven or recovered after a lost
response, it remains unknown. Native hosts must report their evidence and gaps;
the public contract does not prescribe a history representation or infer failure
from missing entries. Hosts emit a scoped `deliveryResult` change for definite
results even when the view does not change, without idle polling. Events are not
durable; after a missed event or reconnect the client uses `lookup`.

## Acceptance

`bun test tests/native-confirmed-delivery.test.ts` uses the actual App socket host
and client with isolated in-memory fixture state. It exercises accepted, failed,
unknown, explicit retry, stop, source correlation, authentication and session
lifetime; the fixture is not a native adapter. CFL and Pi must separately test
native acceptance, identity, owner/session boundaries, lost responses, stop,
concurrent consumption and attachment ownership against their real execution
seams and an attributable App artifact. Existing production data is out of scope.
