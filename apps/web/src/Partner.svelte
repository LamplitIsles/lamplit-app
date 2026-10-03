<script lang="ts">
  import { mediaUrl, type ImageRef } from "@lamplit/contracts";
  import { affinityStage } from "./lib/companion/domain.ts";
  import { onMount } from "svelte";
  import { f7, f7ready } from "framework7-svelte";
  import Companion from "./lib/companion/client/Companion.svelte";
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
  let controller: ChatController;
  const preferences = initialPreferences();
  let language = $state<CompanionLanguage>(preferences.language);
  let appearance = $state<CompanionAppearance>(preferences.appearance);
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
          recovery: controller.recovery,
          connected: controller.connected,
          before: controller.before,
          loadingOlder: controller.loadingOlder,
          error: controller.error,
          relationship: controller.relationship,
          history: controller.relationshipHistory,
          relationshipStatus: controller.relationshipStatus,
          loadingEarlier: controller.loadingRelationshipHistory,
          panelRevision: controller.panelRevision,
        }
      : undefined;
  });
  const projection = $derived.by((): CompanionProjection => {
    const view = chatState?.view;
    const messages = [...(chatState?.older ?? []), ...(view?.messages ?? [])];
    const unique = [...new Map(messages.map((m) => [m.id, m])).values()];
    const units: TimelineMessageUnit[] = unique.map(
      (m) =>
        ({
          id: m.id,
          alarm: m.source?.kind === "reminder",
          side: m.role === "user" && !m.source ? "outgoing" : "incoming",
          time: m.createdAt,
          pending:
            m.role === "user" && !!m.delivery && m.delivery !== "consumed",
          pendingLabel:
            m.role !== "user" || !m.delivery || m.delivery === "consumed"
              ? undefined
              : m.delivery === "pending"
                ? "等待接收"
                : m.delivery === "unconsumed"
                  ? "未消费"
                  : m.delivery === "uncertain"
                    ? "待确认"
                    : "未被接收",
          items: [
            ...(m.images ?? []).map((image) => ({
              id: `${m.id}:${image.attachmentId}`,
              messageKey: m.id,
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
              alt: image.name,
            })),
            ...(m.text
              ? [
                  {
                    id: m.id,
                    messageKey: m.id,
                    kind: m.role === "notice" ? "notice" : "text",
                    side:
                      m.role === "user" && !m.source ? "outgoing" : "incoming",
                    text: m.text,
                  },
                ]
              : []),
          ],
        }) as TimelineMessageUnit,
    );
    for (const p of chatState?.pending ?? [])
      if (!unique.some((m) => m.operationId === p.operationId))
        units.push({
          id: p.operationId,
          side: "outgoing",
          time: p.createdAt,
          pending: true,
          pendingLabel:
            p.state === "missing"
              ? "尚未发送"
              : p.state === "unconsumed"
                ? "未消费"
                : p.state === "accepted"
                  ? "已接收"
                  : p.state === "rejected"
                    ? "未被接收"
                    : "待确认",
          items: [
            ...(p.images ?? []).map((image) => ({
              id: `${p.operationId}:${image.attachmentId}`,
              messageKey: p.operationId,
              kind: "image" as const,
              side: "outgoing" as const,
              state: "ready" as const,
              attachment: image,
              alt: image.name,
            })),
            ...(p.text
              ? [
                  {
                    id: p.operationId,
                    messageKey: p.operationId,
                    kind: "text" as const,
                    side: "outgoing" as const,
                    text: p.text,
                    pending: true,
                  },
                ]
              : []),
          ],
        });
    const compacting =
      !!chatState?.compactPending || view?.compaction?.status === "running";
    return {
      items: units.flatMap((u) => u.items),
      messageUnits: units,
      pendingCount: chatState?.pending.length ?? 0,
      running: !!view?.activeTurnId,
      canSubmit: !!chatState?.connected && !compacting,
      status: !chatState?.connected
        ? "offline"
        : view?.activeTurnId || compacting
          ? "working"
          : "ready",
      openState: view ? "open" : "loading",
      hasMore: !!chatState?.before,
      loadingOlder: !!chatState?.loadingOlder,
      promptError: chatState?.error,
    };
  });
  const actions: CompanionActions = {
    async send(text, images, retire, sources) {
      if (!controller?.connected)
        throw new CompanionPreControllerError("请等待连接恢复后发送文字。");
      if (controller.pending.length >= 20)
        throw new CompanionPreControllerError("请先核对尚未确认的消息。");
      const originSession = controller.view?.sessionId;
      try {
        await controller.send(
          text,
          () => retire?.({ reason: "observed" }),
          images,
          sources,
        );
      } catch (error) {
        if (controller.view?.sessionId !== originSession)
          throw new CompanionPreControllerError("会话已改变");
        controller.error = error instanceof Error ? error.message : "发送失败";
        revision += 1;
        throw new CompanionPreControllerError(controller.error);
      }
    },
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
    void fetch(VOICE_CAPABILITY_PATH, {
      signal: abort.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Voice unavailable");
        const capability = validateVoiceCapability(await response.json());
        if (!abort.signal.aborted)
          voiceCapability = capability.available ? "available" : "unavailable";
      })
      .catch(() => {
        if (!abort.signal.aborted) voiceCapability = "unavailable";
      });
    controller = new ChatController(() => {
      revision += 1;
    });
    revision += 1;
    controller.start();
    return () => {
      media.removeEventListener("change", updateScheme);
      abort.abort();
      controller.close();
    };
  });
</script>

<svelte:head><title>{chatState?.view?.name ?? "Lamplit"}</title></svelte:head>
<Companion
  {projection}
  continuity={{
    contextPressure: chatState?.view?.contextUsage,
    lifecycle: chatState?.view?.compaction,
  }}
  {actions}
  {t}
  locale={language}
  {appearance}
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
  recoveredDraft={chatState?.recovery[0]
    ? {
        key: chatState.recovery[0].sourceId,
        sourceIds: [chatState.recovery[0].sourceId],
        input: chatState.recovery[0].text,
        state: chatState.recovery[0].state,
        replacementEligible: chatState.recovery[0].replacementEligible,
        images: chatState.recovery[0].images.map((image) => ({
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
    companionName: chatState?.view?.name ?? "Lamplit",
    userName: "你",
    preferredAddress: "你",
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
  workspaceReadiness={chatState?.view ? "ready" : "loading"}
  sessionReadiness={chatState?.view ? "ready" : "loading"}
/>
{#if chatState?.pending.some((p) => p.state === "missing")}
  <div class="pending-retry">
    <button
      class="button button-fill"
      onclick={() => void controller.retryMissing()}>重试未发送消息</button
    >
  </div>
{/if}

<style>
  .pending-retry {
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
  }
</style>
