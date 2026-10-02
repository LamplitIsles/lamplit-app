# CFL UI baseline and shared compaction

Status: App implementation and fixture acceptance prepared under spec #3119.
Owner review/final freeze and actual Pi/CFL joint acceptance remain pending.
Recorded 2026-10-03.

## User decisions

The complete proposed Composer redesign is superseded, including its attachment-thumbnail design. Preserve CFL's existing Framework7 layout, theme and interactions as the shared app's replacement behavior. Do not implement the old compact/multiline redesign or use its Penpot board as an acceptance requirement. Existing image sending, previews, removal and safe recovery remain required functionality; their presentation must follow CFL.

The previous image slice added explicit 96px attachment rules in the shared Companion CSS and measured those sizes in its runner. These are implemented historical results, not a continuing design requirement. A subsequent implementation must compare against native CFL, restore its attachment presentation and update presentation assertions accordingly while preserving functional assertions. Superseding a document does not itself change shipped code.

Expose context usage and manual `/compact` through the same frontend and public protocol for Pi and CFL. The existing upper-right usage ring is the presentation reference. Successful compaction ends the running state and updates available context usage without a success toast, status sentence or inserted timeline marker. Remove both completed-status presentation and the "已整理对话" history marker from native CFL and the shared app; do not delete native compaction records needed for execution, continuation or search.

## Verified repository facts

- CFL Partner already reads `thread/tokenUsage/updated`, storing the latest context tokens and model context window. Native Partner handles bare `/compact` without images through its compact endpoint; native compaction refuses while conversation work is active.
- PiSession already exposes a guarded native `compact()` backed by the Pi lane. Its SDK exposes `estimateContextTokens`, which combines recent provider usage and estimated trailing messages. Session-wide accumulated usage is not the meter input. Building the exact active context and obtaining the selected model capacity still need implementation verification.
- The shared public chat contract now exposes nullable context usage and native compaction lifecycle plus the explicit compact operation. Partner binds these native observations to the existing Companion ring and command suggestion. See [contract and acceptance handoff](quiet-compaction.md).

## Agent-owned scope choices

Keep native execution as the authority. Translate the command into an explicit compaction operation, never a normal chat message. Preserve CFL's bare-command/no-image behavior and refusal while busy; do not introduce queued compaction, custom focus arguments or a second summarizer.

Running and failed feedback remain available using the CFL conventions; success is silent. Reconnect must reconcile the native running/finished state without issuing compaction again. Automatic and manual successful compaction use the same silent completion presentation.

Display the native context-usage value directly, without an "estimated" label or explanatory copy. Preserve CFL's understated ring presentation. When native usage is unavailable, display zero (an empty ring and zero for any existing numeric display), without a question mark, unknown label or extra notice. Preserve unavailable data as unavailable internally; zero is the presentation default, not a fabricated native measurement.

## Pi TUI reference verified 2026-10-03

Reference repository: `/Users/neil/code/projects/earendil-works/pi`. `packages/coding-agent/src/core/agent-session.ts`, `getContextUsage()`, derives the model context window and active session projection. `core/compaction/compaction.ts` derives valid provider usage plus trailing-message estimates, avoiding stale usage after edits or compaction. This is active-context usage, not cumulative session billing.

The interactive `modes/interactive/components/footer.ts` displays the value directly (percentage and capacity), with no estimate label. After compaction, `getContextUsage()` returns unavailable tokens/percentage until a valid post-compaction assistant usage exists; its terminal footer displays `?`. The user explicitly chose a quieter shared-app presentation instead: immediately retire pre-compaction usage and display zero until fresh native usage arrives, then update normally. Keep the known capacity. Do not retain the old full ring or emit a success marker; no question mark or explanatory feedback is added.

Pi-on-Workers uses a different harness facade from the coding-agent TUI. Reuse its supported active-context projection and estimation primitives to reproduce these semantics; do not import the interactive session/controller or add a TUI dependency. The exact facade remains an implementation-owned verification task.

Out of scope: changing compaction prompts or algorithms, changing automatic thresholds, message search implementation, replying aloud, plugin infrastructure, deployment or product code changes during this design discussion.
