# Lamplit shared chat

Terms for the shared chat experience across agent engines.

## Language

**Conversation archive（聊天档案）**:
The owner's preserved conversations, including past and imported conversations, available for reading and search. The archive is distinct from the current model context and the companion's selected memories.
_Avoid_: Active context, companion memory

**Search hit（搜索命中）**:
One preserved message or compaction summary that matches a search query. A hit is one record rather than a matching conversation; identical text in different records remains distinct.
_Avoid_: Matching session, matching text alone

**Conversation context（聊天前后文）**:
The nearby conversation records surrounding a selected archive record on its original conversation path. Reading this context does not make that conversation the active chat.
_Avoid_: Model context, resumed conversation

**Compaction summary（压缩摘要）**:
The engine's preserved condensed account of a conversation, available as an archive record in search and read-only context. It is distinct from messages the owner or companion actually said and from a compaction-completion marker.
_Avoid_: Assistant reply, completion notice

**Context usage（上下文使用量）**:
The amount of the current conversation context occupied relative to the selected model's capacity. It is distinct from cumulative token consumption or billing; a reported value and an estimate have different certainty.
_Avoid_: Lifetime token total, cost, memory size

**Conversation compaction（对话压缩）**:
An engine operation that condenses the active conversation context so the same conversation can continue. It does not create a new companion identity or delete the owner's conversation archive.
_Avoid_: New conversation, archive deletion, memory erasure

**CFL UI baseline（CFL 界面基准）**:
The existing CFL Framework7 chat design and interaction that the shared frontend preserves when replacing native frontends. Superseded Composer mockups are historical material rather than an alternative baseline.
_Avoid_: New Composer design, Pi-specific frontend
