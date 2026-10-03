# Lamplit App

Unified Lamplit chat app and shared protocol contracts for Pi and Codex backends.

This repository owns the shared Framework7/Svelte frontend and the TypeScript
contracts package. A deployment selects one engine; the frontend does not select
or switch engines inside a conversation.

The first slice supports main-session text history, sending and steering,
completed-message delivery, targeted stop, and reconnect reconciliation. Agent
messages appear when each message is complete, as in an IM app. Streaming voice
input adds final recognized text to an editable composer draft. Relationship history, date-based Markdown diaries, session albums and pending
reminders are available through the shared connection. Image selection, sending, image-bearing history and explicit submitted-input recovery
use the same native contract. Album browsing and saving originals work independently; generic attachments, TTS
and native releases remain outside this slice. The existing frontends remain in
service until full product coverage is verified.

## Development

Use Bun 1.3.14 and TypeScript 6. The toolchain includes oxlint and oxfmt.

```sh
bun install --frozen-lockfile
bun run build
CHAT_BACKEND=http://127.0.0.1:8787 bun run dev
```

Open `http://127.0.0.1:5173/slice/`. Vite proxies the shared WebSocket endpoint to
`CHAT_BACKEND`; the built frontend always uses its own origin.

```sh
bun run check
bun run lint
bun run format:check
bun run test
bun run test:browser
bun run test:panels-browser
bun run test:images-browser
bun run test:compact-browser
bun run test:search-browser
```

Browser acceptance uses an isolated Chrome context and a test-owned fake backend.
Chrome must be installed. It covers mobile/desktop rendering, completed replies,
connection recovery, refresh and stop. Voice checks use Chrome’s synthetic
microphone and fake speech, including streaming PCM and responsive failure/cancel
states. Engine integration tests live with each backend and use fake providers or
a fake official app-server.

See [backend integration](docs/integration.md), [protocol](docs/protocol.md), and
[source attribution](docs/IMPORTS.md).

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

The merged text/voice baseline was verified on isolated Pi/workerd and CFL/Node
hosts with fake providers. The new companion panels are verified locally with the
fixture host. Actual panels acceptance on both backends remains the Owner/user
joint merge gate for specs #3062/#3063/#3064. No deployment or production frontend
replacement is included.

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
See [public contract and frozen acceptance handoff](docs/companion-panels.md) for
field definitions, limits, fixtures, archive/hash verification and actual-backend
integration commands. `bun run freeze:panels` records the committed app HEAD and
compiled contracts in ignored scratch artifacts; actual backends must accept that
same artifact before any repository merges.

## Images and recovery

Choose or paste supported images, preview/remove them, and send alone or with text.
The connected host advertises its limits: Pi up to six / 8 MB each / 24 MB originals
per operation; CFL five / 5 MiB / 20 MiB. Failed upload retains editable selections.
Submitted input recovery offers explicit inspection/restoration without replacing
current edits. Missing originals require explicit removal; uncertain delivery is
inspected and never automatically retried. Unsent drafts are not saved across reload.

See [image protocol and frozen native acceptance](docs/image-send-recovery.md).
`bun run freeze:images` freezes committed browser/contracts and the reusable runner
once into ignored scratch. Specs #3097/#3098 consume those exact archives; actual
Pi/CFL acceptance remains the Owner gate for #3096 before merge, with no deployment.

## Context and compaction

The existing context ring displays native active-context usage. Missing usage shows
an empty ring and zero while retaining known capacity. Type `/compact` (or choose
its existing slash suggestion) without images to ask the native engine to compact
an idle conversation. Busy/refused commands keep the draft; running and failed
states remain visible. Success is silent, including automatic and historical
compactions. Completion clears stale usage until fresh native data arrives.
Reconnect reads native state and never automatically repeats the command.

See [native contract and common acceptance](docs/quiet-compaction.md).
`bun run prepare:compact` records a candidate browser/contracts/runner identity
from committed source. Owner review precedes final freeze; actual isolated Pi/CFL
acceptance for #3119/#3120/#3121 remains pending. The complete old Composer redesign,
including the 96px attachment mockup, is superseded by pinned native CFL Framework7
presentation. No deployment or native release is included.

## Conversation archive search

Use the header search button to search preserved chat text and compaction summaries.
Each hit opens complete text and bounded nearby context in the existing separate
reader. Back returns to results; reading preserves the active chat and unsent draft.
Loading, empty, failure/retry and context-truncation states retain the CFL design.
Results are bounded to 20; a missing native total shows the returned result count.

See [search contract, native fixture and candidate handoff](docs/conversation-search.md).
`bun run prepare:search` freezes committed browser/contracts/acceptance bytes with
source HEAD and hashes in ignored scratch. The runner accepts external test-owned
native base/control URLs. Owner approval precedes native adapter work; both native
acceptances and joint user review remain the merge gate for #3142/#3143/#3144.
