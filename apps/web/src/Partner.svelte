<script lang="ts">
  import {
    APPEARANCE_PATH,
    validateChatAppearance,
    type ChatAppearance,
    mediaUrl,
    type ImageRef,
  } from "@lamplit/contracts";
  import { affinityStage } from "./lib/companion/domain.ts";
  import { onMount } from "svelte";
  import { f7, f7ready } from "framework7-svelte";
  import Companion from "./lib/companion/client/Companion.svelte";
  import { CompanionNotifications } from "./lib/companion/client/notifications.ts";
  import { ChatController } from "./lib/chat-controller.ts";
  import type {
    CompanionProjection,
    TimelineMessageUnit,
  } from "./lib/companion/projection.ts";
  import type { CompanionActions } from "./lib/companion/client/companion-bridge.ts";
  import { CompanionPreControllerError } from "./lib/companion/client/admission.ts";
  import { companionTranslate } from "./lib/companion/client/locale.ts";
  import {
    initialPreferences,
    resolveScheme,
    writePreference,
    LANGUAGE_STORAGE_KEY,
    APPEARANCE_STORAGE_KEY,
    SENTENCE_STORAGE_KEY,
    type CompanionLanguage,
    type CompanionAppearance,
  } from "./lib/companion/client/preferences.ts";
  import {
    VOICE_CAPABILITY_PATH,
    validateVoiceCapability,
  } from "@lamplit/contracts/voice";
  let voiceCapability = $state<"loading" | "available" | "unavailable">(
    "loading",
  );
  let revision = $state(0);
  let backgroundVersion = $state(0);
  let refreshBackgrounds = $state<() => Promise<boolean>>(async () => false);
  let profile = $state<ChatAppearance>();
  let controller: ChatController;
  const preferences = initialPreferences();
  let language = $state<CompanionLanguage>(preferences.language);
  let appearance = $state<CompanionAppearance>(preferences.appearance);
  let sentenceReplies = $state(preferences.sentenceReplies);
  let systemDark = $state(preferences.systemDark);
  const scheme = $derived(resolveScheme(appearance, systemDark));
  const t = $derived(companionTranslate(language));
  const stageKeys = {
    疏离: "affinity.distant",
    生疏: "affinity.unfamiliar",
    熟悉: "affinity.familiar",
    亲近: "affinity.close",
    深厚: "affinity.deep",
  } as const;
  $effect(() => {
    document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
    const dark = scheme === "dark";
    f7ready(() => f7.setDarkMode(dark));
  });
  const chatState = $derived.by(() => {
    void revision;
    return controller
      ? {
          view: controller.view,
          compactPending: controller.compactPending,
          older: controller.older,
          pending: controller.pending,
          localPreviews: controller.localPreviews,
          recovery: controller.recovery,
          connected: controller.connected,
          before: controller.before,
          loadingOlder: controller.loadingOlder,
          historySyncFailed: controller.historySyncFailed,
          error: controller.error,
          relationship: controller.relationship,
          history: controller.relationshipHistory,
          relationshipStatus: controller.relationshipStatus,
          loadingEarlier: controller.loadingRelationshipHistory,
          panelRevision: controller.panelRevision,
        }
      : undefined;
  });
  const readiness = $derived(
    chatState?.view ? "ready" : chatState?.error ? "error" : "loading",
  );
  // Keep optimistic sends at their original point until the server supplies
  // their authoritative position. Keys survive a retry's new operation ID.
  const pendingAnchors = new Map<string, {
    sessionId: string;
    after: string | null;
    predecessor?: { logicalId: string; operationId: string };
  }>();
  const projection = $derived.by((): CompanionProjection => {
    const view = chatState?.view;
    const messages = [...(chatState?.older ?? []), ...(view?.messages ?? [])];
    const unique = [...new Map(messages.map((m) => [m.id, m])).values()];
    const pending = chatState?.pending ?? [];
    const previews = chatState?.localPreviews ?? [];
    const active = new Set(pending.map((p) => p.logicalId ?? p.operationId));
    for (const [key, anchor] of pendingAnchors) {
      if (anchor.sessionId !== view?.sessionId || !active.has(key)) pendingAnchors.delete(key);
    }
    // A retried message can arrive before its verified image mapping. Keep the
    // original preview visible until that mapping is available.
    const visible = unique.filter((m) => !pending.some((p) =>
      p.operationId === m.operationId && p.retrySource && previews.some((preview) =>
        preview.sessionId === view?.sessionId && preview.operationId === p.retrySource,
      ),
    ));
    const units: TimelineMessageUnit[] = visible.map((m) => {
      const local = previews.filter((preview) =>
        preview.sessionId === view?.sessionId && preview.operationId === m.operationId,
      );
      const unitId = local.length ? `local:${local[0]!.draftId}` : m.id;
      const mediaId = m.imageState ? `${m.id}:image:` : undefined;
      return {
          id: unitId,
          answer: m.role === "agent" && !m.source,
          streaming: m.textState === "streaming",
          thinking: m.role === "agent" ? m.thinking : undefined,
          alarm: m.source?.kind === "reminder",
          keet: m.source?.kind === "keet" ? m.source : undefined,
          matrix: m.source?.kind === "matrix" ? m.source : undefined,
          post: m.source?.kind === "post" ? m.source : undefined,
          side: m.role === "user" && !m.source ? "outgoing" : "incoming",
          time: m.createdAt,
          items: [
            ...(m.imageState && m.imageState !== "ready" ? [{
              id: mediaId!,
              messageKey: unitId,
              kind: "image" as const,
              side: "incoming" as const,
              state: m.imageState === "preparing" ? "running" as const : "failed" as const,
              alt: t("image.preview"),
              ...(m.imageState === "unknown" ? { error: t("image.statusUnknown") } : {}),
            }] : []),
            ...(m.images ?? []).map((image) => {
              const localImage = local.find((preview) => preview.attachmentId === image.attachmentId);
              return {
              id: mediaId ?? (localImage ? `${unitId}:${localImage.draftId}` : `${m.id}:${image.attachmentId}`),
              messageKey: unitId,
              kind: "image" as const,
              side:
                m.role === "user" && !m.source
                  ? ("outgoing" as const)
                  : ("incoming" as const),
              state:
                image.availability === "available"
                  ? ("ready" as const)
                  : ("failed" as const),
              attachment: image,
              ...(localImage ? { previewUrl: localImage.previewUrl } : {}),
              alt: image.name,
            }; }),
            ...(m.text
              ? [
                  {
                    id: local.length ? `${unitId}:text:` : m.id,
                    messageKey: unitId,
                    kind: m.role === "notice" ? "notice" : "text",
                    side:
                      m.role === "user" && !m.source ? "outgoing" : "incoming",
                    text: m.text,
                  },
                ]
              : []),
            ...(m.voice
              ? [{
                  id: `${m.id}:voice:`,
                  messageKey: m.id,
                  kind: "voice" as const,
                  side: "incoming" as const,
                  url: `/api/audio/${m.voice.id}.mp3`,
                  time: m.createdAt,
                }]
              : []),
          ],
        } as TimelineMessageUnit;
    });
    const positions: Array<{ kind: "message" | "pending"; id: string; sourceId?: string }> =
      visible.map((m) => ({ kind: "message", id: m.id, sourceId: m.id }));
    const tails = new Map<string | null, string>();
    for (const p of pending)
      if (!visible.some((m) => m.operationId === p.operationId)) {
        const logicalId = p.logicalId ?? p.operationId;
        if (!pendingAnchors.has(logicalId) && view)
          pendingAnchors.set(logicalId, { sessionId: view.sessionId, after: unique.at(-1)?.id ?? null });
        const unitId = p.previews?.length ? `local:${p.previews[0]!.id}` : p.logicalId ?? p.operationId;
        const unit: TimelineMessageUnit = {
          id: unitId,
          side: "outgoing",
          time: p.createdAt,
          pending: p.state === "sending",
          failed: p.state === "failed",
          actionId: p.logicalId ?? p.operationId,
          pendingLabel:
            p.state === "sending" ? t("delivery.sending") : undefined,
          items: [
            ...(p.previews
              ? p.previews.map((image) => ({
                  id: `${unitId}:${image.id}`,
                  messageKey: unitId,
                  kind: "image" as const,
                  side: "outgoing" as const,
                  state: "ready" as const,
                  previewUrl: image.previewUrl,
                  alt: image.name,
                }))
              : (p.images ?? []).map((image) => ({
                  id: `${p.operationId}:${image.attachmentId}`,
                  messageKey: p.logicalId ?? p.operationId,
                  kind: "image" as const,
                  side: "outgoing" as const,
                  state: "ready" as const,
                  attachment: image,
                  alt: image.name,
                }))),
            ...(!p.previews && !p.images && p.localImageCount
              ? Array.from({ length: p.localImageCount }, (_, index) => ({
                  id: `${p.operationId}:missing:${index}`,
                  messageKey: p.logicalId ?? p.operationId,
                  kind: "image" as const,
                  side: "outgoing" as const,
                  state: "failed" as const,
                  alt: t("image.failed"),
                }))
              : []),
            ...(p.text
              ? [
                  {
                    id: p.previews?.length ? `${unitId}:text:` : p.operationId,
                    messageKey: unitId,
                    kind: "text" as const,
                    side: "outgoing" as const,
                    text: p.text,
                  },
                ]
              : []),
          ],
        };
        const observed = unique.findIndex((m) => m.operationId === p.operationId);
        let at = units.length;
        if (observed >= 0) {
          for (const next of unique.slice(observed + 1)) {
            const index = positions.findIndex((position) => position.sourceId === next.id);
            if (index >= 0) { at = index; break; }
          }
        } else {
          const anchor = pendingAnchors.get(logicalId);
          const after = anchor?.after ?? null;
          const predecessor = anchor?.predecessor;
          const previousPending = pending.find((item) => (item.logicalId ?? item.operationId) === predecessor?.logicalId);
          if (predecessor && previousPending) predecessor.operationId = previousPending.operationId;
          const previousMessage = predecessor && unique.find((message) => message.operationId === predecessor.operationId);
          const previousIndex = predecessor ? positions.findIndex((position) =>
            (position.kind === "pending" && position.id === predecessor.logicalId) ||
              (previousMessage && position.sourceId === previousMessage.id),
          ) : -1;
          const tail = tails.get(after);
          const index = tail
            ? positions.findIndex((position) => position.kind === "pending" && position.id === tail)
            : positions.findIndex((position) => position.sourceId === after);
          const latestIndex = Math.max(previousIndex, index);
          at = latestIndex >= 0 ? latestIndex + 1 : after === null && !tail ? 0 : units.length;
          tails.set(after, logicalId);
        }
        units.splice(at, 0, unit);
        positions.splice(at, 0, { kind: "pending", id: logicalId, ...(observed >= 0 ? { sourceId: unique[observed]!.id } : {}) });
      }
    const preview = chatState?.connected ? view?.streamingReply : undefined;
    if (preview?.text && !unique.some((message) => message.id === preview.id)) {
      const key = `preview:${preview.id}`;
      const position = units.findIndex(
        (unit) => (unit.time ?? 0) > preview.createdAt,
      );
      units.splice(position < 0 ? units.length : position, 0, {
        id: key,
        side: "incoming",
        time: preview.createdAt,
        answer: true,
        streaming: true,
        items: [
          {
            id: key,
            messageKey: key,
            kind: "text",
            side: "incoming",
            text: preview.text,
          },
        ],
      });
    }
    const compacting =
      !!chatState?.compactPending || view?.compaction?.status === "running";
    return {
      items: units.flatMap((u) => u.items),
      messageUnits: units,
      pendingCount: chatState?.pending.length ?? 0,
      running: !!view?.activeTurnId,
      replyCompleted:
        !!view?.activeTurnId && view.replyCompletedTurnId === view.activeTurnId,
      canSubmit: !!chatState?.connected && !compacting,
      status: !chatState?.connected
        ? "offline"
        : view?.activeTurnId || compacting
          ? "working"
          : "ready",
      openState: view ? "open" : readiness === "error" ? "error" : "loading",
      hasMore: !!chatState?.before,
      loadingOlder: !!chatState?.loadingOlder,
      historySyncFailed: !!chatState?.historySyncFailed,
      promptError: chatState?.error,
    };
  });
  $effect(() => {
    const state = chatState;
    if (!state?.view) return;
    const retained = new Set([
      ...state.older.map((message) => message.operationId),
      ...state.view.messages.map((message) => message.operationId),
      ...state.pending.flatMap((item) => [item.operationId, item.retrySource]),
    ]);
    for (const operationId of new Set(state.localPreviews.map((item) => item.operationId))) {
      if (!retained.has(operationId)) controller.releasePreviews(state.view.sessionId, operationId);
    }
  });
  const recovered = $derived.by(() => {
    const native = chatState?.recovery[0];
    if (native)
      return {
        ...native,
        sourceIds: [native.sourceId],
        localPendingKey: chatState?.pending.find(
          (p) => p.operationId === native.operationId && p.state === "failed",
        )?.operationId,
      };
    return undefined;
  });
  const actions: CompanionActions = {
    async send(text, images, retire, sources) {
      if (!controller?.connected)
        throw new CompanionPreControllerError("请等待连接恢复后发送文字。");
      if (controller.pending.length >= 20)
        throw new CompanionPreControllerError("请先核对尚未确认的消息。");
      const originSession = controller.view?.sessionId;
      try {
        const previous = new Set(controller.pending.map((p) => p.logicalId ?? p.operationId));
        const predecessor = controller.pending.at(-1);
        const after = [...controller.older, ...(controller.view?.messages ?? [])].at(-1)?.id ?? null;
        const send = controller.send(text, retire, images, sources);
        for (const p of controller.pending) {
          const key = p.logicalId ?? p.operationId;
          if (!previous.has(key) && originSession) pendingAnchors.set(key, {
            sessionId: originSession, after,
            ...(predecessor ? { predecessor: { logicalId: predecessor.logicalId ?? predecessor.operationId, operationId: predecessor.operationId } } : {}),
          });
        }
        await send;
      } catch (error) {
        if (controller.view?.sessionId !== originSession)
          throw new CompanionPreControllerError("会话已改变");
        controller.error = error instanceof Error ? error.message : "发送失败";
        revision += 1;
        throw new CompanionPreControllerError(controller.error);
      }
    },
    retryFailed: (key) => controller.retryFailed(key),
    deleteFailed: (key) => controller.deleteFailed(key),
    dismissRecovery: (key) => controller.dismissRecovery(key),
    attachmentUrl: async (attachment) => {
      const ref = attachment as ImageRef;
      const response = await fetch(mediaUrl(ref.attachmentId), {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Missing image");
      return URL.createObjectURL(await response.blob());
    },
    search: (input) => controller.readSearch("search", input),
    searchRead: (input) => controller.readSearch("searchRead", input),
    readPanel: (method, input) => controller.readPanel(method, input),
    refreshRelationship: (history) => controller.refreshRelationship(history),
    retryHistory: () => void controller.refreshRelationship(true),
    retryChatHistory: () => controller.retryHistory(),
    loadEarlierHistory: () => controller.loadRelationshipHistory(),
    stop: () => controller.stop(),
    loadOlder: () => controller.loadOlder(),
  };
  onMount(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const updateScheme = () => {
      systemDark = media.matches;
    };
    updateScheme();
    media.addEventListener("change", updateScheme);
    const abort = new AbortController();
    let appearanceRequest = 0;
    refreshBackgrounds = async () => {
      const current = ++appearanceRequest;
      try {
        const response = await fetch(APPEARANCE_PATH, {
          signal: abort.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Appearance unavailable");
        const value = validateChatAppearance(await response.json());
        if (abort.signal.aborted || current !== appearanceRequest) return false;
        profile = value;
        backgroundVersion += 1;
        return true;
      } catch {
        return false;
      }
    };
    void refreshBackgrounds();
    let voiceRequest = 0;
    const refreshVoiceCapability = () => {
      const current = ++voiceRequest;
      void fetch(VOICE_CAPABILITY_PATH, {
        signal: abort.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Voice unavailable");
          const capability = validateVoiceCapability(await response.json());
          if (!abort.signal.aborted && current === voiceRequest)
            voiceCapability = capability.available ? "available" : "unavailable";
        })
        .catch(() => {
          if (!abort.signal.aborted && current === voiceRequest)
            voiceCapability = "unavailable";
        });
    };
    refreshVoiceCapability();
    window.addEventListener(
      "companion-voice-settings-changed",
      refreshVoiceCapability,
    );
    const notifications = new CompanionNotifications(window, document, () => ({
      title: profile?.companionName || controller.view?.name || "Lamplit",
      body: t("notifications.newMessage"),
    }));
    controller = new ChatController(
      () => {
        revision += 1;
      },
      localStorage,
      (view) => notifications.observe(view),
    );
    revision += 1;
    controller.setVisible(!document.hidden);
    controller.start();
    const visibility = () => controller.setVisible(!document.hidden);
    const recover = () => controller.recover(false);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", recover);
    window.addEventListener("pageshow", recover);
    document.addEventListener("pointerdown", recover);
    document.addEventListener("keydown", recover);
    return () => {
      media.removeEventListener("change", updateScheme);
      abort.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", recover);
      window.removeEventListener(
        "companion-voice-settings-changed",
        refreshVoiceCapability,
      );
      window.removeEventListener("pageshow", recover);
      document.removeEventListener("pointerdown", recover);
      document.removeEventListener("keydown", recover);
      notifications.close();
      controller.close();
    };
  });
</script>

<svelte:head
  ><title>{profile?.companionName || chatState?.view?.name || "Lamplit"}</title
  ></svelte:head
>
<Companion
  on:recovery={() => controller.recover()}
  {projection}
  backgrounds={profile?.backgrounds}
  {backgroundVersion}
  {refreshBackgrounds}
  continuity={{
    contextPressure: chatState?.view?.contextUsage,
    lifecycle: chatState?.view?.compaction,
  }}
  {actions}
  {t}
  locale={language}
  {appearance}
  {sentenceReplies}
  onSentenceRepliesChange={(value) => {
    sentenceReplies = value;
    writePreference(SENTENCE_STORAGE_KEY, String(value));
  }}
  panelRevision={chatState?.panelRevision ?? 0}
  history={{
    status: chatState?.relationshipStatus ?? "loading",
    records: chatState?.history.records ?? [],
    hasEarlier: !!chatState?.history.nextCursor,
    predecessor: chatState?.history.predecessor ?? undefined,
    loadingEarlier: chatState?.loadingEarlier,
  }}
  onLanguageChange={(value) => {
    language = value;
    writePreference(LANGUAGE_STORAGE_KEY, value);
  }}
  onAppearanceChange={(value) => {
    appearance = value;
    writePreference(APPEARANCE_STORAGE_KEY, value);
  }}
  imageLimits={chatState?.view?.capabilities.images || undefined}
  workspaceImages={chatState?.view?.capabilities.workspaceImages === true}
  recoveredDraft={recovered
    ? {
        key: recovered.sourceId,
        localPendingKey: recovered.localPendingKey,
        sourceIds: recovered.sourceIds,
        input: recovered.text,
        replacementEligible: recovered.replacementEligible,
        images: recovered.images.map((image) => ({
          id: image.attachmentId,
          name: image.name,
          url: mediaUrl(image.attachmentId),
        })),
      }
    : undefined}
  onHistoryOpenChange={undefined}
  sessionId={chatState?.view?.sessionId}
  {voiceCapability}
  identity={{
    companionName: profile?.companionName || chatState?.view?.name || "Lamplit",
    companionAvatar: profile?.companionAvatar,
    userAvatar: profile?.userAvatar,
    userName: profile?.userName || t("you"),
    preferredAddress: profile?.userName || t("you"),
    signature: chatState?.relationship?.current.signature ?? t("loading"),
    moodLabel: chatState?.relationship
      ? t(`mood.${chatState.relationship.current.mood}`)
      : t(
          chatState?.relationshipStatus === "error"
            ? "relationship.failed"
            : "loading",
        ),
    mood: chatState?.relationship?.current.mood ?? "neutral",
    moodNote: chatState?.relationship?.current.note,
    affinity: chatState?.relationship?.current.affinity,
    affinityStage: chatState?.relationship
      ? t(stageKeys[affinityStage(chatState.relationship.current.affinity)])
      : undefined,
  }}
  workspaceReadiness={readiness}
  sessionReadiness={readiness}
/>
