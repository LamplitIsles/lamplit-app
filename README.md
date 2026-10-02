# Lamplit App

Unified Lamplit chat app and shared protocol contracts for Pi and Codex backends.

This repository owns the shared Framework7/Svelte frontend and the TypeScript
contracts package. A deployment selects one engine; the frontend does not select
or switch engines inside a conversation.

The first slice supports main-session text history, sending and steering,
completed-message delivery, targeted stop, and reconnect reconciliation. Agent
messages appear when each message is complete, as in an IM app. Streaming voice
input adds final recognized text to an editable composer draft. Images, relationship
features and native releases remain later slices. The existing frontends remain in
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

The voice browser/contract slice is verified with a fake host. Identical-build
acceptance against Pi/workerd and CFL/Node is gated on both backend implementations
(#3044/#3045), before any voice PR merges. Existing host speech configuration owns
provider credentials; the browser receives availability only. No deployment or
production frontend replacement is included.
