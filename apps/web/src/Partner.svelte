<script lang="ts">
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
          older: controller.older,
          pending: controller.pending,
          connected: controller.connected,
          before: controller.before,
          loadingOlder: controller.loadingOlder,
          error: controller.error,
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
          side: m.role === "user" ? "outgoing" : "incoming",
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
            {
              id: m.id,
              messageKey: m.id,
              kind: m.role === "notice" ? "notice" : "text",
              side: m.role === "user" ? "outgoing" : "incoming",
              text: m.text,
            },
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
                  : "待确认",
          items: [
            {
              id: p.operationId,
              messageKey: p.operationId,
              kind: "text",
              side: "outgoing",
              text: p.text,
              pending: true,
            },
          ],
        });
    return {
      items: units.flatMap((u) => u.items),
      messageUnits: units,
      pendingCount: chatState?.pending.length ?? 0,
      running: !!view?.activeTurnId,
      canSubmit: !!chatState?.connected,
      status: !chatState?.connected
        ? "offline"
        : view?.activeTurnId
          ? "working"
          : "ready",
      openState: view ? "open" : "loading",
      hasMore: !!chatState?.before,
      loadingOlder: !!chatState?.loadingOlder,
      promptError: chatState?.error,
    };
  });
  const actions: CompanionActions = {
    async send(text, images, retire) {
      if (!controller?.connected || images.length)
        throw new CompanionPreControllerError("请等待连接恢复后发送文字。");
      if (controller.pending.length >= 20)
        throw new CompanionPreControllerError("请先核对尚未确认的消息。");
      await controller.send(text, () => retire?.({ reason: "observed" }));
    },
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
  {actions}
  {t}
  locale={language}
  {appearance}
  chatOnly
  onLanguageChange={(value) => {
    language = value;
    writePreference(LANGUAGE_STORAGE_KEY, value);
  }}
  onAppearanceChange={(value) => {
    appearance = value;
    writePreference(APPEARANCE_STORAGE_KEY, value);
  }}
  imageLimits={undefined}
  recoveredDraft={undefined}
  onHistoryOpenChange={undefined}
  sessionId={chatState?.view?.sessionId}
  {voiceCapability}
  identity={{
    companionName: chatState?.view?.name ?? "Lamplit",
    userName: "你",
    preferredAddress: "你",
    signature: "",
    moodLabel: "",
    mood: "neutral",
  }}
  workspaceReadiness={chatState?.view ? "ready" : "loading"}
  sessionReadiness={chatState?.view ? "ready" : "loading"}
  relationshipReadiness="ready"
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
