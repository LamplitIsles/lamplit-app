# Desktop companion notification acceptance

Spec #3214 covers desktop Safari/Chrome with an open, running chat page. Native
browser permission is requested synchronously on its first trusted click, only
when undecided and the API/secure context are available. Dismissal, promise
rejection or synchronous failure consumes the one page-lifetime attempt. Reload
permits a fresh attempt. No application permission marker or settings UI exists.

The first live ChatView and every changed session establish silent baselines.
Each subsequent newly observed complete `agent` message is recorded by stable ID
before checking permission/attention. Hidden OR unfocused qualifies; visible AND
focused stays silent. The same session retains observations through reconnect
and live-window eviction. Older-history reads, user/reminder/notice messages and
status-only transitions do not discover notifications. Multiple messages in a
turn can each notify, even before that turn later fails or stops. Failed delivery
and later permission/focus changes never replay an observation.

Title uses chat's displayed companion identity (appearance name, then live name,
then Lamplit); body uses the existing localized generic notice. Message text and
images never enter notification options. Click attempts originating-window focus
and closes the notice, even if focus fails. Page teardown removes the permission
listener, closes owned notices, detaches callbacks and rejects stale observations.
This is page observation, not durable delivery: closure, suspension, offline
periods and messages outside the live window have no delivery guarantee. There is
no Web Push, service worker notification path or cross-tab/device deduplication.

## Automated evidence

After the README's install/check/lint/format/test/build gates, run all documented
browser gates and `bun tests/notifications-browser.mjs` against the current build.
All state belongs to loopback ChatHost fixtures and isolated browser contexts.
The dedicated runner records native permission/construction calls with a fake API,
including trusted clicks, default/dismissal/rejection/throw, granted/denied,
unavailable/insecure contexts, attention, history, session/reconnect/eviction,
per-message semantics, displayed identity, Chinese/English bodies and errors.
Other App runners inject a denied fake to avoid real permission prompts.
`tests/notifications.test.ts` checks teardown and stale-owner replacement callbacks.

Chrome is the default. `APP_ACCEPTANCE_BROWSER=/absolute/path/to/test-owned/chromium`
selects an executable for every browser runner when Chrome is absent. Linux fake
results verify wiring and lifecycle, not Safari/macOS permission UI or OS display.

## Physical Mac Safari checklist — unverified

Record source commit, artifact identity, Mac model, macOS/Safari versions, exact
secure origin, site permission, system notification settings, Focus state and
observed result for each step. Use a test-owned host/conversation with synthetic
complete messages; obtain separate authorization for any live-service testing.

1. With site permission undecided, open the page: no request on load. Click the
   composer: Safari may show its permission UI. Grant it. Verify only this first
   click requests; dismissal/rejection must not prompt again until reload.
2. Keep the page visible/focused and deliver a complete reply: no system notice.
   Switch to another app while the window remains visible, then deliver two
   complete messages in one turn: expect two generic notices with display name
   and no preview. Also test a hidden tab. Later failed/stopped status adds none.
3. Repeat the same snapshot, reconnect, load older history and return to the
   window: no duplicate or foreground replay. Reload and change session:
   existing messages establish silent baselines without notices.
4. Click a notice: verify focus is attempted on its originating chat window and
   the notice closes. Record Safari/macOS behavior if focus is restricted.
5. Deny site permission, reload and click/send: chat still works without prompting
   or notices. Reset to undecided to test dismissal, then reload and retry.
6. With permission granted, disable system notifications or enable Focus, deliver
   a new message, then restore settings. Record suppression/delay behavior;
   this depends on macOS and is not proof of an App delivery failure.

No physical Mac was available for implementation acceptance. Actual Safari
permission presentation, OS notification display and click return remain
unverified. iPhone/iPad, Capacitor and mobile push remain outside this feature.
