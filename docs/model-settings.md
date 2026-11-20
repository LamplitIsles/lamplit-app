# Model and Fast settings

Settings renders the models advertised by an upgraded host as radios, with a
compact **Thinking strength** select and the existing Fast switch. Available
strengths are specific to the selected model: Low, Medium, High, Extra high and
Max where advertised. Codex default clears the explicit preference. Ultra
is not offered. Changing models retains the explicit strength when supported,
and otherwise clears it in the same save. Fast remains independent. A change
applies to the next reply, preserving the conversation and draft. Availability
of 6.2 sol depends on the host; it does not change the saved model or default.

The optional same-origin `/api/chat/models` endpoint is independent of the chat
socket and compiled contracts. GET returns `{sessionId, currentModel, fast, busy}`;
upgraded hosts also return `reasoningEffort` (nullable) and `availableModels`
(ordered `{id, name, reasoningEfforts}` entries). These are confirmed preferences
for future replies. POST accepts `{sessionId, expectedModel, expectedFast, model,
fast}`; upgraded requests add `expectedReasoningEffort` and `reasoningEffort`
together. A host returning neither extension field keeps the original three
radios (6.1 sol, 5.6 sol, 6.1 terra), Fast control, and exact legacy POST shape.
If the host reports a current model outside its choices, the UI shows its ID and
leaves radios unchecked until switched; Fast and Thinking strength are disabled.
IDs are trimmed single-line strings, 1–200 characters; session IDs allow 1–300.

Hosts enforce authentication/same-origin, recheck authorization at commit,
serialize against conversation work, persist workspace preference atomically,
and send `Cache-Control: no-store`. Errors use `{error: {code, message}}`:
400 `invalid_request`/`invalid_model`, 401/403 authentication, 409 `stale_model` or
`model_busy`, and 503 `model_unavailable`. No paths or secrets in errors.

Reload on settings open unless a save is in flight; the pending save stays
locked across closing and reopening. GET 404/405/501 hides model controls. Other
failures offer Refresh and disable controls until a successful read. Writes are
never automatically replayed, including after a lost response. Preserve the
confirmed radio and switch while saving; manually refresh to reconcile ambiguous results.
Busy conversations disable the controls and offer Refresh. The settings landing
page shows the appearance entry and supported host configuration entries. Each
entry opens its own page; the back button and browser history return to settings
and then to chat without discarding the draft. On small screens the page scrolls
within the viewport.

The shared App uses sv-router hash routes: `#/settings`,
`#/settings/appearance`, `#/settings/models`, and `#/settings/voice-output`.
Existing `#settings`, `#settings/appearance`, `#settings/models`, and
`#settings/voice-output` bookmarks are normalized to their corresponding new
routes. The retired `#settings/voice` bookmark opens `#/settings`, since the App
does not expose voice-input settings. Direct settings links provide a back path
to the settings landing page and chat; the host pathname and query are preserved.

CFL persists preferences together for restart and requests them explicitly
on future native turns. The defaults are **6.1 sol** and Fast on. Legacy
`codex.model` and `codex.fast` entries in CFL configuration are ignored; the
saved preference controls these settings. Fast requests the priority tier; actual provider
availability depends on model and account support. A null thinking strength follows
Codex configuration.

App spec #6086 and CFL spec #6087 govern the extended settings. Existing compiled contracts and
host pins stay unchanged. Backend deployment is separate from App changes.

After `bun run build`, `bun run test:models-browser` verifies advertised choices, thinking strength, legacy radios and switch,
confirmed selection, loading/saving/busy/error/reload, preserved draft, keyboard,
unsupported hosts, and zh/en at mobile/desktop sizes. Test-owned fixtures and
screenshots live under `.scratch/dashboard-model-selector/browser`. CFL owns
fake-native persistence/next-turn acceptance; this runner does not call models.

The App no longer exposes voice-input settings; host voice-input configuration and
endpoints remain outside this App change.

Voice output has a separate optional host settings page for MiniMax, Alibaba,
ByteDance, and ElevenLabs. The settings interface opens the provider and
ElevenLabs voice pickers; the ElevenLabs picker lists saved account voices and
offers manual voice ID entry. Other providers use a voice ID field. Key saves
and provider/voice activation are separate actions; keys are never returned to
the browser. MiniMax authentication remains on the host. Unsupported hosts
hide the voice-output card when unsupported. The host contracts are
`/api/tts/settings`, `/api/tts/settings/key`, and
`/api/tts/elevenlabs/voices`; FlickNote #46 and #47 specify their fields.
After `bun run build`, `bun tests/voice-output-settings-browser.mjs` exercises
the controls with fake settings and voice responses on mobile and desktop.

The Appearance page also supports optional host-provided background settings.
`GET /api/background-settings` returns `{landscape, portrait}` booleans for
the two configured slots. `POST /api/background-settings/{landscape|portrait}`
sends one image body and returns the confirmed snapshot. An unsupported host
hides this editor. The host validates and stores the image; settings refresh the
appearance and reload background assets after a confirmed save or reconciliation.
If the appearance refresh fails after a confirmed upload, the settings page offers
an explicit refresh without repeating the upload.
An ambiguous upload is never replayed automatically. The existing appearance
response and authenticated background asset URLs retain their contract. A host
may use one configured image for both orientations until the other is supplied.
