# A2UI workspace media contract

A2UI Image, AudioPlayer and Video use workspace files as live references. The
root `@lamplit/contracts` exports `parseWorkspaceMediaPath(source, kind)`,
`workspaceMediaUrl(source, kind)`, `WorkspaceMediaKind`, and
`WORKSPACE_MEDIA_PATH`. The kind is `image`, `audio` or `video`. Both helpers
accept a `workspace:` reference or a plain workspace path. Relative and absolute
paths are supported; CFL decides whether an absolute path is within its actual
workspace. `workspace:` is data and must never be passed to a browser as a URL.

The first helper decodes the source exactly once and returns a literal path or
`null`. The second validates the same input and returns a same-origin endpoint or
`null`. The supported filename extensions are PNG, JPG, JPEG, WebP and GIF for
images; WAV and MP3 for audio; MP4 for video, case-insensitively. The helpers
reject malformed encodings, URI schemes, `..` path segments, controls,
backslashes, invalid Unicode, `/api` paths and double slashes. They do not check
whether a file exists or whether its contents match its extension.

The generated query has exactly one `path` value, and audio/video also have
exactly one `kind` value. Examples:

- `workspace:images%2F%E7%81%AF.png` as image → `/api/chat/workspace-image?path=images%2F%E7%81%AF.png`
- `workspace:music%2F%2520.wav` as audio → `/api/chat/workspace-media?kind=audio&path=music%2F%2520.wav`
- `video/clip.mp4` as video → `/api/chat/workspace-media?kind=video&path=video%2Fclip.mp4`

After the server reads `URLSearchParams.get("path")`, the result is the literal
file name. **Do not URI-decode it again**: `%2520` in the source is a literal
`%20` in the filename. The same rule applies to percent-encoded text that
resembles traversal. Actual `..` segments are rejected after the one decode.

`validateA2UISurface` accepts these references in the A2UI wire only when they
start with `workspace:`; bare paths are supported by the helpers for other
callers. It validates the relevant component and video poster without changing
the wire payload. The renderer must call
`workspaceMediaUrl` before loading, then use its authenticated same-origin media
path; native embedding must bridge the fully encoded local URL without exposing
credentials. HTTPS media remains supported under the existing policy.

Client validation is not an authorization or filesystem boundary. CFL must
independently enforce current-session authorization, workspace containment on
the opened descriptor, regular file and actual supported content, the existing
20 MiB image limit, the agreed 256 MiB audio/video limit, and bounded
Range/cancellation handling. A missing or
changed file follows current-file semantics; no snapshot is implied. External
media can fail when the origin does not permit CORS.
