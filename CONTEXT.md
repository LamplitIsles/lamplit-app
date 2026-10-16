# Lamplit shared chat

Terms for the shared chat experience across agent engines.

## Language

**Companion notification（聊天提醒）**:
A privacy-preserving notice that identifies the companion and announces a newly completed reply without revealing message content. It is distinct from the reply itself and from execution-status updates.
_Avoid_: Message preview, turn status, delivery guarantee

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

**Message submission（消息提交）**:
The owner's message being received for conversation, independently of the companion's reply. A failed or stopped reply does not make a received message fail.
_Avoid_: Reply completion, model processing

**Failed submission（发送失败）**:
A message confirmed not received. It remains available to retry or delete; waiting for confirmation alone is not failure.
_Avoid_: Disconnected message, failed reply

**Retry（重试）**:
Sending a failed message's original content again, directly from that message, while keeping any new draft untouched.
_Avoid_: Restore to edit, automatic resend

**Deleted failed message（已删除的失败消息）**:
A failed message the owner has confirmed removing from the conversation. Deleting it does not remove other messages or photos.
_Avoid_: Undo, archive deletion

**Input recovery（输入恢复）**:
Explicit editing of independently withdrawn input before processing. Failed web submissions instead offer direct Retry or Delete.
A temporary disconnect or stopped/failed reply does not make input recoverable.
_Avoid_: Automatic replay, recovery inferred from null lookup

**Local capture readiness（本地录音就绪）**:
The microphone is producing audio for the current dictation take, so the owner can
speak and stop recording. This is distinct from recognition readiness.
_Avoid_: Recognition connected, transcript ready

**Recognition readiness（识别就绪）**:
The speech service is ready to receive the current take's audio. Local recording
may already be underway; recognized text becomes an editable draft only on completion.
_Avoid_: Microphone permission, recording started, message sent

**Sentence bubble（分句气泡）**:
A readable piece of one companion reply; several bubbles do not become separate preserved messages.
_Avoid_: Separate message, saved sentence

**In-progress reply（生成中的回复）**:
A reply still being produced, distinct from the completed reply preserved in conversation history.
_Avoid_: Completed reply, preserved message
