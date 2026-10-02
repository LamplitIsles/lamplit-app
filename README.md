# Lamplit App

Unified Lamplit chat app and shared protocol contracts for Pi and Codex backends.

This repository owns the shared Framework7/Svelte frontend and the TypeScript
contracts package. A deployment selects one engine; the frontend does not select
or switch engines inside a conversation.

The first slice supports main-session text history, sending and steering,
completed-message delivery, targeted stop, and reconnect reconciliation. Agent
messages appear when each message is complete, as in an IM app. Streaming voice
input adds final recognized text to an editable composer draft. Relationship history, date-based Markdown diaries, session albums and pending
reminders are available through the shared connection. Album browsing and saving
originals work independently of image sending; search, attachment sending, TTS
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
