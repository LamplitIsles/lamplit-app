# Model and Fast settings

Settings offers exactly three radios: **6.1 sol** (`gpt-6.1-sol`), **5.6 sol**
(`gpt-5.6-sol`), and **6.1 terra** (`gpt-6.1-terra`). Selecting a different radio
saves directly, without a switch button. There is no reasoning-strength control.
Only small version text appears below the existing Lucide Sun/Earth icons in a
single row. No persistent explanatory or success copy is shown. A change applies
to the next reply, preserving the conversation and draft.
The Fast switch saves directly, and defaults to on for a new workspace.

The optional same-origin `/api/chat/models` endpoint is independent of the chat
socket and compiled contracts. GET returns `{sessionId, currentModel, fast, busy}`.
These are the confirmed preferences for future replies. POST accepts strict JSON
`{sessionId, expectedModel, expectedFast, model, fast}` and returns the same snapshot.
Only the three fixed IDs are writable. If a host reports an unknown model, the
UI shows its ID with all three radios unchecked until switched. Fast remains
disabled until a supported model is chosen.
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
Busy conversations disable both controls and offer Refresh. Existing settings remain
usable. The popover scrolls within the viewport on small screens.

CFL persists both preferences together for restart and requests them explicitly
on future native turns. The defaults are **6.1 sol** and Fast on. Legacy
`codex.model` and `codex.fast` entries in CFL configuration are ignored; the
saved preference controls both settings. Fast requests the priority tier; actual provider
availability depends on model and account support. Reasoning remains unchanged.

App spec #19 and CFL spec #20 govern this slice. Existing compiled contracts and
host pins stay unchanged. Backend deployment is separate from App changes.

After `bun run build`, `bun run test:models-browser` verifies direct radios and switch,
confirmed selection, loading/saving/busy/error/reload, preserved draft, keyboard,
unsupported hosts, and zh/en at mobile/desktop sizes. Test-owned fixtures and
screenshots live under `.scratch/dashboard-model-selector/browser`. CFL owns
fake-native persistence/next-turn acceptance; this runner does not call models.
