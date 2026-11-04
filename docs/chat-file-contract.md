# Chat file contract (FlickNote #50)

The shared contracts package defines independent file references. `ChatView.capabilities.files`
is optional: absence or `false` means file intake is unavailable. A supporting host advertises
`{ maxFilesPerMessage, maxFileBytes, maxMessageFileBytes }`, bounded respectively by 6,
8,000,000 and 24,000,000 bytes. Empty files are valid; neither file suffix nor media type is
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

`POST /api/chat/files` requires same-origin credentials, an exact same-origin `Origin`, and
`application/json`. `FileUpload` is `{ sessionId, operationId, files: [{ id, order, name,
mediaType, size, data }] }`; `data` is canonical base64 of original bytes, including `""` for
an empty file. The response is `{ sessionId, operationId, files: [{ id, order, ref }] }`.
IDs, order and metadata must match the request. The body ceiling is 33,000,000 bytes;
streaming reads enforce it even without Content-Length. Operation identity and the complete
ordered payload are immutable: identical retries return the same references, changed data
conflicts. Upload stages only, it never admits a chat message.

`GET /api/chat/files/<attachmentId>` returns only owner/session-authorized bytes, or 404 for
missing content. `fileHttp` and `FileBackend` are exported from `@lamplit/contracts/server`;
mount before static assets. The authorization callback supplies a stable opaque `ownerId`,
`sessionId`, and current limits (or false), and is rechecked during each request. Backend
methods receive both identities and must enforce ownership at storage lookup and commit, even
if access changes during asynchronous work. The helper rejects identity changes before returning
content. A supporting backend must not treat possession of an ID as authorization.

Responses use `private, no-store`, `nosniff`, a sandbox CSP and, for bytes,
`application/octet-stream` with a fixed `Content-Disposition: attachment; filename="download"`.
The untrusted name never enters headers. A client that offers a named download must fetch with
same-origin credentials and use the name only as a safely handled local download suggestion;
never navigate to or render a blob as same-origin active content. `restoreFileDraft` fetches
bytes for explicit recovery, checks the current session and size, and returns a fresh local File.
An unavailable or changed session must be shown as unavailable rather than silently omitted.

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

For the App UI, `createFileDrafts`, `fileIntakeError`, `prepareFileUploads` and
`restoreFileDraft` are in `apps/web/src/lib/file-upload.ts`. `ChatController.send` accepts file
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
