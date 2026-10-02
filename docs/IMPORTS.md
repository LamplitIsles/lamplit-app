# Imported sources

The Framework7/Svelte chat surface under `apps/web/src/lib/companion`, supporting
client helpers, styles, localization messages, icons and app bootstrap were copied
from `LamplitIsles/codex-for-love`, branch `feat/framework7-companion`, commit
`17a786271f5498bf5a188f421e9ce02adf7262f9` on 2026-10-02 through `ssh nuc-kep`.
The frontend was subsequently synchronized with local CFL `main`, commit
`1263eb20c9a73462ba0ad48ee068635b97af004d` (Framework7 merge #57 and UI fixes #60/#62).
This includes its palette, message links, anchored long-press menus, typing motion,
settings, search presentation, reminder drawer and timeline behavior. The shared
controller, capability gates and streaming voice lifecycle remain app adaptations;
CFL's engine-specific controller and backend alarm persistence were not imported.
The source is Apache-2.0; this repository retains the Apache-2.0 license.

The engine-specific `Partner.svelte` controller was replaced with a shared
completed-message controller. Framework7 components, composer behavior, viewport
handling, Markdown and localization remain derived from that source. First-slice
presentation hides capabilities that have not yet been connected. No runtime state,
credentials, conversations or uncommitted source changes were imported.

Framework7, Svelte, Capacitor, Noto Sans SC, KaTeX, lucide-svelte and other dependencies
retain their respective upstream licenses in package distributions. Chord and
TypeBox are dependencies, not vendored source.

The streaming `voice-input.ts` lifecycle and `voice-worklet.js` were adapted from
`LamplitIsles/lamplit-chat`, commit
`8d3723e892c705960039ea77cc2d745c29d9f133` (read-only adjacent checkout), paths
`frontend/src/lib/companion/client/voice-input.ts` and `voice-worklet.js`.
`tests/voice-worklet.test.ts` derives from its `src/companion/voice-worklet.test.ts`.
That source is Apache-2.0, covered by this repository's retained Apache-2.0 license.
The adaptation uses the shared public contracts and the existing Framework7
composer instead of the imported CFL batch MediaRecorder/transcription path.
No provider keys, recordings, transcripts or runtime state were imported.
