# Sticker contract — spec #8

CFL implements the host. Both host and clients must use the same reviewed
contracts build. Old clients must update before consuming
sticker-bearing image references; there is no compatibility negotiation.

All `/api/stickers` requests use chat owner authentication. Mutation requests
require an exact same-origin `Origin` and recheck session authorization at the
host's commit point. Read and response authorization is checked again after work.
IDs never grant authority and local paths never appear on the wire. All objects
are strict. A failed request has a non-success status; 401 means unauthenticated,
403 means wrong session/origin or revoked authority, 404 means missing media,
and 400 indicates invalid, unavailable or failed work. A caller must not treat
failure as admission or assume a timeout implies failure.

- `GET /api/stickers/packs`, `/packs/{packId}`, `/search`, `/favorites` take
  `sessionId`, optional opaque `cursor`, `limit` (1–30, default 30), and optional
  `query` (except pack members). Pages have `nextCursor: null` at the end and
  may be empty. Packs contain name, description and their first member as cover;
  sticker entries carry ID, content version, name, tags, MIME and availability.
  Search is bounded name/tag matching. Favorites are only the authenticated
  Human's; Partner's separate collection is available through its own MCP.
- `POST /favorites` takes `{sessionId, stickerId, favorite}`. `POST
/favorites/image` takes `{sessionId, imageId, name, tags}` and the host must
  prove image membership in this conversation. `POST /favorites/upload` takes
  `{sessionId, name, tags, mediaType, data}` with canonical base64, at most
  5 MiB decoded. Both create a Human favorite only after successful validation.
  None of these routes adds a message or conversation-image member.
- `POST /imports?sessionId=...` accepts `application/zip`, at most 32 MiB
  compressed. The host must limit entries, expansion, file and image sizes,
  animation frames and processing time; reject unsafe paths, links, duplicate
  names and mismatched formats; and make a validated pack visible atomically.
  The response is `{pack, count}`. The server defines the manifest separately.
- `GET /media/{version}/{thumbnail|original}` accepts a lowercase SHA-256 version.
  Thumbnail is static WebP, first frame, retaining alpha, with longest side at most
  512 pixels without upscaling and at most 160,000 bytes; original retains its MIME and
  animated GIF bytes. Content is immutable by version. Responses use `private,
no-cache` and a representation-specific ETag so a browser may retain bytes
  and must revalidate on every use. An application may explicitly show its own
  same-identity cache first while revalidating in the background; a revoked item
  can therefore briefly remain visible. Cache entries must be identity isolated,
  bounded, and evicted on 401, 403, or 404. The host authorizes before returning
  either bytes or a conditional 304.
  Responses have `nosniff`. Missing bytes return 404.

For ID sending, `POST /stage` accepts `{sessionId, operationId, sticker:
{id, version}}` and returns `{sessionId, operationId, image: ImageRef}`. The
returned available image includes the identical sticker identity, and is bound
to that session and operation. The host snapshots bytes and variants; staging
alone creates neither a message nor a conversation-image member. Send the image
with the existing Chord `submit` / `finalizeSubmission` payload. The operation ID
and entire ordered payload remain immutable: identical operations deduplicate,
changed content conflicts, and lost acknowledgements/null lookup never authorize
an automatic replay. Explicit retry uses the existing failed-submission method
and new attempt ID. The host retains the original version for retry and history,
including after pack updates or unfavorite. Message and recovery `ImageRef`s
carry optional `sticker: {id, version}`; ordinary image references omit it. Name
and MIME remain in the existing image reference, not duplicated in sticker
metadata. Actual Partner image messages likewise require completed native tool
call evidence and preserve the version. Animated originals and a static model
representative are distinct; a static frame does not imply model comprehension
of animation. Authentication, version existence and actual image validation are
host responsibilities, not facts established by a client-supplied reference.

The Companion `StickerClient` keeps at most 128 media entries and 10 MiB in
memory per active session/connection. It does not persist media across reloads
or reconnects. Callers retain the client while displaying the picker, release
media listeners when no longer displayed, and clear displayed media when the
client closes or reports eviction. Cached blobs may be displayed immediately;
each load starts an authenticated conditional revalidation. Network failures
leave existing cached content in place until a later successful revalidation.
