# Lamplit App

Unified Lamplit chat app and shared protocol contracts for Pi and Codex backends.

This repository owns the shared Framework7/Svelte frontend and the TypeScript
contracts package. A deployment selects one engine; the frontend does not select
or switch engines inside a conversation.

The app supports main-session text history, sending and steering,
completed-message delivery, targeted stop, and reconnect reconciliation. Agent
messages appear when each message is complete, as in an IM app. Streaming voice
input adds final recognized text to an editable composer draft. Relationship history, date-based Markdown diaries, session albums and pending
reminders are available through the shared connection. Image selection, sending, image-bearing history and explicit submitted-input recovery
use the same native contract. Album browsing and saving originals work independently; generic attachments, TTS
and native releases remain outside this app. The shared app is the direct default
frontend: standalone `/`, hosted `/chat`, with root-relative assets and no `/slice` alias.

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
bun run test:panels-browser
bun run test:images-browser
bun run test:compact-browser
bun run test:search-browser
bun run test:route-lifecycle-browser
bun tests/notifications-browser.mjs
```

Browser acceptance uses an isolated Chrome context and a test-owned fake backend.
Chrome must be installed, or set `APP_ACCEPTANCE_BROWSER` to a test-owned
Playwright Chromium executable. Notification checks use a recording native API
fake; other runners deny notifications without requesting real permission. It covers
mobile/desktop rendering, completed replies,
connection recovery, refresh and stop. Voice checks use Chrome’s synthetic
microphone and fake speech, including streaming PCM and responsive failure/cancel
states. Engine integration tests live with each backend and use fake providers or
a fake official app-server.

See [backend integration](docs/integration.md), [protocol](docs/protocol.md), and
[source attribution](docs/IMPORTS.md).

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

## Voice input

Recording availability comes from the authenticated `/api/voice/capability`
endpoint. When unavailable, text chat stays usable. Start recording with the
microphone, finish with the stop control, or discard it with cancel. Only the final
transcript enters the saved draft selection; edit it and explicitly send when
ready. A draft exceeding the chat text limit remains editable until shortened.
Cancel, failure and disconnect release microphone resources and keep the draft.
Navigation/session change also releases capture and invalidates old results; the
existing session draft lifecycle still applies. Recording requires a secure browser context and
actual 16 kHz AudioWorklet capture; there is no batch fallback, interim preview,
automatic send or audio persistence.

The text/voice, panels, images/recovery, quiet compaction and search features have
merged after joint isolated Pi/workerd and CFL/Node acceptance with fake providers
(FlickNote #3062/#3096/#3119/#3142). The canonical-root candidate requires fresh
same-artifact native/platform acceptance after Owner approval. Live providers,
physical devices and deployment remain separate verification.

## Companion panels

Open the companion profile to browse relationship history, diary, album and
reminders. Each panel has loading, empty and retry states; diary entries distinguish
missing and oversized content, and unavailable images stay marked. Panel failures
do not block text chat or voice drafts. Opening, refresh, chat completion and
reconnect reload only the visible panel and relationship summary. There is no
background polling. Switching panels or sessions invalidates older requests.

The app owns bounded TypeScript/TypeBox schemas and runtime validation on the
existing Chord/WebSocket connection. Image bytes use authenticated same-origin
HTTP; saving keeps original bytes. Reminders retain native schedules and appear in
chat as **App reminders**, with creation/editing still handled by Agent tools.
See [public contract and native fixture facts](docs/companion-panels.md) for
field definitions, limits and native integration requirements.

## Images and recovery

Choose or paste supported images, preview/remove them, and send alone or with text.
The connected host advertises its limits: Pi up to six / 8 MB each / 24 MB originals
per operation; CFL five / 5 MiB / 20 MiB. Failed upload retains editable selections.
Submitted input recovery offers explicit inspection/restoration without replacing
current edits. Missing originals require explicit removal; uncertain delivery is
inspected and never automatically retried. Unsent drafts are not saved across reload.

See [image protocol and frozen native acceptance](docs/image-send-recovery.md).

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

See [search contract and native fixture](docs/conversation-search.md).

## Complete artifact and native acceptance

[Default frontend acceptance](docs/default-shared-frontend.md) documents all seven
feature runners and the route regression, new external text/voice controls, exact
native fixture operations,
root/hosted asset and PWA boundaries, and verification limits. After committing
verified source, `bun run prepare:default` exports one browser/contracts/all-runner
archive with source HEAD and per-file hashes into ignored
`.scratch/default-shared-frontend/candidate`. Owner must approve these exact bytes
before native workers start; both hosts use the identical archive without rebuilding.
Historical feature artifacts stay unchanged. Production adjacent-checkout build
and host procedures are in [integration](docs/integration.md); platform management,
hosted manifest/service worker and auth remain independently owned.
