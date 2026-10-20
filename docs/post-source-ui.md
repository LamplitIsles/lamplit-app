# Post source presentation (#4352)

The backend-owned `MessageSource` union adds `{ kind: 'post', platform: 'qq' |
'matrix', conversationType: 'group' | 'direct', conversationId, conversationName?,
senderId, senderDisplayName? }`. IDs are exact nonempty strings, at most 256 UTF-16
units (matching Post's native ID bound). Optional names must contain a nonblank
character and contain at most 256 Unicode code points. Producers normalize names;
App never invents names or parses message prefixes. Unknown fields are rejected;
browser submissions cannot provide source. No account IDs, delivery IDs, raw
native events, credentials or private execution context belong in this display DTO.

The existing Framework7 message shows an incoming Q/M avatar, QQ/Matrix and
localized group/direct badge, sender and conversation names, with exact ID fallback
only for each missing name. Labels are literal escaped text. The first body part
gets the header; original `ChatMessage.text` and existing authenticated images keep
their existing rendering. External bubble styling is shared with Keet/legacy
Matrix in both palettes. No remote name discovery or persistence is added.

Run `bun test tests/post.test.ts`, default test/check/build, then
`bun tests/post-browser.mjs`, `bun tests/matrix-browser.mjs`,
`bun tests/keet-browser.mjs` and `bun tests/thinking-browser.mjs` using Bun 1.3.14.
The Post runner checks QQ group/direct and Matrix, names/fallback, hostile and
long Unicode names, original multiline body/images, desktop/mobile light/dark,
reload/reconnect/history/no resubmission, web and reminder controls. It uses only
owned fixture state and denied native notifications. This proves App display
capability; CFL must separately prove native receiver → durable source → public
ChatView → these exact browser bytes. It does not establish native acceptance.

After a scoped commit from a clean checkout, run
`bun tests/prepare-default.mjs --post-source-ui`. Its exclusive
`.scratch/post-source-rendering/candidate-<HEAD>/` contains the source archive,
complete browser/contracts/acceptance archive, licenses, frozen acceptance locks,
SOURCE_HEAD, three manifests and identity with real source HEAD/tree and hashes.
Post preparation builds in the current clean checkout, without another source checkout.
Verify archive/manifest hashes, extract into a fresh owned directory and check each
manifest from browser/, contracts/package/ and acceptance/. Install frozen locks
in contracts/package then acceptance; run the packaged runner with
`APP_ACCEPTANCE_ASSETS=../browser APP_ACCEPTANCE_EVIDENCE=../post-evidence bun post-browser.mjs`.
Native CFL uses `APP_ACCEPTANCE_URL` and `APP_ACCEPTANCE_CONTROL_URL` to its owned
real adapter fixture. The control route accepts reset/incoming/reminder/complete/
state and a `/disconnect` suffix as in the existing Matrix runner. Incoming takes
correlation id, original text/createdAt/images, history and source fields; native
controls must derive public source through real ingress/storage, never inject the
public DTO. No real accounts, providers, messages or services are used. Owner holds
independent review and controls merge/deployment; App fixture PASS is not joint PASS.
