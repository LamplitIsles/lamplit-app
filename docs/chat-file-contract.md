# Chat file contract (FlickNote #50)

The shared contracts package defines independent file references. `ChatView.capabilities.files`
is optional: absence or `false` means file intake is unavailable. A supporting host advertises
`{ maxFilesPerMessage, maxFileBytes, maxMessageFileBytes }`, bounded respectively by 6,
100,000,000 and 200,000,000 bytes. Empty files are valid; neither file suffix nor media type is
an allowlist. These limits are independent of image limits. Hosts must enforce their advertised
limits again when admitting a submission. Existing hosts may omit the capability and all file fields.

`FileRef` is `{ attachmentId, name, mediaType, size, availability }`. `name` and `mediaType`
are untrusted metadata, never storage paths, HTTP headers, markup or instructions. Names have
1–200 Unicode code points; media types may be empty and have at most 255 code points. File IDs
use the existing opaque media ID syntax. `availability` is `available` or `missing`. Files are
ordered separately from images and are not image library members. `Submission.files`,
`ChatMessage.files`, and `InputRecovery.files` are optional arrays; the latter remains present
only when the backend supplies file references. File-only and mixed messages are valid.
Submission references must be available, unique and within the global limits; host admission
must additionally check current capability, ownership, session, immutable staging provenance,
aggregate limits and replacement eligibility. History and recovery may indicate missing files.

## HTTP and staging

Files use the streaming operation protocol below. There is no JSON or Base64 file upload endpoint.

`GET /api/chat/files/<attachmentId>` returns only owner/session-authorized bytes, or 404 for
missing content. `fileHttp` and `FileBackend` are exported from `@lamplit/contracts/server`;
mount before static assets. The authorization callback supplies a stable opaque `ownerId`,
`sessionId`, and current limits (or false), and is rechecked during each request. Backend
methods receive both identities and must enforce ownership at storage lookup and commit, even
if access changes during asynchronous work. The helper rejects identity changes before returning
content. A supporting backend must not treat possession of an ID as authorization.

Responses use `private, no-store`, `nosniff`, a sandbox CSP and, for bytes,
`application/octet-stream` with `Content-Disposition: attachment` and no filename parameter.
The untrusted name never enters headers. A client that offers a named download uses the
same-origin authenticated download URL and the name only as a safely handled local suggestion.
The App uses the browser download manager so file bytes do not need to accumulate in JavaScript.
Download selection is independent of upload capability, including when file intake is disabled.

## Streaming operations (v2)

`POST /api/chat/file-operations` reserves `{ sessionId, operationId, files: [{ id, name, mediaType, size }] }`; array order is authoritative. The authenticated same-origin request uses `application/json`, at most 32,768 bytes. A reservation is immutable and scoped to owner, session and operation. The response is `{ manifest: <same manifest>, uploaded: [<file id>, ...], result?: <upload result> }`. `GET /api/chat/file-operations/<operationId>` returns that status or 404 for a missing reservation. Status inspection remains available when the current file capability is disabled or its limits are reduced: the authenticated owner and session are rechecked before the response, and the stored manifest is validated against protocol-wide maxima (six files, 100,000,000 bytes per file, 200,000,000 bytes total), not current intake limits. Scoped retired operations still return 410; unknown or other-scope operations remain 404 or an authorization error. Reserve, upload and complete continue to enforce current capability and limits, including at commit. `uploaded` contains only fully verified files, and `result` appears only after completion. For a fresh attempt the App requires the returned manifest to match exactly, `uploaded` to be empty and `result` to be absent. The App does not inspect or resume an earlier reservation: a failed or uncertain reservation, upload or completion fails that attempt without further staging requests. The status endpoint remains available to hosts; neither staging nor status admits or automatically resends a message.

A host may reclaim an abandoned reservation only after permanently fencing its operation ID.
For a matching authenticated owner and session, a retired operation returns HTTP 410 on
reservation, status, file upload or completion, including a retirement race, with exactly:

```json
{"error":{"code":"file_operation_retired","message":"File operation retired; start a new attempt explicitly."}}
```

Unknown or other-scope operations return 404 or an authorization error, never a retirement
signal. The backend signals a scoped retired operation by throwing `FileOperationRetiredError`
from `reserve`, `status`, `receive` or `complete`; for a missing or other-scope operation,
`status` returns null and mutation methods may throw `FileOperationNotFoundError`. A reservation
for a fresh ID still creates it; a cross-scope ID must not be created or disclosed. Both are
exported by `@lamplit/contracts/server` and `@lamplit/contracts`. The adapter rechecks the
owner and session before returning either scoped response. The backend must retain the fence
across restarts and prevent stale uploads or completion from reviving retired IDs. Reclamation
must not delete admitted or otherwise retained user data.

Any staging failure, including HTTP 410 or an unknown response, is terminal for that attempt.
The client preserves the failed input and available page-owned originals; an explicit retry
creates a new operation only when the user requests it. After reload, files must be reselected.
If message admission is uncertain, its original durable identity is looked up or finalized
and is never automatically resubmitted.

`PUT /api/chat/file-operations/<operationId>/files/<id>` sends the raw bytes as `application/octet-stream` and returns 204. Exactly the declared number of bytes, including zero, must be consumed. `POST /api/chat/file-operations/<operationId>/complete` returns the existing `{ sessionId, operationId, files: [{ id, order, ref }] }` shape only after all files have been verified. IDs, metadata, order and unique available refs are checked. Mutations require an exact same-origin `Origin`; all routes require authentication. Mount `fileStreamHttp` before `fileHttp` and static assets. `FileStreamBackend` supplies `reserve`, `status`, `receive`, and `complete`; each mutation calls its `check()` immediately before atomic publication. The adapter bounds manifest and streamed byte counts and propagates backpressure. The host must incrementally hash every received stream, compare duplicate bytes and metadata, reject conflicts, enforce scoped access and resource/concurrency limits, atomically publish without overwriting, recheck authorization/session/capability at commit, and clean only operation-owned temporary resources. The adapter itself is not durable storage and does not supply a hash or atomicity.

For download, `FileBackend.fileStream` returns `{ body: ReadableStream<Uint8Array>, size }` for authorized exact-size bytes; `fileHttp` enforces the 100 MB ceiling and checks identity during streaming. Direct browser downloads may use the authenticated same-origin download URL so bytes flow to the browser download manager; the browser may use the anchor’s `download` filename; Chrome 156 was verified in isolation, while Safari and real devices require acceptance. Names remain untrusted local suggestions and must never enter response headers. Restoring input to the composer restores text only; images and files must be selected again.

When file capability is enabled, clients use this streaming protocol for every file, regardless
of the advertised limits. Absent or false capability disables file intake. Old clients, old
service attachment APIs and files uploaded by old services are outside this contract. Existing
non-attachment data must be preserved. Publish the shared contract and verify its actual version
before CFL pins it; deployment and native acceptance remain separate.

## Durable submission and retry

The existing operation, lookup and finalization rules in [native durable submissions](native-durable-submissions.md)
apply to the entire ordered text/image/file payload. Unknown admission is inspected or finalized;
never replay it automatically. An explicitly retried failed submission gets a new operation ID.
Its receipt carries `retryFiles: { sessionId, sourceOperationId, files: [{ sourceAttachmentId,
ref }] }`, with a one-to-one mapping to the original file references. The names, types and sizes
must match the source, and the host must bind mapped references to the original bytes and
provenance. Image mapping remains independent. Mismatched or absent mappings cannot be treated
as success. A reload before staging completes loses browser File objects; the local failed input
retains metadata and requires the user to delete and reselect files. Dispatched references and
uncertain outcomes remain durable local pending state and are checked, not resent.

Explicit recovery to the composer restores text only, without fetching or restoring image or
file originals. A person who wants attachments in the replacement selects and uploads them
again. The source remains subject to the existing replacement-eligibility checks. This is
separate from explicit failed-message retry, which retains the existing original-file and
retry-mapping behavior.

The App’s `createFileDrafts`, `fileIntakeError`, and `streamFileUploads` are in
`apps/web/src/lib/file-upload.ts`. `ChatController.send` accepts file
drafts as its seventh argument after the existing sticker argument; pending items expose
`fileDrafts` metadata and, after staging, `files`. Use the current view capability for intake,
preserve draft ownership until retirement, and resolve session changes before using async results.
Use `fileDownloadUrl` only for opaque validated IDs. `tests/files-fixture.ts` is an isolated fake
host adapter, not a production backend. CFL must consume a real published App contract/artifact
and independently validate its storage and native integration.

The current controller's pending localStorage key uses only `sessionId`; the
shared protocol does not guarantee that different owners have distinct IDs.
CFL currently authenticates a single fixed owner and uses the Partner thread ID
as its session ID, so normal CFL account switching does not introduce a second
owner into that cache. A future multi-owner host must define an authenticated
identity scope and isolate this cache before enabling files. HTTP and backend
storage/admission must independently enforce owner and session on every access.
