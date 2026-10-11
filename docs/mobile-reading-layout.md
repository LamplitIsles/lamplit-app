# Shared chat reading layout

Incoming answers keep their side avatar and use more of the available row, with
matching outer timeline gutters. Short answers fit their text; desktop answers
retain a reading cap. Long code lines remain intact and wide tables scroll inside
their own containers. Horizontal gestures and normal vertical timeline reading
remain available; prose, inline code, links, images and expanded thinking stay
within the message.

Only long reminder-origin timeline bodies initially show two visual lines. Use
**Expand / Collapse** (展开 / 收起) to read the preserved text; short reminders have
no extra action. The source badge and time stay visible. Copy always uses the full
original text. Expansion is independent per mounted message and survives updates,
paging and reconnect with the same identity. Reload resets it. Width changes
remeasure the preview. Ordinary replies, Matrix/Keet inputs and the scheduled
reminder drawer retain their existing semantics.

## Agent verification and immutable handoff

Use Bun and an isolated Chrome context with test-owned loopback ChatHost data and
a recording clipboard fake. No live browser, provider, credentials or messages:

```sh
bun run build
bun tests/mobile-reading-browser.mjs
```

The focused runner uses actual compiled App assets and contracts at 320/390/1280,
light/dark, Framework7 Material and iOS themes (iPhone user-agent emulation).
It checks bounding boxes, short
and long reply widths, avatar placement, local code/table scroll extents and text,
Chromium touch-event panning on mobile and scripted local scrolling on desktop,
vertical reading, reminder keyboard controls/full copy/independent identity,
viewport remeasurement, paging/reconnect, unchanged ordinary/source messages,
images and expanded thinking. Adjacent panels/send/menu suites cover unchanged
flows. Inspect code, collapsed, expanded and desktop screenshots; passing geometry
alone is insufficient. CDP gestures are emulator evidence, not physical iOS/Android
or joint native-host acceptance.

After committing verified source from a clean checkout:

```sh
bun tests/prepare-default.mjs --mobile-reading-layout
```

This extends the existing complete export with the focused runner and this guide.
It refuses an existing identity at `.scratch/mobile-reading-layout/candidate-<source HEAD>`,
preserving all historical candidates. `identity.json` records exact source HEAD,
baseline, archive SHA256, three manifest hashes and focused runner SHA256.
Archive `lamplit-mobile-reading-layout.tgz` contains browser/contracts/acceptance,
frozen dependency locks and SOURCE_HEAD. Compare archive and manifest hashes with
identity before extracting into a fresh test-owned directory; check every file:

```sh
shasum -a 256 lamplit-mobile-reading-layout.tgz browser.sha256 contracts.sha256 acceptance.sha256
READING_ROOT=$(mktemp -d /tmp/lamplit-reading.XXXXXX)
tar -xzf lamplit-mobile-reading-layout.tgz -C "$READING_ROOT"
(cd "$READING_ROOT/browser" && shasum -a 256 -c ../browser.sha256)
(cd "$READING_ROOT/contracts/package" && shasum -a 256 -c ../../contracts.sha256)
(cd "$READING_ROOT/acceptance" && shasum -a 256 -c ../acceptance.sha256)
(cd "$READING_ROOT/contracts/package" && bun install --frozen-lockfile)
(cd "$READING_ROOT/acceptance" && bun install --frozen-lockfile)
(cd "$READING_ROOT/acceptance" && APP_ACCEPTANCE_ASSETS=../browser APP_ACCEPTANCE_EVIDENCE="$READING_ROOT/evidence" bun mobile-reading-browser.mjs)
```

Compare SOURCE_HEAD and the runner hash to identity, then repeat all per-file,
archive and manifest checks after the extracted run. Never rebuild or edit frozen
files. `APP_ACCEPTANCE_BROWSER` selects a test-owned Chromium executable;
`APP_ACCEPTANCE_EVIDENCE` selects a separate evidence directory. The focused runner
rejects external URLs and defines no new native control protocol. Later exact-byte
native consumption needs Owner approval and work in each owning repository.
This candidate does not merge, deploy or establish native/physical acceptance.
