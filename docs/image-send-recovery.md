# Image sending and submitted-input recovery

Spec #3096 owns this app contract. The public root exports the TypeBox schemas,
DTO types, `validateUpload`, `validateRecovery`, `mediaUrl`, `UPLOAD_PATH`, and
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
{ sessionId: string; operationId: UUID; images: ImageRef[] }
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
Use `validateUpload`, `validateSubmission` and `validateRecovery`, not schemas alone. The host can enforce smaller native
request bounds, provided its advertised supported images can fit.

`GET /api/chat/media/{attachmentId}/{original|preview|model}` returns authorized
image bytes, with a finite 32 MiB original read ceiling independent of intake
limits and unchanged 160,000/320,000-byte preview/model ceilings, `no-store`, `nosniff`, or a visible 404 for missing bytes. No arbitrary
URLs, local paths or image data enter WS history/localStorage. Media ownership is
resolved from the authenticated current owner/session, independently of opaque ID
knowledge. `imageHttp` handles parsing/bounds/origin/response validation; the
injected authorization function must authenticate every request, and the backend
must verify attachment ownership and immutable operation bindings. Revalidate
owner/session at the durable storage boundary if authentication changes while
reading a request. GET can remain available for previously stored media when new
uploads are disabled; custom native routing may implement that distinction.

`submit` is `{ operationId: UUID, text: string, images?: ImageRef[],
replacementSourceIds?: string[] }`. Text is at most 16,000 UTF-16 units; empty text
is allowed with images. Empty text plus empty images is rejected. Ordered references and replacement
IDs are part of immutable identity. Upload success never admits input. Same ID and
same full payload reconciles without execution; changed payload conflicts. The
native adapter rejects refs not uploaded under this owner/session/operation and
performs eligibility checking plus replacement atomically with admission. It must
check current durable state, the portable WS host validates payloads and correlated receipts, while the native adapter owns atomic eligibility.

`view.recovery` is a bounded array (at most 20) of:

```ts
{ sourceId: string; operationId: UUID; text: string; images: ImageRef[];
  state: "rejected" | "unconsumed" | "uncertain";
  replacementEligible: boolean }
```

This is authoritative native submitted input, including native frontend inputs.
Only verified rejected/unconsumed sources may be replacement eligible; uncertain
sources never are. Use `validateRecovery`. Consumed/replaced sources disappear
from native recovery and cannot reappear on reconnect. Receipts retain existing
accepted/consumed/unconsumed/uncertain/missing/rejected semantics; socket loss or
turn completion never proves non-consumption. Recent/paginated `messages.images`
projects only actual native message membership, including completed agent images;
workspace files and staged uploads alone are not chat or album membership.

## User behavior

Choose gallery photos, paste images or hold the attachment button to take a photo. Attachments use
the pinned CFL Framework7 presentation: a horizontal row of 72px squares with
44px removal targets and native preview/gallery behavior. Images can be sent alone.
Online send immediately shows normal-color text and local image previews while
the composer clears, before preparation/upload; no sending/receipt/consumption
labels or success toast appear. Offline clicks keep editable text/images.
Preparation/upload failure or rejection without durable admission withdraws the echo and merges
text/Files with newer drafts in the originating session. Settled missing lookup
is rechecked before rollback; generic RPC error/disconnect never proves failure.
A receipt with a messageId proves durable admission, including a first rejected receipt
or rejected lookup after a lost acknowledgement. Native execution failure keeps the
normal echo and offers explicit human recovery; accepted/native-observed input survives
stale missing/error. Durable recovery replaces its own admitted operation, not the sources
that operation previously replaced. Submitting an intentionally restored local pending
draft retires that local record even when the draft also carries native replacement sources.
Page-owned previews live until observation/rollback and never enter storage. Only
bounded reference-only pending metadata is saved once upload finishes; storage
failure is visible. Reloaded nonadmitted input uses the existing restore-to-edit
panel and authorized originals, without overwriting current drafts. It has no
native replacement source unless one was already verified. A later explicit send
creates a new operation; unknown input only looks up its exact existing identity.

Recovery offers inspect, restore to edit, and dismiss. Restore is disabled while
current text/images are present; it cannot overwrite new edits. Original bytes are
rehydrated over authorized HTTP. Missing originals leave editable text and block
send until the user explicitly removes missing images or selects replacements.
Edited recovery sends with a new operation ID and verified replacement source ID.
Native state is checked again before send. Dismiss hides a recovery offer for this
page/session only; it does not consume or delete native input. Clearing all restored
text/images returns its offer. Explicitly discarding restored input dismisses that
page-local offer and exposes the next source without changing native consumption. Unsent composer
persistence and generic attachments are outside this feature.

## Current verification and native handoff

Spec #3096 completed same-artifact native Pi/CFL acceptance, including exact image
bytes and corrected route lifecycle, and merged (App PR #4, Pi #24, CFL #64).
Historical ebde803 product/091c0def runner archives remain unchanged evidence.
Use the [complete default handoff](default-shared-frontend.md) for current full
checks, one committed-source archive, extraction/hash checks and Owner approval.
The current unchanged image runner uses canonical `/` (hosted `/chat`) with native
public HTTP/WS, test-owned stores and fake engines. It still denies anonymous media.

From the extracted `acceptance/`, after approved native fixtures start:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/image-send-recovery \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/images bun images-browser.mjs
bun route-lifecycle-browser.mjs
```

The control endpoint is **test infrastructure only**, never production routing.
Implement it against native storage/execution, not an alternative mock chat adapter.
It accepts JSON POST actions matching `tests/images-fixture.ts`:

| Action                                                  | Required native fixture effect                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `reset`                                                 | Clear only this fixture's session/media/receipts; reset fake execution count; expose native limits.             |
| `mode`, `state: consumed/unconsumed/rejected/uncertain` | Configure fake native admission/consumption outcome for the next inputs. Do not infer state from WS disconnect. |
| `uploadFailure`, `enabled`                              | Fail/restore native storage before admission.                                                                   |
| `disabled`, `enabled`                                   | Advertise unavailable/available image intake, retaining text.                                                   |
| `complete`                                              | Complete current fake turn with text `完整图片回复` and native-generated image membership.                      |
| `history`                                               | Seed 32 complete text replies after current image messages, forcing pagination.                                 |
| `nativeRecovery`                                        | Seed verified native-origin unconsumed input `原生恢复输入` and `native.png` original.                          |
| `missing`                                               | Remove originals referenced by current fixture recovery only.                                                   |
| `consume`                                               | Mark fixture recovery consumed, update delivery/receipts, clear recovery durably.                               |
| `state`                                                 | Read state without mutation.                                                                                    |

Every control result returns `{ executions, submissions, recovery, messages, limits,
album }`; submissions are actual admitted immutable public DTOs, album includes
actual native membership and provenance. Execution counts must represent native
fake execution rather than upload/RPC counts. The runner requests anonymous media
without owner credentials and requires denial. Native authenticated session IDs
need not equal the local fixture's ID: the runner captures real upload identity.
Numeric intake limits are read from native capabilities; assertions for safe
identity, ownership, recovery, history, replacement and no replay are fixed.
The existing text/voice/panel runners remain additional regression checks.
New exact-artifact Pi and CFL reports remain the Owner's joint acceptance gate
for #3162; prior acceptance does not prove the new canonical routes. No deployment.

The delayed-media and delayed-upload probes release their held requests and await
`page.unrouteAll({ behavior: "wait" })` before advancing. Ordinary `unroute` does
not await handlers and can race a later fulfillment. No route exceptions are
suppressed; a genuine handler failure still fails the acceptance process.

# Design authority update — 2026-10-03

The former Composer/attachment mockup requirements are superseded. CFL's existing Framework7 UI is the shared frontend baseline; see [current direction](ui-baseline-and-compaction.md). The earlier 96px acceptance described the historical image slice, not a continuing requirement. Spec #3119 restored native CFL presentation and replaced the superseded sizing/wrapping assertions; image sending, safe recovery and route teardown remain required. See [quiet compaction handoff](quiet-compaction.md) for the native behavior; use the complete default handoff for current artifacts.

## Native gallery read boundary

Native hosts with the Camera plugin use installed Capacitor Camera 8.2.3
`chooseFromGallery` with `MediaTypeSelection.Photo`, multiple selection,
metadata, and the remaining image count. Web hosts keep the HTML file input.
A native picker/API/read failure uses the existing composer error panel and
camera failure announcement; it never falls back to the HTML input. Only
`CameraErrorCode.ChooseMediaCancelled` is silent. A full composer does not open
the picker, because a zero limit means unlimited in the plugin API.

The app fetches each result's `webPath` through the native content route and
constructs a memory-backed File from the returned bytes before allocating draft
previews. It uses the response MIME or supported plugin `metadata.format` and
accepts the existing PNG/JPEG/WebP/GIF formats; unsupported originals such as
HEIC are rejected, not relabeled or converted. No thumbnail is used as the
original, and the app requests no quality, resizing or editing transformation.
Existing upload preparation retains those bytes as `original` and separately
makes the established JPEG preview/model variants.

Picker limits are a hint; the complete returned batch is validated against the
current drafts and current advertised format/count/per-file/aggregate limits.
Order is the plugin's returned order, even when reads complete out of order.
A read or validation failure adds no partial batch. Picker/capture, mic start,
restore-to-edit and send cannot overlap an active native selection. Session
changes (including A → B → A) and component disposal invalidate pending results
and errors; no stale result can enter a later composer. Existing submission and
recovery ownership continue to apply. `NotReadableError` during preparation
shows an actionable retry/reselect message and uses existing pre-admission
restoration; no automatic retry is introduced.

The 2026-10-06 Pixel evidence reproduced a 248,633-byte PNG File read failure
three times, with preview-Blob `ERR_UPLOAD_FILE_CHANGED`, while the same selected
URI read successfully through Capacitor's native content route and decoded from
a memory File three times. The URI read grant remained present. This establishes
the WebView File/Blob read boundary, not the exact internal provider metadata
cause, permission revocation, or screenshot modification.

Native source review checked `IonCameraFlow.getGallerySettings`,
`processResultFromGallery`, and `handleGalleryMediaResults` in the installed
plugin, plus the official
[ioncamera-android 1.0.2 sources](https://repo.maven.apache.org/maven2/io/ionic/libs/ioncamera-android/1.0.2/ioncamera-android-1.0.2-sources.jar).
The Android normal, non-edited gallery path calls
`onChooseFromGalleryResult`: it retains a real path or copies the provider input
stream into a cache file, and `createImageMediaResult` generates a separate
thumbnail while returning that file path. The wrapper derives `webPath` from
that URI. Its `DEFAULT_QUALITY=90` differs from the types' documented default,
but quality/resize/orientation settings are not passed to this normal result
path. This source review supports avoiding original-file reencoding on that
Android path; it is not physical end-to-end validation of an installed plugin
or a guarantee for all providers/iOS. Plugin-side omission or ordering occurs
before the app receives a result and cannot be inferred from the result alone.

`bun test tests/native-gallery.test.ts` checks plugin options, cancellations,
returned bytes/MIME, unsupported formats, failed reads, and atomic current limits.
After `bun run build`, `bun tests/native-gallery-browser.mjs` drives the real
composer and mocked native plugin with owned 1080×2400 PNG responses. It checks
ordered exact returned bytes through upload, remaining/full limits, cancellation,
no fallback on failure, busy controls during held reads, pre-admission read-error
restoration, native recovery, and stale session results. These fixtures prove the
JavaScript boundary preserves plugin-returned bytes; they do not prove source
file identity inside the native plugin. Existing `bun run test:images-browser`
checks the web input, Framework7 sizes, submission and recovery at 390/1280/320.
No device, gallery, live chat, install/config/permission, merge or deployment
operations are part of these checks. This change supersedes closed, unmerged
App PR #13 and has no dependency on that branch.
