# Lamplit App

Unified Lamplit chat app and shared protocol contracts for Pi and Codex backends.

Hosts with the optional model API expose a model picker and Fast switch in Settings. Saved
choices apply to the next reply and preserve the conversation and draft.
See the [model settings contract and verification](docs/model-settings.md).

This repository owns the shared Framework7/Svelte frontend and the TypeScript
contracts package. A deployment selects one engine; the frontend does not select
or switch engines inside a conversation.

The app supports main-session text history, sending and steering,
completed-message delivery, targeted stop, and reconnect reconciliation. Online
sends appear immediately as normal outgoing bubbles, including images before
upload finishes. Success is silent; offline text/images stay editable. Confirmed
nonadmission retains a failed bubble with direct Retry and confirmed Delete. Lost replies keep the
optimistic message while its exact operation is looked up, without automatic replay. Companion answers display as messages at source line breaks, with complete source lines
appearing during generation when the backend provides an in-progress reply. Multiline
Markdown blocks remain together; completion reveals the final tail. Each display message has its own
visible avatar, source time and local long-press Copy. History and complete-only arrivals show all
text immediately; preserved messages remain unchanged. See [sentence replies](docs/sentence-replies.md). Existing voice messages remain playable. Relationship history, date-based Markdown diaries, session albums and pending
reminders are available through the shared connection. Image selection, sending, image-bearing history and explicit submitted-input recovery
use the same native contract. Album browsing and saving originals work independently;
hosts that advertise file support can also receive general file attachments. TTS
and native releases remain outside this app. The shared app is the direct default
frontend: standalone `/`, hosted `/chat`, with root-relative assets and no `/slice` alias.

The composer places stickers and attachments beside the text input. Enter sends the draft (Shift+Enter inserts a line break). The sticker
panel supports name/tag search, pack browsing and Human favorites. Tapping a
sticker sends it separately without consuming a draft; holding it previews the
original animation and name. Sticker thumbnails are cached for the current
connection and revalidated in the background.

## Development

Use Bun 1.3.14 and TypeScript 6. The toolchain includes oxlint and oxfmt.

```sh
bun install --frozen-lockfile
bun run build
CHAT_BACKEND=http://127.0.0.1:8787 bun run dev
```

Open `http://127.0.0.1:5173/`. Vite proxies the shared WebSocket endpoint to
`CHAT_BACKEND`; the built frontend always uses its own origin.

```sh
bun run check
bun run lint
bun run format:check
bun run test
bun run build
bun run test:browser
bun run test:keet-browser
bun run test:panels-browser
bun run test:images-browser
bun tests/optimistic-send-browser.mjs
bun run test:compact-browser
bun run test:search-browser
bun run test:route-lifecycle-browser
bun tests/notifications-browser.mjs
```

Browser acceptance uses an isolated Chrome context and a test-owned fake backend.
The composer touch fixture requires installed Chrome; other runners can use a
test-owned Playwright Chromium executable through `APP_ACCEPTANCE_BROWSER`. Notification checks use a recording native API
fake; other runners deny notifications without requesting real permission. It covers
mobile/desktop rendering, completed replies,
connection recovery, refresh and stop. The local composer touch fixture checks
that tapping and holding do not request microphone access; it does not test a
native host or physical iPhone. Engine integration tests live with each backend and use fake providers or
a fake official app-server.

See [backend integration](docs/integration.md), [protocol](docs/protocol.md), and
[source attribution](docs/IMPORTS.md).

When hosted by CFL, the web app supports Passkey setup, sign-in and recovery
using a pairing code generated on the CFL host. Other hosts retain their own
authentication. See the [browser sign-in contract](docs/integration.md#cfl-browser-sign-in).

## Desktop companion notifications

On desktop Safari/Chrome, the first trusted click on the open chat page requests
notification permission if undecided, directly within the click before sending
or waiting for network work. Each page lifetime attempts once, including a
dismissed or rejected request; reloading allows another attempt if still undecided.
Already granted/denied permissions do not prompt. Use a secure origin (HTTPS;
loopback localhost is suitable for development).

Each newly observed complete companion message can show a notice when the page
is hidden or unfocused, including multiple messages in one turn and messages
whose turn later fails/stops. Notices show the displayed companion name and a
localized generic new-message body, with no preview. Click attempts to return to
the originating window. Initial history, session changes, older-history reads and
foreground observations are silent; repeated live views and same-session reconnect
do not replay observed IDs. Permission/delivery failures do not block chat.

Check the site's browser permission, macOS notification settings and Focus when
notices are absent. The page must remain open and running; reload resets its
baseline, and reconnect may discover new live messages but offers no missed-message
guarantee. There is no Web Push, delivery after closure/suspension, or mobile support.
See [notification acceptance](docs/desktop-companion-notifications.md) for the
physical Mac Safari checklist. Linux fake-API checks do not prove OS display.

## Voice messages

The App supports playback of existing assistant voice messages and voice-output
settings when provided by the host. Recording, speech-to-text and audio input
streaming are not available in the App. The public voice input contract remains
available for existing host compatibility. Earlier text/voice, panels, images,
compaction and search acceptance with fake providers (FlickNote #3062/#3096/
#3119/#3142) is historical evidence; current artifacts need their own acceptance.

## Companion panels

Open the companion profile to browse relationship history, diary, album and
reminders. Each panel has loading, empty and retry states; diary entries distinguish
missing and oversized content, and unavailable images stay marked. Panel failures
do not block text chat. Opening, refresh, chat completion and
reconnect reload only the visible panel and relationship summary. There is no
background polling. Switching panels or sessions invalidates older requests.

The app owns bounded TypeScript/TypeBox schemas and runtime validation on the
existing Chord/WebSocket connection. Image bytes use authenticated same-origin
HTTP; saving keeps original bytes. Reminders retain native schedules and appear in
chat as **App reminders**, with creation/editing still handled by Agent tools.
See [public contract and native fixture facts](docs/companion-panels.md) for
field definitions, limits and native integration requirements.

## Attachments and recovery

Use the plus menu to take a photo, choose photos, or upload files; paste supported
images directly into the composer. Preview or remove drafts and send them alone or
with text. File upload is available only when the connected host advertises it;
files are displayed in chat and can be downloaded without joining the image album.
The connected host advertises its limits: Pi up to six / 8 MB each / 24 MB originals
per operation; CFL five / 5 MiB / 20 MiB. Failed upload retains its bubble and page-owned originals for direct retry.
Submitted input recovery offers explicit inspection/restoration without replacing
current edits. Missing originals require explicit removal. Null lookup or disconnection
keeps the original pending bubble without recovery or automatic replay. Receipts are
submitted/failed; reply failure and stopping remain independent. Failed submissions never restore or replace newer Composer drafts. After 60 seconds,
dispatched inputs request authoritative fenced finalization while connected; null or
unreachable results remain sending. Failed deletion persists after acknowledgement
and has no undo. Unsent drafts and pre-upload originals are not saved across reload. The v2 service requires a matching frontend after update.

See [image protocol](docs/image-send-recovery.md), [file contract](docs/chat-file-contract.md), [v2 submission handoff](docs/native-durable-submissions.md), and the [sticker backend contract](docs/sticker-contract.md).

## Context and compaction

The existing context ring displays native active-context usage. Missing usage shows
an empty ring and zero while retaining known capacity. Type `/compact` (or choose
its existing slash suggestion) without images to ask the native engine to compact
an idle conversation. Busy/refused commands keep the draft; running and failed
states remain visible. Success is silent, including automatic and historical
compactions. Completion clears stale usage until fresh native data arrives.
Reconnect reads native state and never automatically repeats the command.

See [native contract and common acceptance](docs/quiet-compaction.md).
The complete old Composer redesign, including its attachment mockup, is superseded
by native CFL Framework7 presentation. No deployment or native release is included.

## Conversation archive search

Use the header search button to search preserved chat text and compaction summaries.
Each hit opens complete text and bounded nearby context in the existing separate
reader. Back returns to results; reading preserves the active chat and unsent draft.
Loading, empty, failure/retry and context-truncation states retain the CFL design.
Results are bounded to 20; a missing native total shows the returned result count.
Hosts provide `snippet: { segments: [{ text, highlighted }] }`; the shared UI
renders plain text with explicit highlights. Literal HTML, backticks and Unicode
stay visible. Old HTML-marked snippet strings are rejected by the public contract.

See [search contract and native fixture](docs/conversation-search.md).

## Complete artifact and native acceptance

[Default frontend acceptance](docs/default-shared-frontend.md) documents the
feature runners, local composer touch regression, external text controls, native fixture operations,
root/hosted asset and PWA boundaries, and verification limits. After committing
verified source, `bun run prepare:default` exports one browser/contracts/all-runner
archive with source HEAD and per-file hashes into ignored
`.scratch/native-durable-submissions/candidate`. Owner must approve these exact bytes
before native workers start; both hosts use the identical archive without rebuilding.
Historical feature artifacts stay unchanged. Production adjacent-checkout build
and host procedures are in [integration](docs/integration.md); platform management,
hosted manifest/service worker and auth remain independently owned.

## Collapsed thinking

Completed assistant messages can include a separate optional thinking disclosure
above the answer, initially collapsed and labeled **不许你看的小想法**. Expanding
it uses the existing Markdown renderer. Message copy remains answer-only.
See [contract and isolated acceptance](docs/collapsed-thinking.md).

## Keet messages

Native Keet DM/group input appears as an incoming message with a K avatar, sender,
destination and distinct muted bubble in light/dark. Original visible text and
images use the existing safe rendering/media rules. The backend owns provenance;
web submissions cannot supply it. Ingress, native prompts and durable history
remain backend responsibilities. See [Keet contract and frozen acceptance](docs/keet-source-restoration.md)
for the exact artifact handoff (`bun run prepare:keet`) and native fixture controls.
App fixture verification does not establish final cross-repository acceptance,
which remains pending the Orc. No merge or deployment is part of this restoration.

## Matrix messages

Matrix inputs appear as incoming messages with an M avatar, Matrix badge, sender
and exact room ID. An empty display name uses the sender ID. The original body
stays separate from attribution, with safe wrapping and text escaping. Native
adapters own persisted provenance and authored time; web input cannot forge it.
See [Matrix display and complete acceptance handoff](docs/matrix-source-ui.md)
for local checks, frozen artifact preparation and both-host acceptance gates.

## Chat reading layout

Incoming replies retain side avatars with wider mobile bubbles and a desktop
reading cap. Code and wide tables scroll locally. Only long timeline reminders
use a two-line expand/collapse preview; copy keeps full original text and the
scheduled-reminder view stays separate. See [reading layout and immutable
focused acceptance](docs/mobile-reading-layout.md).

### Structured chat interfaces

The Companion can render a constrained A2UI 1.0 Candidate surface as a chat
message. The same Svelte renderer is built into the web timeline and the
`/a2ui.html` embedded entry for a native host. Media may refer to HTTPS URLs;
only local tab, media and modal interactions are supported. The renderer does
not send actions or input to the agent. An invalid or unsupported surface is
shown as unavailable without hiding the rest of the conversation. The CFL host
and ETOS client must use the matching shared contract and app build.
