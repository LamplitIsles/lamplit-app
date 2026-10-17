# Workspace Markdown images (#4210)

Only agent reply Markdown (live, completed and older history) resolves workspace
images, and only when `ChatView.capabilities.workspaceImages` is literal `true`.
The field is optional; omit it on unsupported hosts. It is independent of upload
limits. User text, tools, reasoning, diary and reminders do not enable this reader.
External HTTP(S) images and existing `/api/` media keep their existing behavior.

The root `@lamplit/contracts` exports `WORKSPACE_IMAGE_PATH` as
`/api/chat/workspace-image`, `parseWorkspaceImagePath(source): string | null`, and
`workspaceImageUrl(source): string | null`. Both functions accept the original
Markdown image destination. The parser applies `decodeURIComponent` exactly once,
accepts relative and absolute PNG/JPEG (`.jpg`/`.jpeg`), WebP and GIF paths, and
rejects malformed encoding, controls, backslashes, URI schemes (including `file:`),
protocol-relative URLs and `/api` paths. No recursive decoding is performed.
The URL helper encodes the parsed literal path as a single `path` query payload:

- `plots/a%20b.png` → `/api/chat/workspace-image?path=plots%2Fa%20b.png`
- `/workspace/灯.webp` → `/api/chat/workspace-image?path=%2Fworkspace%2F%E7%81%AF.webp`
- `plots/%2520.png` → `/api/chat/workspace-image?path=plots%2F%2520.png`

CFL #4212 serves authenticated same-origin `GET` at that path. Read
`new URL(request.url).searchParams.get("path")` once; its result is already the
literal filesystem path. **Do not call the source parser or decodeURIComponent on
that query result.** In the last example the filename is `%20.png`, not a space.
Resolve relative paths against the Partner execution workspace; absolute paths
refer to host files. Native authorization, canonical realpath containment, regular
file checks, supported image bytes and the 20 MiB bound belong to CFL. It must
return the correct Content-Type with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Normal owner cookies accompany the image request;
no service credentials appear in URLs. The frontend follows existing root-relative
API semantics at standalone `/` and hosted `/chat`.

The renderer preserves alt/title and fits images to the message width. Missing
images show an unavailable state and Retry; retry adds `&retry=<attempt>` to bypass
a failed browser load. The endpoint ignores that additional query argument. Invalid
or unsupported references have an unavailable state without an image request.
Capability/session changes remount the renderer; route teardown destroys it.
These are live file references: Markdown is unchanged and no attachment, snapshot
or Chat Image Library record is created. No gallery or full-screen preview is added.

Run `bun tests/workspace-images-browser.mjs` after `bun run build` for isolated
fixture acceptance at 390, 1280 and 320 px. It records decoded formats, literal
request paths, owner-cookie presence, failures/retry, capability removal, session
switching, live/history rendering, preserved external/shared media, mobile bounds
and screenshots under `.scratch/workspace-markdown-images/browser/`. Runtime
parser/schema tests are in `tests/workspace-images.test.ts`. Native filesystem and
authorization acceptance remains CFL's responsibility; App fixture results do not
prove the native reader. No corresponding Penpot design is known.
