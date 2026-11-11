# Image sending and message delivery

Framework7 presentation references below describe the historical baseline
before the spec #108 migration.

Spec #3096 owns this app contract. The public root exports the TypeBox schemas,
DTO types, `validateUpload`, `mediaUrl`, `UPLOAD_PATH`, and
`MAX_UPLOAD_BODY_BYTES`; `/server` exports `imageHttp` and `ImageBackend`. Both
native adapters consume the same compiled package and browser archive.

## Public DTOs and endpoints

`view.capabilities.images` is `false` when storage is unavailable, otherwise:
`{ mediaTypes, maxImagesPerMessage, maxImageBytes, maxMessageImageBytes }`.
Allowed types are PNG, JPEG, WebP and GIF. Pi advertises six images, 8,000,000
original bytes each and 24,000,000 original bytes per operation; CFL advertises
five, 5,242,880 and 20,971,520. Public maxima permit both; hosts enforce their own
advertised limits and native storage constraints. Invalid selection leaves text
usable. Browser preparation preserves original bytes and creates JPEG preview
(480px maximum side / 160,000 bytes) and model (1200px / 320,000 bytes) variants.

`POST /api/chat/images`, JSON, same-origin credentials and Origin header:

```ts
{
  sessionId: string;
  operationId: UUID;
  images: Array<{
    id: string; order: number; name: string; mediaType: ImageMediaType;
    original: string; preview: string; model: string; // base64 only here
  }>;
}
// Result
{ sessionId: string; operationId: UUID;
  images: Array<{ id: string; order: number; ref: ImageRef }> }
// ImageRef (all fields required)
{ attachmentId: string; name: string; mediaType: ImageMediaType;
  availability: "available" | "missing" }
```

IDs use `[A-Za-z0-9_-]`, at most 100 characters; filenames at most 200; count at
most six; order is contiguous from zero and IDs unique. Upload JSON has a
36,000,000 UTF-8 byte ceiling, including streamed/chunked requests. Strict base64,
decoded byte bounds and PNG/JPEG/WebP/GIF signatures are checked by the common
validator. Native adapters retain their existing storage checks, including CFL's
160-character filename bound; no additional decoder or image-processing dependency
is required.
Each result echoes the corresponding request draft ID and order. Validate session,
operation, count, order, unique draft IDs, unique returned attachment IDs and
each reference before associating a local preview. Equal names or media types
are never identity evidence. The controller keeps validated preview associations
in memory until the UI explicitly releases them or the session/client closes;
pending local previews remain available before upload completes.
`ChatController.localPreviews` exposes `sessionId`, `operationId`, `draftId`,
`order`, `attachmentId` and `previewUrl`; after the pending record is retired,
the UI calls `releasePreviews(sessionId, operationId)` when it no longer needs
those previews. When switching sessions in the same page, retain undispatched
local attachment originals, previews and their retirement ownership for their
originating authorized session; do not expose them in another session. Returning
retains the failed pending input; a pre-dispatch file failure can be retried with
a new operation ID while the required originals remain available. Otherwise the
user deletes the failed message and reselects the attachments. A controller close,
authorization loss, observation or confirmed deletion releases that ownership.
Page-wide retained attachment operations and unsettled preparations are limited
to 20; further attachment sends wait for an item to be resolved or deleted,
or for cancellation of an earlier preparation to settle.
An explicit retry after a definite submitted failure retains the operation ID and
ordered attachment references. A file-staging retry before submission uses a new
operation ID but keeps the displayed logical message. Use `validateUpload` and
`validateSubmission`; the native host
checks owner/session and attachment ownership at its admission boundary.

`GET /api/chat/media/{attachmentId}/{original|preview|model}` returns authorized
image bytes, with a finite 32 MiB original read ceiling independent of intake
limits and unchanged 160,000/320,000-byte preview/model ceilings. Successful
responses have `private, max-age=2592000`, `nosniff`, and a strong ETag of the
actual bytes, variant and MIME type. A private cache may reuse a fresh response
for 30 days without contacting the server; it may also evict it at any time.
When a request reaches the server, including after expiration or an explicit
revalidation, it reads the media, applies the existing size and MIME checks, and
rechecks authorization and session before returning 304. Those checks do not
decode the image or establish that its bytes are undamaged. Missing media,
invalid size or MIME, and authorization failures cannot return 304. Upload
responses and errors remain `no-store`. Fresh cached bytes can remain usable
after deletion, revocation, or an account switch in the same browser; `private`
does not isolate accounts or encrypt cached bytes. No arbitrary
URLs, local paths or image data enter WS history/localStorage. Media ownership is
resolved from the authenticated current owner/session, independently of opaque ID
knowledge. `imageHttp` handles parsing/bounds/origin/response validation; the
injected authorization function must authenticate every request, and the backend
must verify attachment ownership and immutable operation bindings. Revalidate
owner/session at the durable storage boundary if authentication changes while
reading a request. A request reaching the server preserves the existing GET access boundary;
it does not independently establish the native backend's session isolation.
GET can remain available for previously stored media when new uploads are disabled;
custom native routing may implement that distinction.

`submit` includes the logical operation ID, text and optional ordered image and
file references. It rejects empty input and unavailable or duplicate attachment
references. Upload alone does not establish native acceptance; it associates the
bytes with the owner, session and operation. The native adapter verifies that
association before submitting and supplies reliable acceptance or definite failure.

## Message and attachment behavior

A send immediately displays the outgoing message and local previews. Definite
failure remains on the originating frontend for explicit retry or local discard.
A definite failure after submission retries the same operation ID and payload;
staged references can be reused only while valid under the native owner/session
and upload lifecycle. Before submission, explicit retry of failed file staging
uses a new operation ID and keeps the displayed logical message if the required
originals remain available. After reload, unavailable originals require deletion
and reselection. Unknown results are never automatically replayed; once no send
is in flight, the pending item can be removed locally without marking it failed or
deleting native history, which can still appear later.
Reply failure or stop does not revoke an accepted input. If stop definitely removes
a queued input before acceptance, the host can report that input failed; absent
proof remains unknown. See [native delivery](native-durable-submissions.md) and the
[file contract](chat-file-contract.md).

# Design authority update — 2026-10-03

The former Composer/attachment mockup requirements are superseded. CFL's existing Framework7 UI is the shared frontend baseline; see [current direction](ui-baseline-and-compaction.md). The earlier 96px acceptance described the historical image slice, not a continuing requirement. Spec #3119 restored native CFL presentation and replaced the superseded sizing/wrapping assertions; image sending, safe recovery and route teardown remain required. See [quiet compaction handoff](quiet-compaction.md) for the native behavior; use the complete default handoff for current artifacts.

## Browser image selection and historical native gallery evidence

The App uses browser file inputs for photos and camera selection. Selected files
are validated as a complete batch against current image limits before drafts are
added. Upload retains original bytes alongside the existing JPEG preview/model
variants. Picker results are scoped to the session and selection generation;
a session change, including A → B → A, or disposal invalidates late results.
The iPhone system source menu is browser behavior and is not a Capacitor adapter.

The 2026-10-06 Pixel WebView read investigation and earlier native plugin tests
are historical evidence for the removed Capacitor path, not validation of the
current browser selection. `bun test tests/image-drafts.test.ts` checks batch
limits; `bun tests/file-attachments-browser.mjs` checks browser photo/camera and
file selection, including stale session results. `bun run test:images-browser`
checks image upload behavior, subject to any separately reported failures.
Physical device picker behavior requires device verification.

## Saved output cardinality — spec #4011

Saved message references are independent of the six-image input/upload
limit. A reply with 7 or 11 generated images retains its full ordered reference
list through initial View, history and the existing gallery renderer. Per-item
reference validation, media authorization and transport bounds still apply.
After building, `APP_OUTPUT_IMAGE_CARDINALITY=1 bun tests/images-browser.mjs`
runs the focused owned-fixture initial/history/connection and six-image composer
guard checks, saving screenshots and reference identities under
`APP_ACCEPTANCE_EVIDENCE`. This is App fixture evidence; CFL's exact native
consumer regression remains a separate #4010 acceptance gate.
