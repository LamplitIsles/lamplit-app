# Lamplit shared chat

Terms for the shared chat experience across agent engines.

## Language

**Context usage（上下文使用量）**:
The amount of the current conversation context occupied relative to the selected model's capacity. It is distinct from cumulative token consumption or billing; a reported value and an estimate have different certainty.
_Avoid_: Lifetime token total, cost, memory size

**Conversation compaction（对话压缩）**:
An engine operation that condenses the active conversation context so the same conversation can continue. It does not create a new companion identity or delete the owner's conversation archive.
_Avoid_: New conversation, archive deletion, memory erasure

**CFL UI baseline（CFL 界面基准）**:
The existing CFL Framework7 chat design and interaction that the shared frontend preserves when replacing native frontends. Superseded Composer mockups are historical material rather than an alternative baseline.
_Avoid_: New Composer design, Pi-specific frontend
