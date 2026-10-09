# Matrix source presentation and host acceptance

Spec #3560 extends the public shared ChatView contract with a backend-owned `MessageSource` variant:
`{ kind: 'matrix', senderId, senderDisplayName, roomId }`. IDs are nonempty;
display name may be empty. All three strings have a maximum of 255 UTF-16 units,
matching the gateway capacity. The MFA webhook/gateway wire protocol is unchanged. The shared TypeBox format enforces this alongside
schema validation, including public views and history; no single-line restriction
or truncation is added. Unknown fields are rejected and browser submissions cannot
supply a source. No event IDs, payloads, context or credentials enter this source.

The incoming message has an M avatar, Matrix badge and the existing Keet muted
bubble/accent. Its header shows display name (exact sender ID when empty), sender
ID when named, and exact room ID on a separate wrapping line. Labels render as
escaped text in both palettes. No room-name discovery is performed. The body is
independent original `ChatMessage.text`, rendered with existing safe Markdown;
never parse attribution prefixes to recover provenance. Native adapters preserve
message identity/order and original authored `createdAt` across initial read,
reconnect and older history, independently of private attribution prompts and
execution context. Keet, reminder, web and collapsed-thinking behavior is retained.

## Complete frozen candidate

Run the documented default checks plus `bun tests/matrix-browser.mjs`,
`bun tests/thinking-browser.mjs` and `bun run test:keet-browser`. Commit verified
source, then from a clean checkout run:

```sh
bun install --frozen-lockfile
bun tests/prepare-default.mjs --matrix-source-ui
```

When the working checkout contains unrelated owner edits, create a detached Git
worktree at the real committed HEAD in a new ignored owned directory; install and
prepare there. Preserve the original working tree and its owner edits. Do not
invent an identity or modify previous artifacts. Preparation refuses an existing
identity and exports `.scratch/matrix-source-ui/candidate/` with one complete
`lamplit-matrix-source-ui.tgz`, `identity.json`, three per-file SHA256 manifests and
`SOURCE_HEAD`. It includes browser, compiled contracts, all default runners,
Keet, thinking and Matrix fixtures/runners/docs, licenses and frozen package locks.
Owner approval of these exact bytes after Orc review gates both native workers.
App merge is gated on same-artifact Chat #3561 and CFL #3562 acceptance. After
squash merge, Orc binds host source pins to the actual merged commit with equal-tree
verification; never rebuild the approved bytes merely to change attribution.

Extract into a new test-owned directory, compare archive and manifest hashes with
identity, then verify manifests from `browser/`, `contracts/package/` and
`acceptance/`. Install `bun install --frozen-lockfile` in contracts then acceptance.
From acceptance, run the actual shared UI fixture:

```sh
APP_ACCEPTANCE_ASSETS=../browser APP_ACCEPTANCE_EVIDENCE=../matrix-evidence bun matrix-browser.mjs
```

Repeat manifests/hash checks after acceptance. Native runs use the same runner:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:TEST_PORT/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:CONTROL_PORT/__test/matrix-source-ui \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/matrix-evidence bun matrix-browser.mjs
```

Use `/chat` where testing the native hosted entry. `APP_ACCEPTANCE_BROWSER` can
select a test-owned Chromium executable. Keep actual native auth/socket adapters;
no public route interception or fabricated provenance DTO is allowed. The control
endpoint takes POST JSON, acknowledging only after native persistence and public
view publication settle:

| Action               | Native fixture responsibility                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reset`              | Reset only test-owned session/history/submissions and fake providers.                                                                                                                                                                                                                                        |
| `incoming`           | Feed a synthetic Matrix event through the actual stored ingress/adapter with `id` (fixture correlation), `senderId`, `senderDisplayName`, `roomId`, original multiline `text`, original numeric `createdAt`. `history: true` places it before the recent page. Preserve real scheduling; use fake providers. |
| `reminder`           | Publish an ordinary native reminder with its existing source.                                                                                                                                                                                                                                                |
| `complete`           | Complete the ordinary web submission using a fake provider with `普通回复`.                                                                                                                                                                                                                                  |
| `state`              | Return `{ submissions: string[] }` for ordinary web texts only, in order.                                                                                                                                                                                                                                    |
| `/disconnect` suffix | POST closes fixture observation sockets while retaining durable messages; native reconnect stays enabled.                                                                                                                                                                                                    |

Native fixtures include private `native-only context sentinel` attribution/context;
the runner checks it is absent from rendered public text. App fixture models only
the validated display seam. Native workers also verify restart persistence through
their existing owned fixture seam and retain public view/history evidence. The
runner checks original time/body, named/empty/Unicode/hostile labels, same room with
different senders, first open/reload/reconnect/history, no replay, web/reminder,
escaping/accessibility and 320/390/1280 light/dark screenshots. Run packaged Keet
and thinking regressions too. Record native commit/fake identity, exact App source
and all hashes, commands/results, screenshots and limits. App fixture PASS is not
native or joint PASS. No live deployment, new account/secrets, external sends or
production scheduling changes are part of this handoff.
