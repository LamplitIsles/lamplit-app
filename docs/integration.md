# Backend integration

One shared browser build and one contracts package serve both existing backends.
The host adapters stay in their backend repositories. There is no additional
adapter repository, execution service, or transcript database.

## Public package

`packages/contracts` publishes JavaScript and declarations from `dist`, compiled
with TypeScript 6. Its root contains the schemas and Chord service token; `/client`
contains the browser transport, and `/server` the portable Chord provider and
WebSocket boundary. The package does not import Node, Worker or web-app modules.

For the first slice, clone the repositories alongside one another. Build the
public package before installing the backends. Both consume its built directory
through their existing package managers:

```sh
# In lamplit-app
bun install --frozen-lockfile
bun run build

# In lamplit-chat
npm install ../lamplit-app/packages/contracts

# In codex-for-love
pnpm --filter @lamplitisles/partner add @lamplit/contracts@file:../../../lamplit-app/packages/contracts
```

After changing contracts, rebuild them and refresh the CFL file dependency; pnpm
materializes a package copy. npm uses the adjacent local package. Do not import
private `apps/web/src` from either backend. A registry/release workflow is outside
this slice; these commands explicitly describe adjacent-checkout development.

## Pi / Cloudflare

`lamplit-chat/src/server/chat-adapter.ts` maps native Pi branch history and native
admission receipts. `PiSession` owns the Chord provider and connection lifecycle.
The Worker authenticates `/api/chat/socket` and selects the deployment's main
session. Hosted instances resolve through their existing registry; browser-supplied
session or instance IDs are not trusted.

For an independent local shared-UI preview:

```sh
# In lamplit-chat, after building lamplit-app and configuring development model/auth
npx wrangler dev --config wrangler.slice.jsonc --local --port 8787
```

Visit `/slice/`. This config serves `../lamplit-app/apps/web/build`, uses local
DOs and does not replace the production config. Existing host model/auth setup
still applies. Do not run previews against production storage.

The platform proxy admits `/api/chat/socket` and `/slice/*` using its existing
session, same-origin and instance-bound authorization. The hosted worker must
serve the shared build before this is a hosted UI deployment; proxy changes alone
are not a deployment.

## Codex / Node

`codex-for-love/apps/partner/runtime/chat.ts` maps the Partner's native-history
projection and durable submission metadata. It adds a WebSocket upgrade handler
to the existing server. The official app-server retains execution ownership.

To expose the shared UI alongside the old frontend:

```sh
# In codex-for-love; use an independently configured development instance
LAMPLIT_APP_ASSETS=/absolute/path/to/lamplit-app/apps/web/build \
  pnpm --filter @lamplitisles/partner start -- /absolute/path/to/development.toml
```

The new UI is at `/slice/`; the original entry stays at `/`. If the environment
variable is absent the server does not serve a shared-UI entry. The common socket
uses the existing deployment/gateway authentication boundary, rejects foreign
browser origins, and allows originless local clients only from loopback. This
slice does not add a separate CFL account system or authorize public unauthenticated
exposure.

Completed Codex message IDs are recorded as presentation metadata, without copying
reply text. In-progress text is not displayed. A targeted stop never follows an
app-server mismatch to interrupt a newer turn.

## Verification

- Common package: actual WebSocket transport, Chord snapshot/delta codecs,
  provider reconstruction, submission validation and revoked authorization.
- Pi: real workerd/DO with a synthetic model, duplicate admission and new-socket
  lookup; backend typecheck and lint.
- CFL: real Node host and official SDK with the existing fake app-server,
  duplicate admission, identity conflict, steering, targeted stop and rehydration.
- Platform: fake-bound proxy tests for authentication, origin and session headers.
- Same production browser artifact was also checked against isolated Pi/workerd
  and CFL/Node hosts with fake engines, including complete reply and refresh.

All test conversations, credentials, state and ports belong to fixtures. No
production service restart or frontend replacement is part of this slice.

## Voice integration

Build `packages/contracts` before dispatching backend work. The public
`@lamplit/contracts/voice` subpath exports compiled `dist/voice.js` and
`dist/voice.d.ts`: endpoint paths, sample rate, duration/PCM/frame/queue/control/event
limits, error codes, capability/control/event TypeBox schemas and types,
`validateVoiceCapability`, `validateVoiceControl`, `validateVoiceServerEvent`,
`parseVoiceControl`, `parseVoiceServerEvent` and `validateVoiceFrameBytes`.
Use the validators (including result code-point checking), not schemas alone,
for admission. `validateVoiceFrameBytes(bytes, totalBytes)` returns the admitted
new total; host state separately rejects audio before ready or after finish.
The owned chat schema removes its obsolete fixed `voice: false` field, so refresh
both backend package consumers atomically with their voice adapters.

Both hosts must authenticate capability and stream through their existing boundary,
check same-origin browser upgrades, and expose the two `/api/voice/*` paths alongside
`/slice/`. Vite's existing `/api` proxy already covers both paths and WebSocket
upgrades; no additional frontend config or credentials are needed. Keep the existing
Qwen streaming provider/configuration in the hosts. Missing/disabled speech settings
return `available: false`; config failures keep recording disabled without breaking
text chat. No browser credentials, new provider framework, batch fallback, or audio
persistence is introduced. Existing text operator configuration stays unchanged.

`bun run test:browser` serves the production build from an isolated test-owned
Bun host with fake speech events and Chrome's synthetic microphone. It checks
streaming PCM before finish, final draft insertion and explicit send, cancel/stale
results, failure, disconnect, microphone refusal, oversized drafts and disabled
capability at 390px and 1280px. Worklet tests check PCM conversion/downmix, partial
flush ordering and the five-minute sample cap. No test reads live host state or
uses provider credentials.

The text/voice baseline has passed same-build acceptance against isolated real
Pi/workerd and CFL/Node hosts with fake providers. The companion-panels batch adds
six required `ChatBackend` read methods and optional persisted message provenance.
See [companion panels](companion-panels.md) for the authoritative public contract,
frozen compiled-package handoff, native fixture requirements and actual-host
commands. Its same-artifact two-backend acceptance remains pending the Owner gate.
No deployment or production service restart is part of that acceptance.

## Image sending and recovery

Spec #3096 extends the compiled root with strict original/preview/model upload,
host image limits, reference/availability and native recovery DTOs. `view.recovery`
is required (empty when no recoverable submitted input). Mount the portable
`imageHttp` from `/server` before static routing or implement equivalent validated
native routing; authenticate upload and original reads against current owner/session.
Use existing native storage and atomic admission/replacement authority. Pi retains
browser-prepared JPEG variants; CFL uses original bytes. No server transcoding or
new execution service is needed. See [image-send-recovery](image-send-recovery.md)
for exact DTOs, native controls, limits and frozen runner commands. Backend workers
must use the frozen archives instead of rebuilding their own browser/package.

## Quiet compaction handoff

Specs #3120 (Pi) and #3121 (CFL) consume the reviewed App #3119 browser, compiled
contracts and unchanged acceptance runners after Owner freezes the common bytes.
Before that handoff both backend specs remain blocked. Implement native nullable
active-context observations, native lifecycle/admission and the test-only controls
in [quiet compaction](quiet-compaction.md). Adapter ownership and atomic admission
checks remain mandatory even when the shared host has checked its current view.
Never retry native compaction automatically after reconnect/lost acknowledgement.
Do not remove native records required for continuation or search. Remove completion
presentation in both manual/automatic history paths. Use only isolated test-owned
storage and fake engines for joint acceptance; report actual-host results separately
from App fixture acceptance. No native release, deployment or merge is included.
