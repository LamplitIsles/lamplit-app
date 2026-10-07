# Backend integration

One Framework7/Svelte browser build and one compiled contracts package serve Pi
and CFL. Adapters and native execution stay in their backend repositories; there
is no separate App Worker, execution service or transcript database. Standalone
entry is `/`, hosted entry `/chat`, and common assets use root-relative paths.
The obsolete `/slice` entry has no alias or fallback. Native/domain consumers
remain independent of frontend build removal. Platform owns hosted manifest,
service worker, management and authentication separately.

## Adjacent checkout build

Use adjacent `lamplit-app`, `lamplit-chat` and `codex-for-love` checkouts. App uses
Bun 1.3.14 and TypeScript 6; Pi uses npm and CFL pnpm. Build App first:

```sh
# In lamplit-app
bun install --frozen-lockfile
bun run build
CHAT_BACKEND=http://127.0.0.1:8787 bun run dev
# Open http://127.0.0.1:5173/
```

`packages/contracts` exports compiled JavaScript/declarations from `dist`: root
schemas/service, `/client` browser transport, `/server` portable Chord provider,
WebSocket and image HTTP, `/voice` voice validators and `/wire` codecs. It imports
no Node, Worker or private web-app modules. Backends consume the compiled package
through their own declared file/archive dependency and package manager; never
import `apps/web/src`. For an intentional adjacent-package refresh:

```sh
# In lamplit-chat
npm install ../lamplit-app/packages/contracts
# In codex-for-love
pnpm --filter @lamplitisles/partner add @lamplit/contracts@file:../../../lamplit-app/packages/contracts
```

CFL's file dependency is materialized, so refresh it after contract builds. Frozen
native acceptance instead installs the exact extracted package in test-owned
locations using the [complete handoff](default-shared-frontend.md). Do not refresh
or rebuild approved acceptance artifacts.

## Native hosting and Owner deployment

Canonical serving/build integration is coordinated with Pi #3163, CFL #3164 and
platform #3165. Their final reviewed procedures must be verified before Owner
runs them; this App PR does not deploy or edit those repositories. Production
builds consume `../lamplit-app/apps/web/build`, rather than build a second chat
frontend. Existing native runtime/domain/management dependencies remain required.
A fresh build/deploy always builds App first; merging alone never deploys.

Pi's existing Worker and PiSession own auth, session selection, native admission,
media and Chord lifecycle. The normal Wrangler configuration serves App assets,
with authenticated `/api/chat/socket`, `/api/chat/images`, `/api/chat/media/*`,
native album media and `/api/voice/*`. Browser IDs never select another instance.
After the coordinated Pi change, Owner's documented backend commands are:

```sh
# In lamplit-chat, after the App production build
npm ci
npm run build
npm run deploy
```

Do not execute these deployment commands in automated acceptance. For local native
acceptance use a test-owned Wrangler config, fake loopback model/speech, local
bindings and an explicit test-owned persistence directory:

```sh
npx wrangler dev --config "$ACCEPTANCE_ROOT/pi-fixture.jsonc" \
  --local --persist-to "$ACCEPTANCE_ROOT/pi-state" --port 8951
```

CFL's existing Partner Node server and official app-server integration retain
native history, submission receipts, ownership and targeted stop. Build the shared
App first, install CFL with its lockfile, then use its existing runtime command:

```sh
# In codex-for-love; Owner-configured instance only after review
pnpm install --frozen-lockfile
LAMPLIT_APP_ASSETS=/absolute/path/to/lamplit-app/apps/web/build \
  pnpm --filter @lamplitisles/partner start -- /absolute/path/to/instance.toml
```

That explicit path selects shared assets; it never enables a legacy UI fallback.
For native acceptance substitute extracted `browser/` and test-owned TOML,
workspace/SQLite/Codex-home paths, fake official app-server and speech. No installed
real engine executable or real config is used. Native configuration/auth remains
the host's responsibility; this App adds no account/configuration framework.
Workers never restart existing services. Owner later verifies the existing NUC
services and physical devices together; the NUC is not an implementation environment.

The platform remains the authenticated gateway for `/chat`, common assets and
native media/voice/socket paths, preserving its same-origin and instance-bound
authorization. It supplies its own hosted PWA manifest/service worker and keeps
management independently available. Proxy changes alone are not deployment;
Owner follows the platform repository's final documented deploy step after joint
review. App's standalone manifest uses `/` start/scope; no App service worker is
registered. Real hosted auth/PWA and device behavior are still a joint live gate.

## Desktop notifications

The shared chat page uses the native browser Notifications API on a secure origin;
hosts keep the existing complete-message ChatView contract. No backend endpoint,
turn-result field, push subscription or service worker is added. Notify discovery
uses authoritative live views only, not history/panel reads or optimistic sends.
Deploy the App build through the host's existing procedure when Owner authorizes
it; merging this feature alone does not deploy. Browser site permission and macOS
notification/Focus settings govern presentation independently of host delivery.
See [notification contract and physical acceptance](desktop-companion-notifications.md).

## Public behavior and verification

[Protocol](protocol.md) is the public interface authority. Completed assistant
messages remain IM-style; unfinished model text never enters the public view.
App sends use immediate normal optimistic text/image bubbles and silent success.
Offline drafts stay editable; only definite submission failure returns content.
Null lookup and transport errors keep the same pending identity without recovery
or replay; later reply failure does not undo submitted input. Both native hosts
must consume the exact Orc-approved v2 contracts/frontend/runner identity in the
[submission handoff](native-durable-submissions.md). Joint native acceptance is
a separate gate; fixture success does not establish it.
Stop targets one native turn and never follows an engine mismatch to a newer turn.
Voice capability and stream require native authentication and same-origin upgrades.
Missing/disabled/config-failed speech disables recording without breaking text.
Native Qwen sentence aggregation, lifecycle and transcript validation remain in
host adapters. Shared capture uses real 16 kHz worklet PCM with no resampler,
batch fallback, audio persistence, interim preview or reply TTS.

Panels use six bounded shared reads, image bytes use authenticated same-origin
HTTP, and native reminder scheduling stays native. Images/recovery retain strict
limits, immutable operation ownership, original/JPEG variants and verified atomic
replacement. Quiet compact uses native nullable context observations/admission,
preserves fresh complete-snapshot usage, and never replays after reconnect or
renders success markers. Search uses each native archive and scoped record IDs,
with bounded context, complete selected text and read failure isolated from chat.
See [panels](companion-panels.md), [images](image-send-recovery.md),
[compact](quiet-compaction.md) and [search](conversation-search.md) for schemas
and native fixture/control facts.

FlickNote completion records #3062/#3096/#3119/#3142 confirm those features passed
joint isolated Pi/workerd and CFL/Node acceptance and merged. Old pending handoff
statements are superseded; historical archive bytes remain evidence. That prior
acceptance does not prove the new canonical-root build. The
[complete default handoff](default-shared-frontend.md) defines full App check order,
one source-HEAD archive, all six external runners and native controls, the isolated
notification runner and route regression, before/after
manifests, Owner approval before native starts, screenshots and remaining limits.
All automated state, credentials, ports and fake providers belong to fixtures.
Live provider use, hosted integration and physical-device behavior remain later
Owner/user verification. No deployment, merge, release or live restart occurs here.

## Keet display restoration (#3408)

Native adapters project persisted DM/group provenance into the shared minimal
source union on initial read, reconnect and history. Use original visible message
text, not the engine's attribution prompt. Consume the exact Orc-accepted built
contract/browser archive; do not rebuild or refreeze it. The compatible runner,
locked installation and fixture controls are documented in
[Keet source restoration](keet-source-restoration.md). Hosted public webhook
provisioning/routing/credentials remain Platform responsibilities; preserve tenant
and authentication guards. This change adds no public ingress or deployment.
