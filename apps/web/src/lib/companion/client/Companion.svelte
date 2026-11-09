<script lang="ts">
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import { visibleViewport, followTimelineResize } from "./viewport.js";
  import { MAX_MESSAGE_LENGTH } from "../../message-input.ts";
  import {
    english,
    type CompanionLocaleKey,
    type CompanionMessage,
    type CompanionTranslate,
  } from "./locale.js";
  export let t: CompanionTranslate = english;
  export let locale = "en";
  export let backgrounds: { landscape: string; portrait: string } | undefined =
    undefined;
  export let backgroundVersion = 0;
  export let refreshBackgrounds: () => Promise<boolean> = async () => false;
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { setUiTheme, uiTheme, type UiTheme } from "./ui-theme.js";
  import { navigate, route } from "../../../router.ts";
  import AlarmDrawer from "./AlarmDrawer.svelte";
  import ReminderBody from "./ReminderBody.svelte";
  import type { AlarmView } from "./alarm-view.ts";
  import Plus from "lucide-svelte/icons/plus";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import Smile from "lucide-svelte/icons/smile";
  import {
    Button,
    Preloader,
    List,
    ListItem,
    Radio,
    Page,
    Messages,
    KonstaProvider,
    Message as KonstaMessage,
    MessagesTitle as KonstaMessagesTitle,
    Messagebar as KonstaMessagebar,
    Button as KonstaButton,
    Chip as KonstaChip,
    Glass as KonstaGlass,
    Tabbar as KonstaTabbar,
    TabbarLink as KonstaTabbarLink,
    Fab as KonstaFab,
    Actions as KonstaActions,
    ActionsGroup as KonstaActionsGroup,
    ActionsButton as KonstaActionsButton,
    Sheet as KonstaSheet,
    Popover as KonstaPopover,
    Popup as KonstaPopup,
    Toast as KonstaToast,
  } from "konsta/svelte";
  import MessageCircle from "lucide-svelte/icons/message-circle";
  import Settings from "lucide-svelte/icons/settings";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";
  import Palette from "lucide-svelte/icons/palette";
  import Cpu from "lucide-svelte/icons/cpu";
  import ModelSettings from "./ModelSettings.svelte";
  import VoiceOutputSettings from "./VoiceOutputSettings.svelte";
  import BackgroundSettings from "./BackgroundSettings.svelte";
  import Search from "lucide-svelte/icons/search";
  import Pause from "lucide-svelte/icons/pause";
  import Play from "lucide-svelte/icons/play";
  import Square from "lucide-svelte/icons/square";
  import Volume2 from "lucide-svelte/icons/volume-2";
  import X from "lucide-svelte/icons/x";
  import Images from "lucide-svelte/icons/images";
  import FileText from "lucide-svelte/icons/file-text";
  import Heart from "lucide-svelte/icons/heart";
  import BookOpen from "lucide-svelte/icons/book-open";
  import AlarmClock from "lucide-svelte/icons/alarm-clock";
  import Gallery from "./Gallery.svelte";
  import OverlayPresence from "./OverlayPresence.svelte";
  import StickerPanel from "./StickerPanel.svelte";
  import type { StickerClient } from "../../sticker-client.js";
  import { fileDownloadUrl, type ImageRef, type FileLimits } from "@lamplit/contracts";
  import {
    createFileDrafts,
    fileIntakeError,
    type ChatFileDraft,
  } from "../../file-upload.ts";
  import { longPress } from "./long-press.ts";
  import { ATTACHMENT_CAPACITY_ERROR, PENDING_MESSAGE_CAPACITY_ERROR } from "../../chat-controller.ts";
  import {
    overlayOpened,
    overlayClosed,
    overlayOpening,
    overlayDestroyed,
  } from "./overlay-focus.ts";
  import {
    captureReadingFocus,
    dismissComposerOnTimelineTap,
  } from "./reading-focus.ts";
  import {
    currentMessageMenu,
    messageMenu,
    dismissMessageMenu,
    messageMenuOpen,
    runMessageMenuAction,
  } from "./message-menu.ts";
  import { saveImage } from "./save-image.ts";
  import PhotoSwipe from "photoswipe";
  import "photoswipe/style.css";
  import {
    galleryRows,
    type GalleryGrouping,
    type GalleryImage,
  } from "./gallery.js";
  import {
    formatTokenCount,
    resolveContextCapacity,
    type CompactionLifecycleState,
  } from "../continuity.js";
  import type {
    CompanionProjection,
    TimelineImage,
    TimelineFile,
    TimelineItem,
    TimelineMessageUnit,
    TimelineNotice,
    TimelineText,
    TimelineVoice,
    TimelineUI,
  } from "../projection.js";
  import { replySegments } from "../projection.js";
  import type {
    CompanionContinuityView,
    CompanionRecoveredDraft,
    CompanionHistoryView,
  } from "./companion-bridge.js";
  import { CompanionPreControllerError } from "./admission.js";
  import {
    createComposerState,
    findComposerCommand,
    reduceComposer,
    shouldSubmitEnter,
    type ComposerCommand,
  } from "./composer.js";
  import {
    createImageDrafts,
    imageFilesFromClipboard,
    imageIntakeError,
    IMAGE_ACCEPT,
    releaseImageDrafts,
    type CompanionImageDraft,
  } from "./image-drafts.js";
  import type { CompanionReadiness } from "./readiness.js";
  import type {
    CompanionAppearance,
    CompanionLanguage,
  } from "./preferences.js";
  import { companionHistoryChanges } from "../relationship-history.js";
  import type { CompanionHistoryChange } from "../domain.js";
  import A2UISurface from "../a2ui/Surface.svelte";
  import Markdown from "./Markdown.svelte";
  import Thinking from "./Thinking.svelte";
  import ConversationSearch from "./ConversationSearch.svelte";
  import { chatTimeHeadings, nextChatDayBoundary } from "./chat-day.js";
  import { resolveImageDisplaySize } from "../media.js";
  interface CompanionIdentityView {
    companionName: string;
    companionAvatar?: string;
    userName: string;
    userAvatar?: string;
    preferredAddress: string;
    signature: string;
    moodLabel: string;
    mood: string;
    moodNote?: string;
    affinity?: number;
    affinityStage?: string;
  }
  import type { CompanionActions } from "./companion-bridge.ts";

  export let projection: CompanionProjection = {
    items: [],
    messageUnits: [],
    pendingCount: 0,
    running: false,
    status: "ready",
    openState: "open",
    hasMore: false,
    loadingOlder: false,
  };
  export let identity: CompanionIdentityView = {
    companionName: "Companion",
    userName: t("you"),
    preferredAddress: t("you"),
    signature: "",
    moodLabel: t("mood.neutral"),
    mood: "neutral",
    affinity: 50,
    affinityStage: t("affinity.familiar"),
  };
  export let actions: CompanionActions = { send: async () => undefined };
  export let navigationPath = "/";
  export let navigationDiaryEntry: string | undefined;
  export let workspaceReadiness: CompanionReadiness = "loading";
  export let sessionReadiness: CompanionReadiness = "loading";
  export let sessionId: string | undefined;
  export let workspaceImages = false;
  export let imageLimits:
    | import("./contracts.js").ImageAttachmentLimits
    | undefined;
  export let fileLimits: FileLimits | undefined;
  export let continuity: CompanionContinuityView = {};
  export let recoveredDraft: CompanionRecoveredDraft | undefined;
  export let history: CompanionHistoryView = {
    status: "loading",
    records: [],
    hasEarlier: false,
  };
  export let onHistoryOpenChange: ((open: boolean) => void) | undefined;
  export let panelRevision = 0;
  export let appearance: CompanionAppearance = "system";
  export let onAppearanceChange: (
    appearance: CompanionAppearance,
  ) => void = () => undefined;
  export let onLanguageChange: (language: CompanionLanguage) => void = () =>
    undefined;

  const dispatch = createEventDispatcher<{ advanced: void; recovery: void }>();
  const LONG_WAIT_DELAY_MS = 12_000;
  const LONG_WAIT_ROTATION_MS = 9_000;
  const VOICE_WAVEFORM_BAR_COUNT = 28;
  const EMPTY_VOICE_PLAYBACK = { current: 0, duration: 0, playing: false };
  const IMAGE_TILE_SIZE = 64;
  const IMAGE_MAX_LONG_EDGE = 240;
  const LONG_WAIT_MESSAGES = [
    "wait.thinking",
    "wait.words",
    "wait.soon",
    "wait.care",
    "wait.here",
  ] as const;
  let composer = createComposerState();
  let composerInput: HTMLTextAreaElement;
  let composerPreview: HTMLElement | undefined;
  let photoLibraryInput: HTMLInputElement;
  let photoCaptureInput: HTMLInputElement;
  let fileInput: HTMLInputElement;
  let filePickerSession: string | undefined;
  let filePickerGeneration = 0;
  let imagePickerSession: string | undefined;
  let imagePickerGeneration = 0;
  let sessionGeneration = 0;
  let attachmentDisposed = false;
  let commandSuggestion: ComposerCommand | undefined;
  let stopping = false;
  $: konstaTheme = $uiTheme;
  let chatDayNow = Date.now();
  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      chatDayNow = Date.now();
      timer = setTimeout(refresh, Math.max(1, nextChatDayBoundary(chatDayNow) - chatDayNow + 50));
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", refresh);
    };
  });
  let timeline: HTMLDivElement;
  let timelineReady = false;
  let timelineRevealFrame = 0;
  let timelineGeometry = { height: 0, viewport: 0 };
  let detailOpen = false;
  type PreferencesTab =
    | "home"
    | "appearance"
    | "models"
    | "voice-output";
  function preferencesTabFromPath(path: string): PreferencesTab | undefined {
    const routes: Record<string, PreferencesTab> = {
      "/settings": "home", "/settings/appearance": "appearance",
      "/settings/models": "models", "/settings/voice-output": "voice-output",
    };
    return routes[path];
  }
  let preferencesTab: PreferencesTab = preferencesTabFromPath(navigationPath) ?? "home";
  let preferencesOpen = preferencesTabFromPath(navigationPath) !== undefined;
  let preferencesButton: HTMLButtonElement;
  let preferencesBack: HTMLButtonElement;
  let modelSettingsSupported = false;
  let voiceOutputSettingsSupported = false;
  let appliedSection = "";
  let drawerTab: "history" | "diary" | "images" | "alarms" = "history";
  let alarms: AlarmView[] = [];
  let alarmsLoading = false;
  let alarmsError = false;
  let galleryImages: GalleryImage[] = [];
  let galleryGrouping: GalleryGrouping = "week";
  let galleryCursor: string | undefined;
  let galleryLoading = false;
  let galleryError = false;
  $: galleryRowsValue = galleryRows(galleryImages, locale, galleryGrouping);
  let diaryCursor: string | null = null;
  let diaryMissing = false;
  let diarySelected: string | undefined;
  let panelGeneration = 0;
  let panelSession: string | undefined;
  let lastPanelRevision = -1;
  let diaryEntries: string[] = [];
  let diaryEntry: { name: string; text: string } | undefined;
  let diaryLoading = false;
  let diaryError = false;
  let diaryTooLarge = false;
  interface ImagePreviewTarget {
    id: string;
    alt: string;
    previewUrl?: string;
    attachment?: ImageRef;
  }
  interface ImagePart {
    kind: "images";
    items: TimelineImage[];
  }
  interface ContentPart {
    kind: "item";
    item: TimelineText | TimelineImage | TimelineVoice | TimelineFile | TimelineUI;
  }
  type MessageContentPart = ImagePart | ContentPart;
  let lightbox: ImagePreviewTarget | undefined;
  let lightboxUrl = "";
  let voiceUrls: Record<string, string> = {};
  let voiceErrors: Record<string, boolean> = {};
  let voicePlayback: Record<
    string,
    { current: number; duration: number; playing: boolean }
  > = {};
  let imageUrls: Record<string, string> = {};
  let imageErrors: Record<string, boolean> = {};
  let imageSources: Record<string, string> = {};
  let imageLoads: Record<string, string> = {};
  let imageDimensions: Record<string, { width: number; height: number }> = {};
  let wasNearBottom = true;
  let preservingHistoryPosition = false;
  let liveAnnouncement: string | CompanionMessage = "";
  let toastText = "";
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let lightboxReturnFocus: HTMLElement | undefined;
  let photoBrowser: PhotoSwipe | undefined;
  let photoLoading = false;
  let photoError = false;
  let photoGeneration = 0;
  let imageSessionGeneration = 0;
  let stickerClient: StickerClient | undefined;
  let unsubscribeStickerAuthorization: (() => void) | undefined;
  let stickerOpen = false;
  let stickerPanelVersion = 0;
  let attachmentOpen = false;
  let stickerFavoritesRevision = 0;
  let searchOpen = false;

  let statusText = "";
  let imageGenerationRunning = false;
  let typingVisible = false;
  let waitingCopy: CompanionLocaleKey | "" = "";
  let waitingCycle = "";
  let waitingDelayTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingRotationTimer: ReturnType<typeof setInterval> | undefined;
  let contextMeterOpen = false;
  let contextMeterButton: HTMLButtonElement;
  let contextMeterRestoreFocus = true;
  let displayedMessageMenu: NonNullable<typeof $currentMessageMenu> | undefined;
  $: if ($currentMessageMenu) displayedMessageMenu = $currentMessageMenu;
  let continuityStatus: CompactionLifecycleState | undefined;
  let imageDrafts: CompanionImageDraft[] = [];
  let fileDrafts: ChatFileDraft[] = [];
  let imageIntakeFailure: CompanionMessage | undefined;
  let imageDraftSessionId: string | undefined;
  let recoveredDraftKey = "";
  let recoveredPendingKey = "";
  let replacementSourceIds: readonly string[] = [];
  let restoredNeedsAttachments = false;
  let restoredEmptyRecovery = false;
  let deferredPreviewReleases: CompanionImageDraft[] = [];
  let deferredImageUrls = new Set<string>();
  let displayedProjection: CompanionProjection = projection;
  let composerExpanded = false;
  $: effectiveWorkspaceReadiness = workspaceReadiness;
  $: effectiveSessionReadiness = sessionReadiness;
  $: if (sessionId !== panelSession) {
    resetStickerClient();
    attachmentOpen = false;
    imageSessionGeneration++;
    dismissMessageMenu();
    displayedMessageMenu = undefined;
    imagePress?.destroy();
    imagePress = undefined;
    lightboxReturnFocus = undefined;
    closePhotoBrowser();
    lightbox = undefined;
    lightboxUrl = "";
    panelSession = sessionId;
    panelGeneration++;
    galleryImages = [];
    galleryCursor = undefined;
    diaryEntries = [];
    diaryEntry = undefined;
    alarms = [];
    diarySelected = undefined;
    diaryCursor = null;
    diaryLoading = false;
    galleryLoading = false;
    alarmsLoading = false;
  }
  $: if (projection.status === "offline" && stickerClient) {
    resetStickerClient();
  }
  $: if (panelRevision !== lastPanelRevision) {
    lastPanelRevision = panelRevision;
    if (detailOpen) refreshVisiblePanel();
  }
  $: if (detailOpen && effectiveWorkspaceReadiness !== "ready")
    finishDetailClose(false);
  $: syncNavigation(navigationPath, navigationDiaryEntry, sessionId,
    effectiveWorkspaceReadiness === "ready" && effectiveSessionReadiness === "ready");
  $: statusText =
    projection.status === "offline"
      ? t("status.offline")
      : projection.status === "working"
        ? t("status.typing")
        : t("status.online");
  $: imageGenerationRunning = projection.items.some(
    (item) =>
      item.kind === "image" &&
      (item.state === "running" || item.state === "loading"),
  );
  $: typingVisible =
    projection.running && !projection.replyCompleted && !imageGenerationRunning;
  $: commandSuggestion =
    imageDrafts.length || fileDrafts.length
      ? undefined
      : findComposerCommand(composer.draft, t);
  $: if (imageDrafts || fileDrafts) void scheduleComposerResize();
  $: contextCapacity = resolveContextCapacity(continuity?.contextPressure);
  $: latestContinuityLifecycle = continuity?.lifecycle ?? undefined;
  $: syncContinuityStatus(latestContinuityLifecycle);
  $: if ((!contextCapacity || (projection.running && actions.stop)) && contextMeterOpen)
    closeContextMeter(false);
  $: syncWaitingState(
    typingVisible,
    `${sessionId ?? "none"}:${latestSettledReplyKey(projection)}`,
  );
  $: displayedProjection = projection;
  $: visibleMessageUnits = displayedProjection.messageUnits.filter((unit) => unit.items[0]?.kind !== "continuity");
  $: timeHeadings = chatTimeHeadings(visibleMessageUnits, displayedProjection.historyGaps, chatDayNow, locale, t);
  $: if (displayedProjection) void reconcileProjection(displayedProjection);
  $: if (sessionId !== imageDraftSessionId) {
    sessionGeneration += 1;
    releaseSubmissionImages(imageDrafts);
    imageDrafts = [];
    fileDrafts = [];
    imageDraftSessionId = sessionId;
    recoveredDraftKey = "";
    recoveredPendingKey = "";
    replacementSourceIds = [];
    restoredNeedsAttachments = false;
    restoredEmptyRecovery = false;
    composer = createComposerState();
    void scheduleComposerResize();
  }
  $: if (restoredEmptyRecovery && (composer.draft || imageDrafts.length || fileDrafts.length)) {
    restoredEmptyRecovery = false;
  }
  $: if (
    !composer.draft &&
    !imageDrafts.length &&
    !fileDrafts.length &&
    !restoredEmptyRecovery
  ) {
    replacementSourceIds = [];
    recoveredDraftKey = "";
    recoveredPendingKey = "";
    restoredNeedsAttachments = false;
  }
  async function scheduleComposerResize(): Promise<void> {
    await tick();
    if (!composerInput?.isConnected) return;
    if (composerPreview) {
      const value = composerInput.value;
      composerPreview.textContent = value.replace(/\s*\n\s*/g, " ").trim() +
        (value.includes("\n") ? "…" : "");
    }
    // Measure the content rather than the browser's default two textarea rows.
    composerInput.style.height = "0px";
    composerInput.style.height = `${Math.min(144, Math.max(48, composerInput.scrollHeight))}px`;
    composerInput.style.overflowY = composerInput.scrollHeight > 144 ? "auto" : "hidden";
  }

  function connectMessagebar(
    node: HTMLElement,
    options: {
      label: string;
      suggestions: boolean;
    },
  ) {
    const bar = node.closest<HTMLElement>(".companion-composer")!;
    const input = bar.querySelector<HTMLTextAreaElement>("textarea")!;
    composerInput = input;
    const preview = document.createElement("span");
    preview.className = "companion-composer-preview";
    preview.setAttribute("aria-hidden", "true");
    input.parentElement?.append(preview);
    composerPreview = preview;
    input.classList.add("resizable");
    input.setAttribute("enterkeyhint", "send");
    input.addEventListener("focus", closeStickerPanel);
    const update = (value: typeof options) => {
      input.setAttribute("aria-label", value.label);
      if (value.suggestions) {
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", "companion-command-suggestions");
      } else {
        input.removeAttribute("aria-autocomplete");
        input.removeAttribute("aria-controls");
      }
    };
    update(options);
    input.addEventListener("paste", onPaste);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    const resizeAfterActions = (event: TransitionEvent) => {
      if (event.propertyName === "width" && event.target instanceof Element &&
          event.target.matches(".companion-stickers, .companion-attach")) {
        void scheduleComposerResize();
      }
    };
    bar.addEventListener("transitionend", resizeAfterActions);
    const observer = new ResizeObserver(() => {
      bar
        .closest<HTMLElement>(".page")
        ?.style.setProperty(
          "--companion-messagebar-height",
          `${bar.offsetHeight + 12}px`,
        );
    });
    observer.observe(bar, { box: "border-box" });
    void scheduleComposerResize();
    return {
      update,
      destroy() {
        bar.removeEventListener("transitionend", resizeAfterActions);
        observer.disconnect();
        preview.remove();
        if (composerPreview === preview) composerPreview = undefined;
        input.removeEventListener("focus", closeStickerPanel);
        input.removeEventListener("paste", onPaste);
        input.removeEventListener("keydown", onKeydown);
        input.removeEventListener("compositionstart", onCompositionStart);
        input.removeEventListener("compositionend", onCompositionEnd);
      },
    };
  }

  function restoreRecoveredDraft(draft: CompanionRecoveredDraft): void {
    if (sessionId !== imageDraftSessionId) return;
    if (
      composer.draft.trim() ||
      imageDrafts.length ||
      fileDrafts.length ||
      !draft.replacementEligible
    )
      return;
    recoveredDraftKey = draft.key;
    recoveredPendingKey = draft.localPendingKey ?? "";
    restoredEmptyRecovery = !draft.input;
    composer = { ...composer, draft: draft.input, composing: false };
    replacementSourceIds = draft.sourceIds;
    restoredNeedsAttachments = draft.images.length > 0 || (draft.files?.length ?? 0) > 0;
    void scheduleComposerResize();
    liveAnnouncement = { key: "recovery.restored" };
  }

  function messageContentParts(unit: TimelineMessageUnit): MessageContentPart[] {
    const content = unit.items
      .flatMap((item) =>
        unit.answer && item.kind === "text"
          ? replySegments(item, sessionId ?? "")
          : [item],
      )
      .filter(
        (
          item,
        ): item is
          | TimelineText
          | TimelineImage
          | TimelineVoice
          | TimelineFile
          | TimelineUI =>
          item.kind === "text" ||
          item.kind === "image" ||
          item.kind === "voice" ||
          item.kind === "file" ||
          item.kind === "ui",
      );
    if (unit.side === "outgoing") {
      const images = content.filter(
        (item): item is TimelineImage => item.kind === "image",
      );
      const rest = content.filter((item) => item.kind !== "image");
      return [
        ...images.map((image) => ({ kind: "images" as const, items: [image] })),
        ...rest.map((item) => ({ kind: "item" as const, item })),
      ];
    }
    const parts: MessageContentPart[] = [];
    for (const item of content) {
      if (item.kind === "image") {
        parts.push({ kind: "images", items: [item] });
      } else parts.push({ kind: "item", item });
    }
    return parts;
  }

  function imageHasKnownDimensions(item: TimelineImage): boolean {
    const width = item.attachment?.width;
    const height = item.attachment?.height;
    return (
      typeof width === "number" &&
      width > 0 &&
      typeof height === "number" &&
      height > 0
    );
  }

  function imageStyle(item: TimelineImage, tiled: boolean): string {
    if (tiled) return `width:${IMAGE_TILE_SIZE}px;height:${IMAGE_TILE_SIZE}px`;
    const dimensions = imageDimensions[item.id];
    const width = dimensions?.width ?? item.attachment?.width;
    const height = dimensions?.height ?? item.attachment?.height;
    if (!imageHasKnownDimensions(item) && !dimensions)
      return "max-width:100%;max-height:240px;width:auto;height:auto";
    const size = resolveImageDisplaySize(width, height, IMAGE_MAX_LONG_EDGE);
    return `width:${size.width}px;height:${size.height}px;object-fit:${size.cropped ? "cover" : "contain"}`;
  }

  function onImageLoaded(item: TimelineImage, event: Event): void {
    if (imageHasKnownDimensions(item)) return;
    const image = event.currentTarget as HTMLImageElement;
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const current = imageDimensions[item.id];
    if (
      current?.width === image.naturalWidth &&
      current.height === image.naturalHeight
    )
      return;
    imageDimensions = {
      ...imageDimensions,
      [item.id]: { width: image.naturalWidth, height: image.naturalHeight },
    };
  }

  function unitTestId(unit: TimelineMessageUnit): string {
    const voice = unit.items.find(
      (item): item is TimelineVoice => item.kind === "voice",
    );
    return voice ? `voice-${voice.id}` : `message-${unit.id}`;
  }

  function capacityErrorKey(code?: string): CompanionLocaleKey | undefined {
    if (code === ATTACHMENT_CAPACITY_ERROR) return "error.attachmentCapacity";
    if (code === PENDING_MESSAGE_CAPACITY_ERROR) return "error.pendingMessageCapacity";
    return undefined;
  }

  function messengerRecoveryMessage(
    value: string,
    operation?: string,
    code?: string,
  ): string | CompanionMessage {
    const capacityKey = capacityErrorKey(code);
    if (capacityKey) return { key: capacityKey };
    if (operation === "stop") return { key: "error.stop" };
    if (operation === "send") return { key: "error.send" };
    return value;
  }

  function noticeText(item: TimelineNotice, t: CompanionTranslate): string {
    if (item.id === "prompt-error")
      return t(
        capacityErrorKey(projection.promptErrorCode) ??
          (projection.promptErrorOp === "stop" ? "error.stop" : "error.send"),
      );
    return item.text;
  }

  function releaseDeferredPreviewReleases(): void {
    const drafts = deferredPreviewReleases;
    deferredPreviewReleases = [];
    if (drafts.length) releaseImageDrafts(drafts);
    if (deferredImageUrls.size) {
      for (const url of deferredImageUrls)
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      deferredImageUrls.clear();
    }
  }

  function releaseSubmissionImages(
    images: readonly CompanionImageDraft[],
  ): void {
    const protectedPreview =
      lightboxUrl && lightbox?.previewUrl === lightboxUrl
        ? lightboxUrl
        : undefined;
    const deferred = protectedPreview
      ? images.filter((draft) => draft.previewUrl === protectedPreview)
      : [];
    const releasable = deferred.length
      ? images.filter((draft) => draft.previewUrl !== protectedPreview)
      : images;
    if (deferred.length) {
      const known = new Set(
        deferredPreviewReleases.map((draft) => draft.previewUrl),
      );
      deferredPreviewReleases = [
        ...deferredPreviewReleases,
        ...deferred.filter((draft) => !known.has(draft.previewUrl)),
      ];
    }
    if (releasable.length)
      void tick().then(() => releaseImageDrafts(releasable));
  }

  function latestSettledReplyKey(value: CompanionProjection): string {
    for (let index = value.items.length - 1; index >= 0; index -= 1) {
      const item = value.items[index]!;
      if (
        item.side === "incoming" &&
        (item.kind !== "image" ||
          item.state === "ready" ||
          item.state === "failed")
      )
        return (
          ("projectionKey" in item ? item.projectionKey : undefined) ?? item.id
        );
    }
    return "empty";
  }

  function clearWaitingTimers(): void {
    if (waitingDelayTimer !== undefined) clearTimeout(waitingDelayTimer);
    if (waitingRotationTimer !== undefined) clearInterval(waitingRotationTimer);
    waitingDelayTimer = undefined;
    waitingRotationTimer = undefined;
  }

  function syncContinuityStatus(
    lifecycle: CompactionLifecycleState | undefined,
  ): void {
    continuityStatus = lifecycle?.status === "complete" ? undefined : lifecycle;
  }

  function openContextMeter(): void {
    if (!contextCapacity) return;
    contextMeterRestoreFocus = true;
    contextMeterOpen = true;
  }

  function closeContextMeter(restoreFocus = true): void {
    contextMeterRestoreFocus = restoreFocus;
    contextMeterOpen = false;
  }
  function contextMenuFocus(node: HTMLElement, active: boolean) {
    const overlay = { el: node };
    let listening = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeContextMeter();
      }
    };
    const update = (next: boolean) => {
      if (next === listening) return;
      listening = next;
      if (next) {
        overlayOpening(overlay);
        node.addEventListener("keydown", keydown);
        node.focus({ preventScroll: true });
      } else {
        node.removeEventListener("keydown", keydown);
        if (contextMeterRestoreFocus) overlayClosed(overlay);
        else overlayDestroyed(overlay);
      }
    };
    update(active);
    return {
      update,
      destroy() { update(false); },
    };
  }

  function toggleContextMeter(): void {
    if (contextMeterOpen) closeContextMeter();
    else openContextMeter();
  }

  function rotateWaitingCopy(): void {
    const choices = LONG_WAIT_MESSAGES.filter(
      (message) => message !== waitingCopy,
    );
    waitingCopy =
      choices[Math.floor(Math.random() * choices.length)] ??
      LONG_WAIT_MESSAGES[0];
  }

  function syncWaitingState(running: boolean, replyKey: string): void {
    const nextCycle = running ? replyKey : "";
    if (nextCycle === waitingCycle) return;
    waitingCycle = nextCycle;
    clearWaitingTimers();
    waitingCopy = "";
    if (!running) return;
    waitingDelayTimer = setTimeout(() => {
      rotateWaitingCopy();
      waitingRotationTimer = setInterval(
        rotateWaitingCopy,
        LONG_WAIT_ROTATION_MS,
      );
    }, LONG_WAIT_DELAY_MS);
  }

  async function reconcileProjection(
    value: CompanionProjection,
  ): Promise<void> {
    await tick();
    if (!timeline) return;
    if (value.openState !== "open") {
      if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
      timelineRevealFrame = 0;
      timelineReady = false;
      return;
    }
    if (!timelineReady) {
      if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
      timelineRevealFrame = requestAnimationFrame(() => {
        if (!timeline) return;
        wasNearBottom = true;
        timeline.scrollTop = timeline.scrollHeight;
        timelineReady = true;
        timelineRevealFrame = 0;
      });
    }
    liveAnnouncement = value.promptError
      ? messengerRecoveryMessage(value.promptError, value.promptErrorOp, value.promptErrorCode)
      : (value.lastAgentError ?? "");
    const wantedImages = new Map<string, TimelineImage>();
    for (const item of value.items)
      if (item.kind === "image" && item.state === "ready" && item.attachment && !item.previewUrl)
        wantedImages.set(item.id, item);
    for (const [id, url] of Object.entries(imageUrls)) {
      const item = wantedImages.get(id);
      if (!item || imageSources[id] !== imageSource(item)) revokeImage(id, url);
    }
    for (const item of wantedImages.values()) {
      const source = imageSource(item);
      if (
        !imageUrls[item.id] &&
        imageLoads[item.id] !== source &&
        actions.attachmentUrl
      )
        void loadImage(item, source);
    }
    for (const item of value.items)
      if (item.kind === "voice" && voiceUrls[item.id] !== item.url)
        voiceUrls = { ...voiceUrls, [item.id]: item.url };
  }

  function imageSource(item: TimelineImage): string {
    return `${item.attachment?.attachmentId ?? ""}:${item.attachment?.mediaType ?? ""}`;
  }
  function releaseImageUrl(url: string | undefined): void {
    if (!url?.startsWith("blob:")) return;
    if (url === lightboxUrl) {
      deferredImageUrls.add(url);
      return;
    }
    URL.revokeObjectURL(url);
  }
  function revokeImage(id: string, url = imageUrls[id]): void {
    releaseImageUrl(url);
    const urls = { ...imageUrls };
    const sources = { ...imageSources };
    const errors = { ...imageErrors };
    delete urls[id];
    delete sources[id];
    delete errors[id];
    imageUrls = urls;
    imageSources = sources;
    imageErrors = errors;
    const dimensions = { ...imageDimensions };
    delete dimensions[id];
    imageDimensions = dimensions;
  }
  async function loadImage(item: TimelineImage, source: string): Promise<void> {
    if (!actions.attachmentUrl || item.previewUrl || imageLoads[item.id] === source) return;
    imageLoads = { ...imageLoads, [item.id]: source };
    try {
      const url = await actions.attachmentUrl(item.attachment);
      const live = displayedProjection.items.find(
        (candidate) => candidate.kind === "image" && candidate.id === item.id,
      ) as TimelineImage | undefined;
      if (live && !live.previewUrl && imageSource(live) === source) {
        if (imageUrls[item.id] && imageUrls[item.id] !== url)
          revokeImage(item.id);
        imageUrls = { ...imageUrls, [item.id]: url };
        imageSources = { ...imageSources, [item.id]: source };
        if (lightbox?.id === item.id) {
          const previous = lightboxUrl;
          lightboxUrl = url;
          if (photoBrowser) {
            const slide = photoBrowser.currSlide;
            if (slide) {
              slide.data.src = url;
              slide.content.element?.setAttribute("src", url);
            }
          }
          if (previous && previous !== url) {
            deferredImageUrls.delete(previous);
            releaseImageUrl(previous);
          }
        }
      } else if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    } catch {
      const live = displayedProjection.items.find(
        (candidate) => candidate.kind === "image" && candidate.id === item.id,
      ) as TimelineImage | undefined;
      if (live && imageSource(live) === source)
        imageErrors = { ...imageErrors, [item.id]: true };
    } finally {
      const loads = { ...imageLoads };
      delete loads[item.id];
      imageLoads = loads;
    }
  }

  function retryImage(item: TimelineImage): void {
    if (!actions.attachmentUrl || !item.attachment) return;
    const errors = { ...imageErrors };
    delete errors[item.id];
    imageErrors = errors;
    const loads = { ...imageLoads };
    delete loads[item.id];
    imageLoads = loads;
    void loadImage(item, imageSource(item));
  }

  function updateVoicePlayback(
    id: string,
    patch: Partial<{ current: number; duration: number; playing: boolean }>,
  ): void {
    voicePlayback = {
      ...voicePlayback,
      [id]: {
        ...(voicePlayback[id] ?? EMPTY_VOICE_PLAYBACK),
        ...patch,
      },
    };
  }

  function voiceState(id: string): {
    current: number;
    duration: number;
    playing: boolean;
  } {
    return voicePlayback[id] ?? EMPTY_VOICE_PLAYBACK;
  }

  function formatVoiceSeconds(
    value: number,
    rounding: "floor" | "ceil" = "floor",
  ): string {
    if (!Number.isFinite(value) || value <= 0) return "0:00";
    const seconds = rounding === "ceil" ? Math.ceil(value) : Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function hasVoiceDuration(state: { duration: number }): boolean {
    return state.duration > 0;
  }
  function voiceTimestamp(state: {
    current: number;
    duration: number;
  }): string | undefined {
    if (state.duration <= 0) return undefined;
    return state.current > 0 && state.current < state.duration
      ? formatVoiceSeconds(state.current)
      : formatVoiceSeconds(state.duration, "ceil");
  }

  function voiceProgress(state: { current: number; duration: number }): number {
    return state.duration > 0
      ? Math.min(1, Math.max(0, state.current / state.duration))
      : 0;
  }

  function voiceWaveform(id: string): number[] {
    let seed = 2166136261;
    for (const character of id)
      seed = Math.imul(seed ^ character.codePointAt(0)!, 16777619);
    return Array.from({ length: VOICE_WAVEFORM_BAR_COUNT }, (_, index) => {
      seed = Math.imul(seed ^ index, 2246822519);
      return 28 + (Math.abs(seed) % 69);
    });
  }

  function audioFor(control: Element): HTMLAudioElement | undefined {
    return (
      control
        .closest(".companion-voice")
        ?.querySelector<HTMLAudioElement>("audio") ?? undefined
    );
  }

  function trackVoiceAudio(
    node: HTMLAudioElement,
    id: string,
  ): { destroy(): void } {
    const loaded = (event: Event) => onVoiceLoaded(id, event);
    const time = (event: Event) => onVoiceTime(id, event);
    const play = () => onVoicePlay(id);
    const pause = () => onVoicePause(id);
    const ended = (event: Event) => onVoiceEnded(id, event);
    const error = () => failVoice(id);
    node.addEventListener("loadedmetadata", loaded);
    node.addEventListener("timeupdate", time);
    node.addEventListener("play", play);
    node.addEventListener("pause", pause);
    node.addEventListener("ended", ended);
    node.addEventListener("error", error);
    return {
      destroy() {
        node.removeEventListener("loadedmetadata", loaded);
        node.removeEventListener("timeupdate", time);
        node.removeEventListener("play", play);
        node.removeEventListener("pause", pause);
        node.removeEventListener("ended", ended);
        node.removeEventListener("error", error);
      },
    };
  }

  function failVoice(id: string): void {
    const nextUrls = { ...voiceUrls };
    delete nextUrls[id];
    voiceUrls = nextUrls;
    voiceErrors = {
      ...voiceErrors,
      [id]: true,
    };
  }

  async function toggleVoice(
    item: TimelineVoice,
    control: Element,
  ): Promise<void> {
    if (voiceErrors[item.id]) {
      const nextErrors = { ...voiceErrors };
      delete nextErrors[item.id];
      voiceErrors = nextErrors;
    }
    if (!voiceUrls[item.id]) {
      voiceUrls = { ...voiceUrls, [item.id]: item.url };
      await tick();
    }
    const audio = audioFor(control);
    if (!audio) return;
    for (const other of document.querySelectorAll<HTMLAudioElement>(
      "#dsh-companion .companion-voice audio",
    ))
      if (other !== audio && !other.paused) other.pause();
    try {
      if (audio.ended) audio.currentTime = 0;
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch {
      failVoice(item.id);
    }
  }

  function seekVoice(event: Event, id: string): void {
    const audio = audioFor(event.currentTarget as Element);
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!audio || !Number.isFinite(value)) return;
    audio.currentTime = value;
    updateVoicePlayback(id, { current: value });
  }

  function onVoicePlay(id: string): void {
    updateVoicePlayback(id, { playing: true });
  }
  function onVoicePause(id: string): void {
    updateVoicePlayback(id, { playing: false });
  }
  function onVoiceEnded(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : voiceState(id).duration;
    updateVoicePlayback(id, { current: duration, duration, playing: false });
  }
  function onVoiceLoaded(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      failVoice(id);
      return;
    }
    updateVoicePlayback(id, {
      duration: audio.duration,
      current: audio.currentTime,
    });
  }
  function onVoiceTime(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : voiceState(id).duration;
    updateVoicePlayback(id, { current: audio.currentTime, duration });
  }

  function onScroll(): void {
    if (!timeline) return;
    const geometry = {
      height: timeline.scrollHeight,
      viewport: timeline.clientHeight,
    };
    const resized =
      geometry.height !== timelineGeometry.height ||
      geometry.viewport !== timelineGeometry.viewport;
    timelineGeometry = geometry;
    // Layout-driven scroll events must not turn a follower into a history reader.
    if (!timelineReady || preservingHistoryPosition || (resized && wasNearBottom)) return;
    wasNearBottom =
      geometry.height - geometry.viewport - timeline.scrollTop < 96;
  }

  function connectViewport(node: HTMLElement): { destroy(): void } {
    const page = node.parentElement!;
    return visibleViewport(page, window, () => {
      composerExpanded = page.hasAttribute("data-composer-expanded");
      void scheduleComposerResize();
    });
  }

  // A marker can move as pages are inserted. Track the visibility visit by gap
  // identity so remounting it cannot turn one scroll into an unbounded scan.
  const visitedHistoryGaps = new Set<number>();
  function watchHistoryGap(node: HTMLElement, gap: NonNullable<CompanionProjection["historyGaps"]>[number]) {
    let current = gap;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          visitedHistoryGaps.delete(current.id);
        } else if (current.status === "pending" && !visitedHistoryGaps.has(current.id)) {
          visitedHistoryGaps.add(current.id);
          void actions.fillHistoryGap?.(current.id);
        }
      }
    }, { root: node.closest(".companion-timeline") });
    observer.observe(node);
    return {
      update(next: typeof gap) { current = next; },
      destroy() { observer.disconnect(); },
    };
  }

  function connectTimeline(node: HTMLElement): { destroy(): void } {
    timeline = node.parentElement as HTMLDivElement;
    const reading = dismissComposerOnTimelineTap(timeline, () => composerInput);
    const follow = followTimelineResize(
      node,
      timeline,
      () => timelineReady && wasNearBottom && !preservingHistoryPosition,
    );
    void reconcileProjection(displayedProjection);
    return {
      destroy() {
        reading.destroy();
        follow.destroy();
      },
    };
  }

  function returnToLatest(): void {
    wasNearBottom = true;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }

  function closeStickerPanel(): void {
    stickerOpen = false;
  }
  function closeComposerMenu(): void {
    attachmentOpen = false;
    closeStickerPanel();
  }
  function composerMenuFocus(node: HTMLElement, active: boolean) {
    const overlay = { el: node };
    let listening = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeComposerMenu();
      }
    };
    const update = (next: boolean) => {
      if (next === listening) return;
      listening = next;
      if (next) {
        overlayOpening(overlay);
        node.addEventListener("keydown", keydown);
        overlayOpened(overlay);
      } else {
        node.removeEventListener("keydown", keydown);
        overlayClosed(overlay);
      }
    };
    update(active);
    return {
      update,
      destroy() { update(false); },
    };
  }
  function messageMenuPortal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }
  function compactMessageMenu(node: HTMLElement, active: boolean) {
    let listening = false;
    let frame = 0;
    const alignToBubble = () => {
      const overlay = node.closest<HTMLElement>(".companion-message-overlay");
      const popover = node.closest<HTMLElement>(".companion-action-menu");
      const target = $currentMessageMenu?.target;
      if (!overlay || !popover || !target?.isConnected) return;
      const edge = 8;
      const maxLeft = Math.max(edge, window.innerWidth - popover.offsetWidth - edge);
      const left = Math.min(maxLeft, Math.max(edge, target.getBoundingClientRect().left));
      overlay.style.setProperty("--compact-menu-left", `${left}px`);
    };
    const resize = new ResizeObserver(alignToBubble);
    const pointerdown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const current = $currentMessageMenu;
      if (!current?.compact) return;
      if (!node.contains(event.target) && !current.target.contains(event.target)) {
        dismissMessageMenu();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissMessageMenu();
      } else if (
        (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        node.contains(event.target)
      ) {
        // A touch hold can suppress the following synthetic click.
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const buttons = [...node.querySelectorAll<HTMLButtonElement>("button")];
        const action =
          $currentMessageMenu?.actions[buttons.indexOf(event.target)];
        if (action) runMessageMenuAction(action);
      }
    };
    const update = (next: boolean) => {
      if (listening === next) return;
      listening = next;
      if (next) {
        frame = requestAnimationFrame(() => {
          if (!listening) return;
          alignToBubble();
          const popover = node.closest<HTMLElement>(".companion-action-menu");
          if (popover) resize.observe(popover);
          if ($currentMessageMenu?.target) resize.observe($currentMessageMenu.target);
        });
        window.addEventListener("resize", alignToBubble);
        document.addEventListener("scroll", alignToBubble, true);
        document.addEventListener("pointerdown", pointerdown, true);
        document.addEventListener("keydown", keydown, true);
        if ($currentMessageMenu?.autoFocus)
          queueMicrotask(() => {
            if (listening)
              node.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
          });
      } else {
        cancelAnimationFrame(frame);
        resize.disconnect();
        window.removeEventListener("resize", alignToBubble);
        document.removeEventListener("scroll", alignToBubble, true);
        document.removeEventListener("pointerdown", pointerdown, true);
        document.removeEventListener("keydown", keydown, true);
      }
    };
    update(active);
    return { update, destroy: () => update(false) };
  }
  function messageMenuFocus(node: HTMLElement, active: boolean) {
    let listening = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissMessageMenu();
      } else if (event.key === "Tab") {
        const buttons = [...node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        const next = index < 0
          ? (event.shiftKey ? buttons.length - 1 : 0)
          : (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      }
    };
    const update = (next: boolean) => {
      if (next === listening) return;
      listening = next;
      if (next) {
        document.addEventListener("keydown", keydown, true);
        queueMicrotask(() => {
          if (listening) node.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        });
      } else document.removeEventListener("keydown", keydown, true);
    };
    update(active);
    return { update, destroy: () => update(false) };
  }
  function resetStickerClient(): void {
    unsubscribeStickerAuthorization?.();
    unsubscribeStickerAuthorization = undefined;
    stickerClient?.close();
    stickerClient = undefined;
    stickerOpen = false;
  }
  function currentStickerClient(): StickerClient {
    if (stickerClient) return stickerClient;
    const client = actions.openStickers?.();
    if (!client) throw new Error("Sticker service unavailable");
    stickerClient = client;
    unsubscribeStickerAuthorization = client.onAuthorizationLost(() => {
      if (stickerClient !== client) return;
      resetStickerClient();
      liveAnnouncement = { key: "stickers.error" };
    });
    return client;
  }
  function toggleStickerPanel(): void {
    if (stickerOpen) { closeStickerPanel(); return; }
    try {
      attachmentOpen = false;
      currentStickerClient();
      composerInput?.blur();
      stickerPanelVersion++;
      stickerOpen = true;
    } catch { liveAnnouncement = { key: "stickers.error" }; }
  }
  function submit(): void {
    if (
      projection.canSubmit === false
    )
      return;
    const restoreText = composer.draft;
    const text = restoreText.trim();
    if (text.length > MAX_MESSAGE_LENGTH) return;
    if (text === "/compact" && (imageDrafts.length || fileDrafts.length)) {
      liveAnnouncement = { key: "error.compactImages" };
      return;
    }
    if (
      (!text && imageDrafts.length === 0 && fileDrafts.length === 0) ||
      composer.composing
    )
      return;
    const submittedDrafts = [...imageDrafts];
    const submittedFiles = [...fileDrafts];
    const originSessionId = sessionId;
    const originSessionGeneration = sessionGeneration;
    const sources = replacementSourceIds;
    replacementSourceIds = [];
    restoredNeedsAttachments = false;
    restoredEmptyRecovery = false;
    // Local recovery ownership is independent of native replacement sources.
    if (recoveredPendingKey) actions.dismissRecovery?.(recoveredPendingKey);
    recoveredPendingKey = "";
    composer = {
      ...reduceComposer(composer, { type: "submit" }),
      draft: "",
      composing: false,
    };
    imageDrafts = [];
    fileDrafts = [];
    returnToLatest();
    void tick().then(returnToLatest);
    void scheduleComposerResize();
    const onRetire = (): void => releaseSubmissionImages(submittedDrafts);
    void Promise.resolve()
      .then(() =>
        actions.send(text, submittedDrafts, onRetire, sources, submittedFiles),
      )
      .catch((error: unknown) => {
        // Only failures before admission return Files locally. Merge with current
        // edits even if another send began; native recovery is always explicit.
        if (
          error instanceof CompanionPreControllerError &&
          sessionId === originSessionId &&
          sessionGeneration === originSessionGeneration
        ) {
          composer = {
            ...composer,
            draft:
              restoreText && composer.draft
                ? `${restoreText}\n${composer.draft}`
                : restoreText || composer.draft,
            composing: false,
          };
          imageDrafts = [...imageDrafts, ...submittedDrafts];
          fileDrafts = [...fileDrafts, ...submittedFiles];
          replacementSourceIds = [
            ...new Set([...replacementSourceIds, ...sources]),
          ];
          void scheduleComposerResize();
        } else if (error instanceof CompanionPreControllerError) {
          releaseSubmissionImages(submittedDrafts);
        }
        if (sessionId !== originSessionId || sessionGeneration !== originSessionGeneration) return;
        const capacityKey = error instanceof CompanionPreControllerError
          ? capacityErrorKey(error.code)
          : undefined;
        liveAnnouncement =
          capacityKey
            ? { key: capacityKey }
            : error instanceof Error && error.message === "compact-with-images"
            ? { key: "error.compactImages" }
            : { key: "error.restored" };
      });
  }

  async function stop(): Promise<void> {
    if (!actions.stop || stopping) return;
    stopping = true;
    try {
      await actions.stop();
    } catch {
      liveAnnouncement = { key: "error.stop" };
    } finally {
      stopping = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (
      commandSuggestion &&
      (event.key === "Tab" || (event.key === "Enter" && composer.draft !== commandSuggestion.command)) &&
      !event.shiftKey &&
      !event.isComposing &&
      !composer.composing
    ) {
      event.preventDefault();
      acceptCommandSuggestion();
      return;
    }
    if (shouldSubmitEnter(event, composer.composing)) {
      event.preventDefault();
      submit();
    }
  }

  function setDraft(value: string): void {
    composer = reduceComposer(composer, { type: "input", value });
    void scheduleComposerResize();
  }
  function acceptCommandSuggestion(): void {
    if (!commandSuggestion) return;
    setDraft(commandSuggestion.command);
    void tick().then(() => composerInput?.focus());
  }
  function onInput(event: Event): void {
    setDraft((event.target as HTMLTextAreaElement).value);
  }
  function onCompositionEnd(event: CompositionEvent): void {
    composer = reduceComposer(composer, {
      type: "compositionend",
      value: (event.currentTarget as HTMLTextAreaElement).value,
    });
    void scheduleComposerResize();
  }
  function onCompositionStart(): void {
    composer = reduceComposer(composer, { type: "compositionstart" });
  }
  function addImages(files: readonly File[]): void {
    const error = imageIntakeError(imageDrafts, files, imageLimits);
    if (error) {
      liveAnnouncement = error;
      imageIntakeFailure = error;
      return;
    }
    imageIntakeFailure = undefined;
    imageDrafts = [...imageDrafts, ...createImageDrafts(files)];
  }
  function beginImageSelection(): void {
    imagePickerSession = sessionId;
    imagePickerGeneration = sessionGeneration;
  }
  function onImageInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (
      !files.length ||
      imagePickerSession !== sessionId ||
      imagePickerGeneration !== sessionGeneration ||
      attachmentDisposed ||
      !canIntakePhoto()
    ) return;
    addImages(files);
  }
  function onFileInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (
      !files.length ||
      filePickerSession !== sessionId ||
      filePickerGeneration !== sessionGeneration ||
      attachmentDisposed
    )
      return;
    const error = fileIntakeError(fileDrafts, files, fileLimits);
    if (error) {
      imageIntakeFailure = { key: `file.error.${error}` };
      liveAnnouncement = imageIntakeFailure;
      return;
    }
    imageIntakeFailure = undefined;
    fileDrafts = [...fileDrafts, ...createFileDrafts(files)];
  }
  function formatFileSize(size: number): string {
    if (size < 1000) return `${size} B`;
    if (size < 1_000_000) return `${(size / 1000).toFixed(1)} KB`;
    return `${(size / 1_000_000).toFixed(1)} MB`;
  }
  function fileNameParts(name: string): { stem: string; extension: string } {
    const dot = name.lastIndexOf(".");
    return dot > 0 && dot < name.length - 1
      ? { stem: name.slice(0, dot), extension: name.slice(dot) }
      : { stem: name, extension: "" };
  }
  async function downloadFile(item: TimelineFile): Promise<void> {
    const ref = item.attachment;
    const originSession = sessionId;
    const generation = sessionGeneration;
    if (!ref || ref.availability !== "available" || !originSession) return;
    try {
      const url = new URL(fileDownloadUrl(ref.attachmentId), location.href);
      // Check availability without buffering; the download manager reads the file.
      const response = await fetch(url, { credentials: "same-origin", redirect: "error" });
      if (!response.ok || sessionId !== originSession || generation !== sessionGeneration || attachmentDisposed) {
        await response.body?.cancel();
        throw new Error("file-unavailable");
      }
      await response.body?.cancel();
      if (sessionId !== originSession || generation !== sessionGeneration || attachmentDisposed) return;
      const link = document.createElement("a");
      link.href = url.href;
      link.download =
        ref.name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-").trim() ||
        "download";
      document.body.append(link);
      link.click();
      link.remove();
    } catch {
      if (sessionId === originSession && generation === sessionGeneration)
        liveAnnouncement = { key: "file.downloadFailed" };
    }
  }
  function onPaste(event: ClipboardEvent): void {
    const images = imageFilesFromClipboard(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    addImages(images);
  }

  function canIntakePhoto(): boolean {
    return (
      !!imageLimits &&
      projection.canSubmit !== false &&
      !attachmentDisposed
    );
  }
  function removeImage(draft: CompanionImageDraft): void {
    releaseSubmissionImages([draft]);
    imageDrafts = imageDrafts.filter((candidate) => candidate !== draft);
  }
  function openAttachmentMenu(): void {
    closeStickerPanel();
    attachmentOpen = true;
  }
  function chooseAttachment(kind: "camera" | "photos" | "files"): void {
    attachmentOpen = false;
    if (kind === "files") {
      if (!fileLimits || projection.canSubmit === false) return;
      filePickerSession = sessionId;
      filePickerGeneration = sessionGeneration;
      fileInput?.click();
      return;
    }
    if (!canIntakePhoto()) return;
    if (kind === "camera") photoCaptureInput?.click();
    else photoLibraryInput?.click();
  }
  function formatHistoryDate(value: string, locale: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return date.toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  function historyDimensionLabel(
    dimension: CompanionHistoryChange["dimension"],
  ): string {
    switch (dimension) {
      case "mood":
        return t("history.mood");
      case "affinity":
        return t("history.affinity");
      case "signature":
        return t("history.signature");
    }
  }
  function historyValueLabel(
    dimension: CompanionHistoryChange["dimension"],
    value: CompanionHistoryChange["after"],
  ): string {
    if (dimension === "mood") {
      const label = t(
        `mood.${value.value as CompanionLocaleKey}` as CompanionLocaleKey,
      );
      return "note" in value && value.note ? `${label} · ${value.note}` : label;
    }
    if (dimension === "affinity") return String(value.value);
    return value.value ? String(value.value) : t("signature.empty");
  }
  function changesForHistoryRecord(index: number): CompanionHistoryChange[] {
    const record = history.records[index];
    if (!record) return [];
    const predecessor =
      history.records[index + 1] ??
      (index === history.records.length - 1 ? history.predecessor : undefined);
    return companionHistoryChanges(record, predecessor);
  }
  async function loadEarlierHistory(): Promise<void> {
    if (!actions.loadEarlierHistory) return;
    try {
      await actions.loadEarlierHistory();
    } catch {
      // The bridge keeps the error state; avoid an unhandled event-handler
      // rejection while leaving the retry action available in the drawer.
    }
  }
  function openSearch(): void {
    searchOpen = true;
  }
  function openPreferences(): void {
    if (preferencesOpen) return;
    void navigate("/settings", {
      state: { companionSettings: true }, search: location.search, scrollToTop: false,
    });
  }
  function openPreferencesTab(tab: Exclude<PreferencesTab, "home">): void {
    const path = tab === "appearance" ? "/settings/appearance"
      : tab === "models" ? "/settings/models" : "/settings/voice-output";
    void navigate(path, {
      state: { companionSettings: true }, search: location.search, scrollToTop: false,
    });
  }
  function closePreferences(): void {
    if ((route.state as { companionSettings?: boolean } | null)?.companionSettings) {
      void navigate(-1);
    } else {
      void navigate(preferencesTab === "home" ? "/chat" : "/settings", {
        replace: true, search: location.search, scrollToTop: false,
      });
    }
  }
  function syncNavigation(path: string, entry: string | undefined, session: string | undefined, ready: boolean): void {
    const tab = preferencesTabFromPath(path);
    const changed = preferencesOpen !== (tab !== undefined) || (tab && preferencesTab !== tab);
    preferencesOpen = tab !== undefined;
    if (tab) preferencesTab = tab;
    if (changed) void tick().then(() => (tab ? preferencesBack : preferencesButton)?.focus());
    if (tab) return;
    if (!ready || !session) {
      appliedSection = "";
      return;
    }
    const section = path === "/memories" ? "history"
      : path === "/diary" || path.startsWith("/diary/") ? "diary"
      : path === "/album" ? "images"
      : path === "/wake" ? "alarms" : "chat";
    const key = JSON.stringify([session, section, section === "diary" ? entry : undefined]);
    if (appliedSection === key) return;
    appliedSection = key;
    if (section === "diary" && entry) {
      composerInput?.blur();
      closeStickerPanel();
      if (!detailOpen) onHistoryOpenChange?.(true);
      detailOpen = true;
      void openDiaryEntry(entry);
    } else applySection(section);
  }
  function setPreferencesSupport(
    tab: "models" | "voice-output",
    supported: boolean,
  ): void {
    if (tab === "models") modelSettingsSupported = supported;
    else voiceOutputSettingsSupported = supported;
    if (!supported && preferencesOpen && preferencesTab === tab) {
      void navigate("/settings", {
        replace: true, state: { companionSettings: true }, search: location.search, scrollToTop: false,
      });
    }
  }
  function closeSearch(): void {
    searchOpen = false;
  }
  function finishDetailClose(_restoreFocus = true): void {
    detailOpen = false;
    panelGeneration++;
    onHistoryOpenChange?.(false);
    void scheduleComposerResize();
  }
  function closeDetail(_restoreFocus = true): void {
    finishDetailClose();
  }
  function selectSection(tab: "chat" | typeof drawerTab): void {
    const path = tab === "history" ? "/memories" : tab === "diary" ? "/diary"
      : tab === "images" ? "/album" : tab === "alarms" ? "/wake" : "/chat";
    if (navigationPath === path || (tab === "chat" && navigationPath === "/")) {
      if (tab !== "chat") applySection(tab);
      return;
    }
    void navigate(path, { search: location.search, scrollToTop: false });
  }
  function applySection(tab: "chat" | typeof drawerTab): void {
    if (tab === "chat") {
      if (detailOpen) closeDetail();
      return;
    }
    composerInput?.blur();
    closeStickerPanel();
    if (!detailOpen) onHistoryOpenChange?.(true);
    detailOpen = true;
    if (tab === "history") {
      drawerTab = "history";
      panelGeneration++;
      void actions.refreshRelationship?.(true);
    } else if (tab === "diary") void openDiary();
    else if (tab === "images") void openGallery();
    else void openAlarms();
  }
  function selectDiaryEntry(entry: string): void {
    void navigate("/diary/:entry", {
      params: { entry }, state: { fromDiary: true }, search: location.search, scrollToTop: false,
    });
  }
  function backToDiary(): void {
    if ((route.state as { fromDiary?: boolean } | null)?.fromDiary) void navigate(-1);
    else void navigate("/diary", { replace: true, search: location.search, scrollToTop: false });
  }
  let imagePress: ReturnType<typeof longPress> | undefined;
  function finishPhotoBrowser(): void {
    dismissMessageMenu();
    imagePress?.destroy();
    imagePress = undefined;
    photoBrowser = undefined;
    photoLoading = false;
    photoError = false;
    lightbox = undefined;
    lightboxUrl = "";
    releaseDeferredPreviewReleases();
    lightboxReturnFocus?.focus({ preventScroll: true });
    lightboxReturnFocus = undefined;
  }
  function closePhotoBrowser(): void {
    photoGeneration++;
    if (photoBrowser) photoBrowser.destroy();
    else finishPhotoBrowser();
  }
  function photoFallbackFocus(node: HTMLElement) {
    const overlay = { el: node };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePhotoBrowser();
      }
    };
    overlayOpening(overlay);
    node.addEventListener("keydown", keydown);
    overlayOpened(overlay);
    return { destroy() { node.removeEventListener("keydown", keydown); overlayDestroyed(overlay); } };
  }
  async function openLightbox(item: ImagePreviewTarget): Promise<void> {
    closePhotoBrowser();
    const generation = ++photoGeneration;
    lightboxReturnFocus = captureReadingFocus(document);
    lightbox = item;
    lightboxUrl = item.previewUrl ?? imageUrls[item.id] ?? "";
    photoLoading = true;
    photoError = false;
    const url = lightboxUrl;
    let browser: PhotoSwipe | undefined;
    let removeKeydown = () => {};
    try {
      if (!url) throw new Error("Image unavailable");
      const image = new Image();
      image.src = url;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Image unavailable"));
        if (image.complete && image.naturalWidth) resolve();
      });
      if (generation !== photoGeneration) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image dimensions");
      browser = new PhotoSwipe({
        dataSource: [{ src: lightboxUrl, width: image.naturalWidth, height: image.naturalHeight, alt: item.alt }],
        index: 0,
        escKey: false,
        bgClickAction: "close",
        maxZoomLevel: 4,
        closeTitle: t("image.close"),
      });
      photoBrowser = browser;
      browser.on("contentAppendImage", ({ content }) => {
        const element = content.element;
        if (!(element instanceof HTMLElement)) return;
        imagePress?.destroy();
        imagePress = longPress(element, {
          run: (node, source) => showImageMenu(lightboxUrl, item.alt, node, undefined, item.attachment, source),
        });
      });
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !messageMenuOpen()) {
          event.preventDefault();
          closePhotoBrowser();
        }
      };
      document.addEventListener("keydown", keydown, true);
      removeKeydown = () => document.removeEventListener("keydown", keydown, true);
      browser.on("destroy", () => {
        removeKeydown();
        finishPhotoBrowser();
      });
      browser.init();
      photoLoading = false;
    } catch {
      if (generation === photoGeneration) {
        removeKeydown();
        if (browser) {
          const returnTarget = lightboxReturnFocus;
          browser.destroy();
          lightboxReturnFocus = returnTarget;
          lightbox = item;
          lightboxUrl = url;
        }
        photoLoading = false;
        photoError = true;
      }
    }
  }
  function showLightbox(item: TimelineImage): void {
    openLightbox({
      id: item.id,
      alt: item.alt || t("image.preview"),
      previewUrl: item.previewUrl ?? imageUrls[item.id],
      attachment: item.attachment as ImageRef | undefined,
    });
  }
  function showDraftLightbox(draft: CompanionImageDraft): void {
    openLightbox({
      id: `draft:${draft.id}`,
      alt: draft.file.name || t("image.pending"),
      previewUrl: draft.previewUrl,
    });
  }
  function showFileMenu(item: TimelineFile, target: HTMLElement): void {
    if (showFailedMenu(item.messageKey, target)) return;
    if (item.attachment?.availability !== "available") return;
    messageMenu(
      target,
      [{ text: t("file.download"), run: () => downloadFile(item) }],
      t("actions.cancel"),
    );
  }
  function showFailedMenu(key: string, target: HTMLElement): boolean {
    const unit = projection.messageUnits.find((u) => u.id === key);
    if (!unit?.failed) return false;
    messageMenu(
      target,
      [
        {
          text: t("messages.retryFailed"),
          run: () => actions.retryFailed?.(unit.actionId ?? key),
        },
        {
          text: t("messages.deleteFailed"),
          run: () => {
            messageMenu(
              target,
              [
                {
                  text: t("messages.deleteFailed"),
                  run: () => actions.deleteFailed?.(unit.actionId ?? key),
                },
              ],
              t("actions.cancel"),
              t("messages.deleteFailedConfirm"),
            );
          },
        },
      ],
      t("actions.cancel"),
    );
    return true;
  }
  function showToast(text: string): void {
    clearTimeout(toastTimer);
    toastText = text;
    toastTimer = setTimeout(() => { toastText = ""; }, 2500);
  }
  function showImageMenu(
    url: string,
    name: string,
    target: HTMLElement,
    key?: string,
    attachment?: ImageRef,
    source: "keyboard" | "mouse" | "touch" = "touch",
  ): void {
    if (key && showFailedMenu(key, target)) return;
    if (!url) return;
    const generation = imageSessionGeneration;
    messageMenu(
      target,
      [
        ...(attachment && actions.openStickers
          ? [
              {
                text: t("stickers.favoriteImage"),
                run: async () => {
                  if (generation !== imageSessionGeneration) return;
                  try {
                    await currentStickerClient().favoriteImage(attachment);
                    if (generation === imageSessionGeneration) {
                      stickerFavoritesRevision++;
                      showToast(t("stickers.favoriteSaved"));
                    }
                  } catch {
                    if (generation === imageSessionGeneration)
                      showToast(t("stickers.favoriteFailed"));
                  }
                },
              },
            ]
          : []),
        {
          text: t("image.save"),
          run: async () => {
            if (generation !== imageSessionGeneration) return;
            try {
              await saveImage(url, name);
              showToast(t("image.saved"));
            } catch {
              showToast(t("image.saveFailed"));
            }
          },
        },
      ],
      t("actions.cancel"),
      undefined,
      { compact: true, autoFocus: source !== "touch" },
    );
  }
  async function loadOlder(): Promise<void> {
    if (!actions.loadOlder || projection.loadingOlder) return;
    const scrollContainer = timeline;
    const previousHeight = timeline?.scrollHeight ?? 0;
    const previousTop = timeline?.scrollTop ?? 0;
    preservingHistoryPosition = true;
    wasNearBottom = false;
    try {
      await actions.loadOlder();
      await tick();
      if (timeline && timeline === scrollContainer)
        timeline.scrollTop = previousTop + timeline.scrollHeight - previousHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } finally {
      preservingHistoryPosition = false;
    }
  }
  function refreshVisiblePanel(): void {
    if (drawerTab === "history") {
      panelGeneration++;
      void actions.refreshRelationship?.(true);
    } else if (drawerTab === "diary") {
      if (diarySelected) void openDiaryEntry(diarySelected);
      else void openDiary();
    } else if (drawerTab === "images") void openGallery();
    else void openAlarms();
  }
  function beginPanel(tab: typeof drawerTab, summary = true): number {
    if (summary) void actions.refreshRelationship?.();
    drawerTab = tab;
    return ++panelGeneration;
  }
  async function openDiary(append = false): Promise<void> {
    const generation = beginPanel("diary", !append);
    diarySelected = undefined;
    diaryEntry = undefined;
    diaryMissing = false;
    diaryTooLarge = false;
    diaryLoading = true;
    diaryError = false;
    if (!append) {
      diaryEntries = [];
      diaryCursor = null;
    }
    try {
      if (!actions.readPanel) throw new Error();
      const page = await actions.readPanel("diaryList", {
        cursor: append ? diaryCursor : null,
      });
      if (generation !== panelGeneration) return;
      diaryEntries = [...new Set([...diaryEntries, ...page.entries])];
      diaryCursor = page.nextCursor;
    } catch {
      if (generation === panelGeneration) diaryError = true;
    } finally {
      if (generation === panelGeneration) diaryLoading = false;
    }
  }
  async function openAlarms(): Promise<void> {
    const generation = beginPanel("alarms");
    alarmsLoading = true;
    alarmsError = false;
    try {
      if (!actions.readPanel) throw new Error();
      const page = await actions.readPanel("reminders", {});
      if (generation === panelGeneration) alarms = page.reminders;
    } catch {
      if (generation === panelGeneration) alarmsError = true;
    } finally {
      if (generation === panelGeneration) alarmsLoading = false;
    }
  }
  async function openGallery(append = false): Promise<void> {
    if (append && galleryLoading) return;
    const generation = beginPanel("images", !append);
    galleryLoading = true;
    galleryError = false;
    if (!append) {
      galleryImages = [];
      galleryCursor = undefined;
    }
    try {
      if (!actions.readPanel) throw new Error();
      const page = await actions.readPanel("album", {
        cursor: append ? (galleryCursor ?? null) : null,
      });
      if (generation !== panelGeneration) return;
      galleryImages = [
        ...new Map(
          [
            ...galleryImages,
            ...page.images.map((image) => ({
              ...image,
              created: image.createdAt,
              url: image.previewUrl ?? "",
              originalUrl: image.originalUrl ?? "",
            })),
          ].map((image) => [image.id, image]),
        ).values(),
      ];
      galleryCursor = page.nextCursor ?? undefined;
    } catch {
      if (generation === panelGeneration) galleryError = true;
    } finally {
      if (generation === panelGeneration) galleryLoading = false;
    }
  }
  async function openDiaryEntry(name: string): Promise<void> {
    const generation = beginPanel("diary", false);
    diarySelected = name;
    diaryEntry = undefined;
    diaryLoading = true;
    diaryError = false;
    diaryMissing = false;
    diaryTooLarge = false;
    try {
      if (!actions.readPanel) throw new Error();
      const entry = await actions.readPanel("diaryRead", { name });
      if (generation !== panelGeneration) return;
      if (entry.status === "found") diaryEntry = entry;
      else if (entry.status === "missing") diaryMissing = true;
      else diaryTooLarge = true;
    } catch {
      if (generation === panelGeneration) diaryError = true;
    } finally {
      if (generation === panelGeneration) diaryLoading = false;
    }
  }

  onDestroy(() => {
    clearTimeout(toastTimer);
    resetStickerClient();
    attachmentDisposed = true;
    sessionGeneration += 1;
    dismissMessageMenu();
    imagePress?.destroy();
    panelGeneration++;
    closePhotoBrowser();
    if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
    releaseDeferredPreviewReleases();
    releaseSubmissionImages(imageDrafts);
    clearWaitingTimers();
    for (const audio of document.querySelectorAll<HTMLAudioElement>(
      "#dsh-companion .companion-voice audio",
    ))
      audio.pause();
    for (const url of Object.values(imageUrls)) releaseImageUrl(url);
    releaseDeferredPreviewReleases();
  });
</script>

<KonstaProvider theme={konstaTheme} dark>
<Page
  id="dsh-companion"
  class="page companion-shell"
  data-testid="companion-root"
  inert={preferencesOpen}
>
    <header class="navbar companion-header"><div class="navbar-inner">
      <div class="konsta-chat companion-header-identity" data-testid="companion-identity">
        <KonstaGlass class="companion-identity-chip" title={identity.companionName}>
          <span class="companion-identity-avatar companion-avatar-crop" aria-hidden="true">
            {#if identity.companionAvatar}<img src={identity.companionAvatar} alt="" />{:else}✦{/if}
          </span>
          <span class="companion-identity-name">{identity.companionName}</span>
        </KonstaGlass>
      </div>
      <div class="companion-presence companion-sr-only" aria-live="polite">
          <span
            class="companion-status {projection.status === 'offline'
              ? 'color-red'
              : projection.status === 'working'
                ? 'color-orange'
                : 'color-green'}"
          ></span>{statusText}
      </div>
      <div class="konsta-chat companion-header-actions-region">
      <KonstaGlass class="companion-header-actions">
      {#if contextCapacity || (projection.running && actions.stop)}
        <div class="companion-context-meter-wrap">
          {#if contextCapacity}
          <button
            bind:this={contextMeterButton}
            class="button button-tonal button-round companion-context-meter"
            class:companion-context-meter-open={contextMeterOpen}
            data-state={continuityStatus?.status === "running"
              ? "active"
              : continuityStatus?.status === "failed"
                ? "failed"
                : contextCapacity.percentage >= 80
                  ? "warning"
                  : "idle"}
            type="button"
            aria-label={t("context.percentage", {
              percentage: contextCapacity.percentage,
            })}
            aria-haspopup="dialog"
            aria-expanded={contextMeterOpen}
            aria-controls="companion-context-popover"
            aria-hidden={projection.running && actions.stop ? "true" : undefined}
            disabled={!!(projection.running && actions.stop)}
            tabindex={projection.running && actions.stop ? -1 : undefined}
            on:click={toggleContextMeter}
          >
            <svg viewBox="0 0 28 28" aria-hidden="true"
              ><circle
                class="companion-context-meter-track"
                cx="14"
                cy="14"
                r="11"
              ></circle><circle
                class="companion-context-meter-value"
                cx="14"
                cy="14"
                r="11"
                pathLength="100"
                style={`stroke-dashoffset:${100 - contextCapacity.percentage}`}
              ></circle></svg
            >
          </button>
          {/if}
          {#if projection.running && actions.stop}
            <KonstaButton
              class="companion-reply-stop"
              clear rounded
              type="button"
              data-testid="companion-stop"
              aria-label={t("reply.stop")}
              onClick={() => void stop()}
              disabled={stopping}
              ><Square size={12} fill="currentColor" aria-hidden="true" /></KonstaButton
            >
          {/if}
        </div>
      {/if}
      <KonstaButton rounded tonal
        type="button"
        class="button button-tonal button-round companion-search-trigger"
        aria-label={t("search.open")}
        aria-haspopup="dialog"
        onClick={openSearch}
        ><Search size={19} strokeWidth={1.8} aria-hidden="true" /></KonstaButton
      >
      <button bind:this={preferencesButton} type="button" class="button button-tonal button-round companion-preferences-trigger"
        aria-label={t("preferences.open")} on:click={openPreferences}>
        <Settings size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      </KonstaGlass>
      </div>
    </div></header>
    {#if effectiveWorkspaceReadiness === "ready" && effectiveSessionReadiness === "ready" && projection.openState !== "error"}
      <div class="konsta-chat companion-composer-region">
      <KonstaGlass class="toolbar messagebar companion-composer companion-compose-row" highlight={false}>
        <div class="companion-compose-content" hidden={detailOpen}>
        {#snippet beforeInner()}
          {#if commandSuggestion}
            <div
              id="companion-command-suggestions"
              class="companion-command-suggestions"
              role="listbox"
              aria-label={t("command.label")}
            >
              <KonstaButton tonal
                id="companion-command-compact"
                class="button button-tonal companion-command-suggestion"
                type="button"
                role="option"
                aria-selected="true"
                onClick={acceptCommandSuggestion}
              >
                <span class="companion-command-name"
                  >{commandSuggestion.command}</span
                >
                <span class="companion-command-description"
                  >{commandSuggestion.description}</span
                >
                <span class="companion-command-tab" aria-hidden="true">Tab</span
                >
              </KonstaButton>
            </div>
          {/if}
          {#if continuityStatus}
            <div
              class="companion-continuity-status"
              data-testid="companion-continuity-status"
              data-state={continuityStatus.status}
              role={continuityStatus.status === "failed" ? "alert" : "status"}
              aria-live="polite"
            >
              {#if continuityStatus.status === "running"}{t(
                  "compact.running",
                )}{:else if continuityStatus.status === "failed"}{t(
                  "compact.failed",
                )}{/if}
            </div>
          {/if}
        {/snippet}
        {#snippet beforeArea()}
          {#if recoveredDraft && recoveredDraft.key !== recoveredDraftKey}
            <div
              class="companion-input-recovery"
              role="status"
              data-testid="input-recovery"
            >
              <span>{t("recovery.available")}</span>
              <KonstaButton tonal
                class="button button-tonal"
                type="button"
                disabled={!recoveredDraft.replacementEligible ||
                  !!composer.draft.trim() ||
                  imageDrafts.length > 0 ||
                  fileDrafts.length > 0}
                onClick={() =>
                  recoveredDraft && restoreRecoveredDraft(recoveredDraft)}
                >{t("recovery.restore")}</KonstaButton
              >
              <KonstaButton
                class="button"
                type="button"
                onClick={() => {
                  if (recoveredDraft)
                    actions.dismissRecovery?.(recoveredDraft.key);
                }}>{t("recovery.discard")}</KonstaButton
              >
              <details>
                <summary>{t("recovery.inspect")}</summary>
                <p>{recoveredDraft.input}</p>
                {#each recoveredDraft.images as image}<img
                    class="companion-recovery-preview"
                    src={image.url}
                    alt={image.name}
                  />{/each}
                {#each recoveredDraft.files ?? [] as file}<p>
                    {file.name}
                  </p>{/each}
              </details>
              {#if composer.draft.trim() || imageDrafts.length || fileDrafts.length}<span
                  >{t("recovery.busy")}</span
                >{/if}
            </div>
          {/if}
          {#if replacementSourceIds.length || (recoveredDraftKey && (restoredNeedsAttachments || restoredEmptyRecovery))}
            <div class="companion-input-recovery">
              {#if restoredNeedsAttachments}<span>{t("recovery.missing")}</span>{/if}
              <KonstaButton
                class="button"
                type="button"
                onClick={() => {
                  actions.dismissRecovery?.(recoveredDraftKey);
                  recoveredDraftKey = "";
                  recoveredPendingKey = "";
                  releaseSubmissionImages(imageDrafts);
                  imageDrafts = [];
                  fileDrafts = [];
                  composer = { ...composer, draft: "", composing: false };
                  replacementSourceIds = [];
                  restoredNeedsAttachments = false;
                  restoredEmptyRecovery = false;
                  void scheduleComposerResize();
                }}>{t("recovery.discardRestored")}</KonstaButton
              >
            </div>
          {/if}
          <input
            bind:this={photoLibraryInput}
            id="companion-image-library"
            class="companion-image-input"
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            tabindex="-1"
            aria-hidden="true"
            on:click={beginImageSelection}
            on:change={onImageInput}
          />
          <input
            bind:this={photoCaptureInput}
            id="companion-image-capture"
            class="companion-image-input"
            type="file"
            accept={IMAGE_ACCEPT}
            capture="environment"
            tabindex="-1"
            aria-hidden="true"
            on:click={beginImageSelection}
            on:change={onImageInput}
          />
          <input
            bind:this={fileInput}
            class="companion-image-input"
            type="file"
            multiple
            tabindex="-1"
            aria-hidden="true"
            on:change={onFileInput}
          />

          {#if imageDrafts.length || fileDrafts.length}
            <div
              class="companion-image-drafts"
              role="group"
              aria-label={t("attachment.pending")}
            >
              {#each imageDrafts as draft (draft.id)}
                <div class="companion-image-draft">
                  <button
                    type="button"
                    class="companion-image-draft-preview"
                    aria-label={t("image.view", {
                      name: draft.file.name || t("image.pending"),
                    })}
                    on:click={() => showDraftLightbox(draft)}
                    ><img
                      src={draft.previewUrl}
                      alt={draft.file.name || t("image.pending")}
                    /></button
                  >
                  <KonstaButton
                    type="button"
                    class="companion-image-draft-remove"
                    tonal rounded
                    aria-label={t("image.remove")}
                    onClick={() => removeImage(draft)}
                    ><X size={16} aria-hidden="true" /></KonstaButton
                  >
                </div>
              {/each}
              {#each fileDrafts as draft (draft.id)}
                {@const fileName = fileNameParts(draft.file.name)}
                <KonstaChip class="companion-file-draft" data-testid="file-draft" title={draft.file.name}>
                  <FileText size={18} aria-hidden="true" />
                  <div class="companion-file-details">
                    <span class="companion-file-name" aria-label={draft.file.name}><span class="companion-file-name-stem">{fileName.stem}</span><span class="companion-file-name-extension">{fileName.extension}</span></span><small
                      >{formatFileSize(draft.file.size)}</small
                    >
                  </div>
                  <KonstaButton
                    class="companion-file-draft-remove"
                    clear rounded
                    type="button"
                    aria-label={t("file.remove", { name: draft.file.name })}
                    onClick={() =>
                      (fileDrafts = fileDrafts.filter((item) => item !== draft))}
                  >
                    <X size={16} aria-hidden="true" />
                  </KonstaButton>
                </KonstaChip>
              {/each}
            </div>
          {/if}
        {/snippet}
        {#snippet composerActions()}
          <KonstaButton class="companion-stickers" tonal rounded type="button"
            aria-label={t("stickers.open")} aria-pressed={stickerOpen}
            aria-haspopup="dialog" aria-expanded={stickerOpen}
            inert={composerExpanded} aria-hidden={composerExpanded}
            disabled={!actions.openStickers}
            onClick={toggleStickerPanel}
            ><Smile size={20} aria-hidden="true" /></KonstaButton
          >
          {#if imageLimits || fileLimits}<KonstaButton
              class="companion-attach" tonal rounded type="button"
              aria-label={t("attachment.open")} title={t("attachment.open")}
              aria-haspopup="dialog" aria-expanded={attachmentOpen}
              inert={composerExpanded} aria-hidden={composerExpanded}
              onClick={openAttachmentMenu}
              ><Plus size={19} strokeWidth={2} aria-hidden="true" /></KonstaButton
            >
          {/if}
        {/snippet}
        {#snippet afterInner()}
          {#if projection.promptError || imageIntakeFailure}
            <div
              class="companion-input-error"
              role="alert"
              data-testid="input-error"
            >
              {(capacityErrorKey(projection.promptErrorCode)
                ? t(capacityErrorKey(projection.promptErrorCode)!)
                : projection.promptError) ||
                (imageIntakeFailure
                  ? t(imageIntakeFailure.key, imageIntakeFailure.params)
                  : "")}
            </div>
          {/if}
          <div
            use:connectMessagebar={{
              label: t("composer.label"),
              suggestions: !!commandSuggestion,
            }}
          ></div>
          {#if composer.draft.trim().length > MAX_MESSAGE_LENGTH}
            <div
              class="companion-input-error"
              role="alert"
            >
              {t("message.tooLong", {
                limit: MAX_MESSAGE_LENGTH,
                count: composer.draft.trim().length,
              })}
            </div>
          {/if}
        {/snippet}
        {@render beforeInner()}
        {@render beforeArea()}
        <KonstaMessagebar
          class="companion-konsta-messagebar"
          textareaId="companion-textarea"
          value={composer.draft}
          placeholder={t("composer.textOnlyPlaceholder")}
          right={composerActions}
          onInput={onInput}
        />
        {@render afterInner()}
        </div>
        <nav class="companion-bottom-nav" aria-label={t("navigation.label")}>
          <KonstaTabbar icons labels>
            <KonstaTabbarLink class="companion-nav-item" component="button"
              active={!detailOpen} aria-current={!detailOpen ? "page" : undefined}
              label={t("navigation.chat")} linkProps={{ type: "button", onClick: () => selectSection("chat") }}>
              {#snippet icon()}<MessageCircle size={22} aria-hidden="true" />{/snippet}
            </KonstaTabbarLink>
            <KonstaTabbarLink id="companion-history-tab" class="companion-nav-item" component="button"
              active={detailOpen && drawerTab === "history"} aria-current={detailOpen && drawerTab === "history" ? "page" : undefined}
              aria-disabled={!actions.refreshRelationship} label={t("navigation.memories")}
              linkProps={{ type: "button", disabled: !actions.refreshRelationship, onClick: () => selectSection("history") }}>
              {#snippet icon()}<Heart size={22} aria-hidden="true" />{/snippet}
            </KonstaTabbarLink>
            <KonstaTabbarLink id="companion-diary-tab" class="companion-nav-item" component="button"
              active={detailOpen && drawerTab === "diary"} aria-current={detailOpen && drawerTab === "diary" ? "page" : undefined}
              aria-disabled={!actions.readPanel} label={t("navigation.diary")}
              linkProps={{ type: "button", disabled: !actions.readPanel, onClick: () => selectSection("diary") }}>
              {#snippet icon()}<BookOpen size={22} aria-hidden="true" />{/snippet}
            </KonstaTabbarLink>
            <KonstaTabbarLink id="companion-images-tab" class="companion-nav-item" component="button"
              active={detailOpen && drawerTab === "images"} aria-current={detailOpen && drawerTab === "images" ? "page" : undefined}
              aria-disabled={!actions.readPanel} label={t("navigation.album")}
              linkProps={{ type: "button", disabled: !actions.readPanel, onClick: () => selectSection("images") }}>
              {#snippet icon()}<Images size={22} aria-hidden="true" />{/snippet}
            </KonstaTabbarLink>
            <KonstaTabbarLink id="companion-alarms-tab" class="companion-nav-item" component="button"
              active={detailOpen && drawerTab === "alarms"} aria-current={detailOpen && drawerTab === "alarms" ? "page" : undefined}
              aria-disabled={!actions.readPanel} label={t("navigation.wake")}
              linkProps={{ type: "button", disabled: !actions.readPanel, onClick: () => selectSection("alarms") }}>
              {#snippet icon()}<AlarmClock size={22} aria-hidden="true" />{/snippet}
            </KonstaTabbarLink>
          </KonstaTabbar>
        </nav>
      </KonstaGlass>
      </div>
    {/if}
  <div class="companion-app" use:connectViewport>
    <div class="companion-content">
      <main class="companion-main" aria-label={t("chat.label")}>
        {#if effectiveWorkspaceReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <Preloader class="preloader  " aria-hidden="true" /><span
              >{t("loading.progress")}</span
            >
          </section>
        {:else if effectiveWorkspaceReadiness === "missing"}
          <section class="companion-recovery" role="alert">
            <div class="companion-mood-orb" aria-hidden="true"></div>
            <h1>{t("workspace.empty")}</h1>
            <p>{t("workspace.chooseHint")}</p>
            <KonstaButton
              component="a"
              href="/"
              aria-label={t("workspace.settingsLabel")}
              onClick={() => dispatch("recovery")}>{t("settings.open")}</KonstaButton
            >
          </section>
        {:else if effectiveWorkspaceReadiness === "error"}
          <section class="companion-recovery" role="alert">
            <div class="companion-mood-orb" aria-hidden="true"></div>
            <h1>{t("workspace.failed")}</h1>
            <p>{t("workspace.reconnectHint")}</p>
            <KonstaButton
              class="button button-fill"
              onClick={() => dispatch("recovery")}>{t("reconnect")}</KonstaButton
            >
          </section>
        {:else if effectiveSessionReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <Preloader class="preloader  " aria-hidden="true" /><span
              >{t("loading.progress")}</span
            >
          </section>
        {:else if effectiveSessionReadiness === "error" || projection.openState === "error"}
          <section class="companion-recovery" role="alert">
            <div class="companion-mood-orb" aria-hidden="true"></div>
            <h1>{t("session.failed")}</h1>
            <p>
              {t("session.reconnectHint")}
            </p>
            <KonstaButton
              class="button button-fill"
              onClick={() => dispatch("recovery")}>{t("reconnect")}</KonstaButton
            >
          </section>
        {:else}
          <div class="companion-timeline-region" class:companion-timeline-wallpaper={!!backgrounds} hidden={detailOpen}>
            {#if backgrounds}
              <div class="companion-chat-background" aria-hidden="true">
                {#key backgroundVersion}
                  <img
                    class="companion-background-landscape"
                    src={backgrounds.landscape}
                    alt=""
                  />
                  <img
                    class="companion-background-portrait"
                    src={backgrounds.portrait}
                    alt=""
                  />
                {/key}
              </div>
            {/if}
            <div
              class={`page-content companion-timeline ${timelineReady ? "timeline-ready" : ""}`}
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              on:scroll={onScroll}
            >
              <div class="companion-timeline-content" use:connectTimeline>
                <Messages class="konsta-chat messages">
                  {#if displayedProjection.historySyncFailed}
                    <div class="companion-media-failure" role="alert">
                      <span>{t("history.loadFailed")}</span>
                      <KonstaButton small tonal class="button button-tonal button-small" onClick={() => actions.retryChatHistory?.()}>{t("history.retry")}</KonstaButton>
                    </div>
                  {/if}
                  {#if displayedProjection.hasMore}
                    <KonstaButton small tonal
                      class="button button-tonal button-small"
                      style="display:block;margin:0 auto 18px"
                      onClick={loadOlder}
                      disabled={displayedProjection.loadingOlder}
                      >{displayedProjection.loadingOlder
                        ? t("loading.progress")
                        : t("history.older")}</KonstaButton
                    >
                  {/if}
                  {#if displayedProjection.items.length === 0}
                    <div class="companion-recovery">
                      <div class="companion-mood-orb" aria-hidden="true"></div>
                      <h1>
                        {t("welcome.greeting", {
                          name: identity.preferredAddress,
                        })}
                      </h1>
                      <p>{t("welcome.prompt")}</p>
                    </div>
                  {/if}
                  {#each visibleMessageUnits as unit (unit.id)}
                    {#each (displayedProjection.historyGaps ?? []).filter((gap) => gap.beforeId === unit.sourceId) as gap (gap.id)}
                      <div class="companion-history-gap" use:watchHistoryGap={gap} data-testid={`history-gap-${gap.id}`}>
                        {#if gap.status === "loading"}
                          <span role="status">{t("loading.progress")}</span>
                        {:else if gap.status === "unavailable"}
                          <span role="status">{t("history.gapUnavailable")}</span>
                        {:else}
                          {#if gap.status === "error"}<span role="alert">{t("history.gapFailed")}</span>{/if}
                          <Button type="button" small tonal onClick={() => void actions.fillHistoryGap?.(gap.id)}>
                            {t(gap.status === "error" ? "history.retry" : "history.gapMore")}
                          </Button>
                        {/if}
                      </div>
                    {/each}
                    {#if timeHeadings[unit.id]}
                      <KonstaMessagesTitle class="companion-chat-day" data-testid={`chat-time-${unit.id}`}><KonstaChip><time datetime={timeHeadings[unit.id].datetime}>{timeHeadings[unit.id].label}</time></KonstaChip></KonstaMessagesTitle>
                    {/if}
                    {@const first = unit.items[0]}
                    {#if first?.kind === "notice"}
                      <div
                        class="companion-notice"
                        role={first.tone === "error" ? "alert" : "status"}
                      >
                        <p>{noticeText(first, t)}</p>
                      </div>
                    {:else}
                      {@const parts = messageContentParts(unit)}
                      {#each parts as part, partIndex (part.kind === "images" ? part.items[0].id : part.item.id)}
                        {@const independentMessage =
                          unit.answer &&
                          part.kind === "item" &&
                          part.item.kind === "text"}
                        {#snippet imageContent()}{#if part.kind === "images"}
                            {#if partIndex === 0 && unit.thinking}<Thinking
                                text={unit.thinking}
                              />{/if}
                            <!-- svelte-ignore a11y_no_noninteractive_tabindex (failed image content provides keyboard context-menu access without a nested button) -->
                            <div
                              class="companion-image-bubble companion-image-group"
                              data-testid={`image-group-${unit.id}`}
                              tabindex={unit.failed ? 0 : -1}
                              use:longPress={{
                                run: (node) => {
                                  if (unit.failed)
                                    showFailedMenu(unit.id, node);
                                },
                              }}
                            >
                              {#each part.items as image (image.id)}
                                <div
                                  class="companion-image-entry"
                                  class:companion-image-entry-tile={part.items
                                    .length > 1}
                                  data-testid={`image-${image.id}`}
                                >
                                  <div
                                    class="companion-media"
                                    class:companion-media-tile={part.items
                                      .length > 1}
                                    class:companion-media-single={part.items
                                      .length === 1}
                                  >
                                    {#if image.state === "running" || image.state === "loading"}
                                      <div class="companion-media-pending" role="status" aria-label={t("image.generating")}>
                                        <Preloader class="preloader" aria-hidden="true" />
                                      </div>
                                    {:else if image.previewUrl || imageUrls[image.id]}
                                      <button
                                        class="companion-media-button"
                                        aria-label={t("image.view", {
                                          name: image.alt || t("image.preview"),
                                        })}
                                        on:click={() => showLightbox(image)}
                                        use:longPress={{
                                          run: (node, source) =>
                                            showImageMenu(
                                              imageUrls[image.id] ||
                                                image.previewUrl ||
                                                "",
                                              image.alt || t("image.preview"),
                                              node,
                                              unit.id,
                                              image.attachment as ImageRef | undefined,
                                              source,
                                            ),
                                        }}
                                        ><img
                                          src={image.previewUrl ??
                                            imageUrls[image.id]}
                                          alt={image.alt || t("image.preview")}
                                          style={imageStyle(
                                            image,
                                            part.items.length > 1,
                                          )}
                                          on:load={(event) =>
                                            onImageLoaded(image, event)}
                                        /></button
                                      >
                                    {:else if imageErrors[image.id]}
                                      <div
                                        class="companion-media-failure"
                                        role="alert"
                                        style={imageStyle(
                                          image,
                                          part.items.length > 1,
                                        )}
                                      >
                                        <span>{t("error.image")}</span><KonstaButton small tonal
                                          class="button button-tonal button-small"
                                          type="button"
                                          onClick={() => retryImage(image)}
                                          >{t("retry")}</KonstaButton
                                        >
                                      </div>
                                    {:else if image.state === "failed"}
                                      <div
                                        class="companion-media-failure"
                                        role="alert"
                                        style={imageStyle(
                                          image,
                                          part.items.length > 1,
                                        )}
                                      >
                                        <span>{image.error ?? t("image.failed")}</span>
                                      </div>
                                    {:else}
                                      <Preloader
                                        class="preloader  companion-media-spinner"
                                        role="status"
                                        aria-label={t("loading.progress")}
                                      />
                                    {/if}
                                  </div>
                                </div>
                              {/each}
                            </div>
                          {/if}{/snippet}
                        {#snippet textContent()}{#if part.kind !== "images"}
                            {#if partIndex === 0 && unit.thinking}<Thinking
                                text={unit.thinking}
                              />{/if}
                            {#if part.item.kind === "text"}
                              <!-- svelte-ignore a11y_no_noninteractive_tabindex (focusable message content supports keyboard selection without a button role around nested links) -->
                              <div
                                class="companion-text-bubble"
                                tabindex="0"
                              >
                                {#if unit.alarm}
                                  <ReminderBody
                                    text={part.item.text}
                                    id={part.item.id}
                                    {t}
                                  />
                                {:else}
                                  <Markdown
                                    text={part.item.text}
                                    agentReply={unit.answer}
                                    {workspaceImages}
                                    workspaceImageScope={sessionId}
                                    {t}
                                  />
                                {/if}
                              </div>
                            {:else if part.item.kind === "file"}
                              {@const item = part.item}
                              {@const fileName = fileNameParts(item.name)}
                              <button
                                class="companion-file-message"
                                type="button"
                                data-testid="file-message"
                                aria-label={t("file.actions", { name: item.name })}
                                title={item.name}
                                disabled={!unit.failed && item.attachment?.availability !== "available"}
                                on:click={(event) => showFileMenu(item, event.currentTarget)}
                                use:longPress={{ run: (node) => showFileMenu(item, node) }}
                              >
                                <FileText size={20} aria-hidden="true" />
                                <div class="companion-file-details">
                                  <span class="companion-file-name" aria-label={item.name}><span class="companion-file-name-stem">{fileName.stem}</span><span class="companion-file-name-extension">{fileName.extension}</span></span><small
                                    >{formatFileSize(item.size)}</small
                                  >
                                </div>
                                {#if item.attachment?.availability === "missing"}
                                  <span role="status">{t("file.missing")}</span>
                                {/if}
                              </button>
                            {:else if part.item.kind === "ui"}
                              <A2UISurface payload={part.item.payload} {locale} />
                            {:else if part.item.kind === "voice"}
                              {@const item = part.item}
                              {@const playback =
                                voicePlayback[item.id] ?? EMPTY_VOICE_PLAYBACK}
                              <div
                                class="companion-voice"
                                role="region"
                                aria-label={t("voice.player")}
                              >
                                {#if voiceUrls[item.id]}
                                  <audio
                                    class="companion-audio"
                                    preload="metadata"
                                    src={voiceUrls[item.id]}
                                    aria-hidden="true"
                                    tabindex="-1"
                                    use:trackVoiceAudio={item.id}
                                  ></audio>
                                {/if}
                                <KonstaButton rounded tonal
                                  class="button button-tonal button-round companion-voice-control"
                                  aria-label={playback.playing
                                    ? t("voice.pause")
                                    : t("voice.play")}
                                  onClick={(event) =>
                                    void toggleVoice(item, event.currentTarget)}
                                >
                                  {#if playback.playing}<Pause
                                      size={18}
                                      fill="currentColor"
                                      aria-hidden="true"
                                    />{:else}<Play
                                      size={18}
                                      fill="currentColor"
                                      aria-hidden="true"
                                    />{/if}
                                </KonstaButton>
                                <div class="companion-voice-player">
                                  <div class="companion-voice-waveform">
                                    {#each voiceWaveform(item.id) as height, index}<span
                                        class:played={(index + 1) /
                                          VOICE_WAVEFORM_BAR_COUNT <=
                                          voiceProgress(playback)}
                                        style={`--voice-bar:${height}%`}
                                        aria-hidden="true"
                                      ></span>{/each}
                                    <input
                                      class="companion-voice-seek"
                                      type="range"
                                      min="0"
                                      max={playback.duration || 0}
                                      step="0.1"
                                      value={playback.current}
                                      disabled={!hasVoiceDuration(playback)}
                                      aria-label={t("voice.progress")}
                                      aria-valuetext={hasVoiceDuration(playback)
                                        ? `${formatVoiceSeconds(playback.current)} / ${formatVoiceSeconds(playback.duration, "ceil")}`
                                        : t("loading.progress")}
                                      on:input={(event) =>
                                        seekVoice(event, item.id)}
                                    />
                                  </div>
                                  <div class="companion-voice-meta">
                                    {#if voiceErrors[item.id]}<span role="alert"
                                        >{t("voice.playFailed")}</span
                                      >{:else if voiceTimestamp(playback)}<span
                                        role="timer"
                                        aria-live="off"
                                        >{voiceTimestamp(playback)}</span
                                      >{:else}<span role="status"
                                        >{t("loading.progress")}</span
                                      >{/if}
                                  </div>
                                </div>
                              </div>
                            {/if}
                          {/if}{/snippet}
                        {#snippet messageMetadata()}
                          {#if unit.failed && partIndex === parts.length - 1}<button
                              class="companion-meta companion-failed-action"
                              aria-label={t("messages.failedActions")}
                              data-testid={`failed-${unit.id}`}
                              on:click={(event) =>
                                showFailedMenu(unit.id, event.currentTarget)}
                              ><CircleAlert size={12} aria-hidden="true" />
                              {t("delivery.failed")}</button
                            >{/if}
                          {#if unit.pendingLabel}<div
                              class="companion-meta"
                              role="status"
                            >
                              {unit.pendingLabel}
                            </div>{/if}
                        {/snippet}
                        {#snippet messageSource()}
                          {#if partIndex === 0}
                            {#if unit.keet}<div
                                class="companion-keet-source"
                                data-testid={`keet-source-${unit.id}`}
                              >
                                <span class="badge"
                                  >Keet {unit.keet.channel === "dm"
                                    ? "DM"
                                    : "Group"}</span
                                ><span
                                  >{unit.keet.senderLabel} · {unit.keet
                                    .destination}</span
                                >
                              </div>
                            {:else if unit.matrix}<div
                                class="companion-matrix-source"
                                role="group"
                                aria-label="Matrix"
                                data-testid={`matrix-source-${unit.id}`}
                              >
                                <span class="badge">Matrix</span>
                                <span class="companion-matrix-sender"
                                  >{unit.matrix.senderDisplayName ||
                                    unit.matrix.senderId}</span
                                >
                                {#if unit.matrix.senderDisplayName}<span
                                    class="companion-matrix-sender-id"
                                    >{unit.matrix.senderId}</span
                                  >{/if}
                                <span class="companion-matrix-room"
                                  >{unit.matrix.roomId}</span
                                >
                              </div>
                            {:else if unit.post}<div
                                class="companion-post-source"
                                role="group"
                                aria-label={unit.post.platform === "qq"
                                  ? "QQ"
                                  : "Matrix"}
                                data-testid={`post-source-${unit.id}`}
                              >
                                <span class="badge"
                                  >{`${unit.post.platform === "qq" ? "QQ" : "Matrix"} ${t(unit.post.conversationType === "group" ? "source.group" : "source.direct")}`}</span
                                >
                                <span class="companion-post-sender"
                                  >{unit.post.senderDisplayName ??
                                    unit.post.senderId}</span
                                >
                                <span class="companion-post-conversation"
                                  >{unit.post.conversationName ??
                                    unit.post.conversationId}</span
                                >
                              </div>
                            {:else if unit.alarm}<span
                                class="badge companion-alarm-source"
                                >{t("alarm.source")}</span
                              >{/if}
                          {/if}
                        {/snippet}
                        {#snippet messageContent()}
                          <div class="companion-message-body">
                            {#if part.kind === "images"}
                              {@render imageContent()}
                            {:else}
                              {@render textContent()}
                            {/if}
                          </div>
                        {/snippet}
                        {#snippet messageBody()}
                          {#if konstaTheme === "ios" && part.kind === "item" && part.item.kind === "ui"}
                            <div class="companion-structured-surface">
                              {@render messageContent()}
                            </div>
                          {:else if konstaTheme === "ios" && part.kind !== "images"}
                            <KonstaGlass class="companion-glass-bubble" highlight={false}>
                              {@render messageContent()}
                            </KonstaGlass>
                          {:else}
                            {@render messageContent()}
                          {/if}
                        {/snippet}
                        <KonstaMessage
                          header={partIndex === 0 &&
                          (unit.keet || unit.matrix || unit.post || unit.alarm)
                            ? messageSource
                            : undefined}
                          footer={(independentMessage ||
                            partIndex === parts.length - 1) &&
                          (unit.failed || unit.pendingLabel)
                            ? messageMetadata
                            : undefined}
                          type={unit.side === "incoming" ? "received" : "sent"}
                          colors={konstaTheme === "ios" ? {
                            messageSent: "text-inherit",
                            bubbleSentIos: "companion-glass-message-surface",
                            bubbleReceivedIos: "companion-glass-message-surface",
                          } : undefined}
                          text={messageBody}
                          class={`companion-row ${independentMessage || partIndex === 0 ? "companion-message-first" : ""} ${independentMessage || partIndex === parts.length - 1 ? "companion-message-last" : ""} ${unit.side === "incoming" ? "incoming" : "outgoing"} ${unit.keet ? "companion-row-keet" : ""} ${unit.matrix ? "companion-row-matrix" : ""} ${unit.post ? "companion-row-post" : ""} ${unit.alarm ? "companion-row-alarm" : ""} ${unit.pending ? "companion-row-pending" : ""} ${part.kind === "images" ? "companion-image-message" : ""} ${unit.items.some((item) => item.kind === "file") ? "companion-has-files" : ""}`}
                          data-pending={unit.pending || undefined}
                          data-testid={partIndex === 0
                            ? unitTestId(unit)
                            : undefined}
                        />
                      {/each}
                    {/if}
                  {/each}
                  {#if typingVisible}
                    <div
                      class="companion-row incoming message-typing"
                      data-testid="companion-typing-indicator"
                      role="status"
                      aria-label={t("status.namedTyping", {
                        name: identity.companionName,
                      })}
                    ><div class="message-typing-indicator" aria-hidden="true"><div></div><div></div><div></div></div>{#if waitingCopy}<span>{t(waitingCopy)}</span>{/if}</div>
                  {/if}
                </Messages>
              </div>
            </div>
            {#if !wasNearBottom && displayedProjection.items.length > 0}
              <div class="konsta-chat companion-return-latest">
                <KonstaFab
                  component="button"
                  type="button"
                  aria-label={t("messages.latest")}
                  title={t("messages.latest")}
                  onClick={() => {
                    composerInput?.blur();
                    returnToLatest();
                  }}>
                  {#snippet icon()}<ChevronDown size={22} aria-hidden="true" />{/snippet}
                </KonstaFab>
              </div>
            {/if}
          </div>
          {#if detailOpen}{@render detailPage()}{/if}
        {/if}
{#snippet detailPage()}
    <div class="companion-detail-background" aria-hidden="true">
      {#if backgrounds}
        {#key backgroundVersion}
          <img class="companion-background-landscape" src={backgrounds.landscape} alt="" />
          <img class="companion-background-portrait" src={backgrounds.portrait} alt="" />
        {/key}
      {/if}
    </div>
    <KonstaGlass component="div" highlight={false}
      id="companion-drawer-panel"
      class="konsta-chat companion-history-scroll"
      role="region"
      aria-labelledby={drawerTab === "history"
        ? "companion-history-tab"
        : drawerTab === "diary"
          ? "companion-diary-tab"
          : drawerTab === "images"
            ? "companion-images-tab"
            : "companion-alarms-tab"}
    >
      {#if drawerTab === "alarms"}
        <AlarmDrawer
          {t}
          {locale}
          {alarms}
          loading={alarmsLoading}
          error={alarmsError}
          refresh={() => void openAlarms()}
        />
      {:else if drawerTab === "images"}
        <section class="companion-gallery" aria-label={t("drawer.images")}>
          {#if galleryError}<div class="companion-history-state" role="alert">
              <p>{t("gallery.failed")}</p>
              <KonstaButton small tonal
                type="button"
                class="button button-tonal button-small"
                onClick={() => void openGallery()}>{t("retry")}</KonstaButton
              >
            </div>
          {:else if galleryLoading && !galleryImages.length}<p
              class="companion-history-state"
              role="status"
            >
              {t("loading")}
            </p>
          {:else if !galleryImages.length}<p class="companion-history-state">
              {t("gallery.empty")}
            </p>
          {:else}<div class="companion-gallery-toolbar">
              <span>{t("gallery.grouping")}</span>
              <div
                class="segmented companion-gallery-grouping flex gap-1"
                role="group"
                aria-label={t("gallery.grouping")}
              >
                <KonstaButton small tonal
                  type="button"
                  class={`button button-tonal button-small ${galleryGrouping === "day" ? "button-active" : ""}`}
                  aria-pressed={galleryGrouping === "day"}
                  onClick={() => (galleryGrouping = "day")}
                  >{t("gallery.group.day")}</KonstaButton
                ><KonstaButton small tonal
                  type="button"
                  class={`button button-tonal button-small ${galleryGrouping === "week" ? "button-active" : ""}`}
                  aria-pressed={galleryGrouping === "week"}
                  onClick={() => (galleryGrouping = "week")}
                  >{t("gallery.group.week")}</KonstaButton
                >
              </div>
            </div>
            <Gallery
              rows={galleryRowsValue}
              unavailableLabel={t("gallery.unavailable")}
              hasMore={!!galleryCursor && !galleryError}
              loading={galleryLoading}
              loadMore={() => openGallery(true)}
              pick={(image) =>
                openLightbox({
                  id: image.id,
                  alt: image.filename,
                  previewUrl: image.originalUrl,
                })}
            />{#if galleryLoading}<p
                class="companion-history-state"
                role="status"
              >
                {t("loading")}
              </p>{/if}{/if}
        </section>
      {:else if drawerTab === "diary"}
        <section class="companion-diary">
          {#if diarySelected && !diaryEntry}<KonstaButton small tonal
              type="button"
              class="button button-tonal button-small"
              onClick={backToDiary}>← {t("diary.back")}</KonstaButton
            >{/if}
          {#if diaryEntry}
            <KonstaButton small tonal
              type="button"
              class="button button-tonal button-small companion-diary-back"
              onClick={backToDiary}>← {t("diary.back")}</KonstaButton
            >
            <KonstaGlass component="article" highlight={false} class="companion-diary-page">
              <time datetime={diaryEntry.name.slice(0, -3)}
                >{diaryEntry.name.slice(0, -3)}</time
              >
              <Markdown text={diaryEntry.text} />
            </KonstaGlass>
          {:else if diaryLoading}
            <p class="companion-history-state" role="status">{t("loading")}</p>
          {:else if diaryMissing}<p
              class="companion-history-state"
              role="alert"
            >
              {t("diary.missing")}
            </p>
          {:else if diaryTooLarge}
            <p class="companion-history-state" role="alert">
              {t("diary.tooLarge")}
            </p>
          {:else if diaryError}
            <div class="companion-history-state" role="alert">
              <p>{t("diary.failed")}</p>
              <KonstaButton small tonal
                type="button"
                class="button button-tonal button-small"
                onClick={() =>
                  diarySelected
                    ? void openDiaryEntry(diarySelected)
                    : void openDiary()}>{t("retry")}</KonstaButton
              >
            </div>
          {:else if !diaryEntries.length}
            <p class="companion-history-state">{t("diary.empty")}</p>
          {:else}
            <div class="list companion-diary-list">
              {#each diaryEntries as entry}
                <KonstaButton tonal
                  type="button"
                  class="button button-tonal companion-diary-list-entry"
                  onClick={() => selectDiaryEntry(entry)}
                >
                  <time datetime={entry.slice(0, -3)}>{entry.slice(0, -3)}</time
                  >
                  <span aria-hidden="true">›</span>
                </KonstaButton>
              {/each}
            </div>
            {#if diaryCursor}<KonstaButton tonal
                type="button"
                class="button button-tonal"
                onClick={() => void openDiary(true)}
                >{t("history.earlier")}</KonstaButton
              >{/if}
          {/if}
        </section>
      {:else}
        <section
          class="companion-history-current"
          aria-labelledby="companion-history-current-title"
        >
          <h3 id="companion-history-current-title">{t("history.current")}</h3>
          <dl class="companion-history-current-list">
            <dt>{t("affinity.label")}</dt>
            <dd>
              {identity.affinity === undefined
                ? t("loading")
                : `${identity.affinity} · ${identity.affinityStage}`}
            </dd>
            <dt>{t("history.signature")}</dt>
            <dd>{identity.signature || t("signature.empty")}</dd>
          </dl>
        </section>

        <section
          class="companion-history-list"
          aria-labelledby="companion-history-list-title"
        >
          <h3 id="companion-history-list-title">{t("history.list")}</h3>
          {#if history.status === "loading"}
            <div class="companion-history-state" role="status">
              <Preloader class="preloader  " aria-hidden="true" />
              <span>{t("history.loading")}</span>
            </div>
          {:else if history.status === "error"}
            <div class="companion-history-state" role="alert">
              <p>{t("history.failed")}</p>
              <KonstaButton small tonal
                type="button"
                class="button button-tonal button-small"
                onClick={() => actions.retryHistory?.()}
                >{t("history.retry")}</KonstaButton
              >
            </div>
          {:else if history.records.length === 0}
            <p class="companion-history-state">{t("history.empty")}</p>
          {:else}
            <div class="companion-history-entries">
              {#each history.records as record, index (`${record.at}:${index}`)}
                {@const changes = changesForHistoryRecord(index)}
                <KonstaGlass component="article" highlight={false} class="companion-history-entry">
                  <time datetime={record.at}
                    >{formatHistoryDate(record.at, locale)}</time
                  >
                  {#if record.changes.seed}
                    <p class="companion-history-initial">
                      {t("history.initial")}
                    </p>
                  {:else if changes.length === 0}
                    <p class="companion-history-initial">
                      {t("history.initial")}
                    </p>
                  {:else}
                    <ul>
                      {#each changes as change}
                        <li>
                          <strong
                            >{historyDimensionLabel(change.dimension)}</strong
                          >
                          <div class="companion-history-values">
                            <span
                              >{historyValueLabel(
                                change.dimension,
                                change.after,
                              )}</span
                            >{#if change.dimension === "affinity" && change.delta}<strong
                                class="companion-history-growth"
                                >{change.delta > 0
                                  ? "+"
                                  : ""}{change.delta}</strong
                              >{/if}
                          </div>
                          {#if change.reason}<p
                              class="companion-history-reason"
                            >
                              {t("history.reason")}: {change.reason}
                            </p>{/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </KonstaGlass>
              {/each}
            </div>
            {#if history.hasEarlier}
              <KonstaButton small tonal
                type="button"
                class="button button-tonal button-small companion-history-earlier"
                disabled={history.loadingEarlier}
                onClick={() => void loadEarlierHistory()}
                >{history.loadingEarlier
                  ? t("history.loadingNextPage")
                  : t("history.nextPage")}</KonstaButton
              >
            {/if}
          {/if}
        </section>
      {/if}
    </KonstaGlass>
{/snippet}

      </main>
    </div>
  </div>

  {#if searchOpen}<ConversationSearch
      {actions}
      {t}
      {locale}
      companionName={identity.companionName}
      onClose={closeSearch}
    />{/if}
  <div class="konsta-chat"><KonstaToast opened={!!toastText} position="center"><span role="status">{toastText}</span></KonstaToast></div>
  {#if lightbox && (photoLoading || photoError)}
    <div class="konsta-chat">
      <KonstaPopup opened onBackdropClick={closePhotoBrowser}>
        <div role="dialog" aria-modal="true" aria-label={lightbox.alt} class="p-4" use:photoFallbackFocus>
          <p role={photoError ? "alert" : "status"}>{photoError ? t("error.image") : t("loading")}</p>
          <KonstaButton onClick={closePhotoBrowser}>{t("close")}</KonstaButton>
        </div>
      </KonstaPopup>
    </div>
  {/if}
  <OverlayPresence active={!!$currentMessageMenu} exitMs={650} onExited={() => { displayedMessageMenu = undefined; }}>
    {#snippet children(opened)}
    {#if displayedMessageMenu}
    {#key displayedMessageMenu.id}
      <div class="konsta-chat companion-composer-overlay companion-message-overlay"
        class:compact={displayedMessageMenu.compact}
        class:companion-overlay-closing={!$currentMessageMenu} inert={!$currentMessageMenu}
        aria-hidden={!$currentMessageMenu} use:messageMenuPortal>
        <KonstaPopover
          class="companion-action-menu"
          {opened}
          target={displayedMessageMenu.target}
          backdrop={!displayedMessageMenu.compact}
          onBackdropClick={dismissMessageMenu}
        >
          <div
            role={displayedMessageMenu.compact ? "group" : "dialog"}
            aria-modal={displayedMessageMenu.compact ? undefined : "true"}
            aria-label={displayedMessageMenu.confirmation ?? displayedMessageMenu.actions.map((action) => action.text).join(", ")}
            data-testid="message-action-menu"
            class:companion-compact-actions={displayedMessageMenu.compact}
            use:messageMenuFocus={!!$currentMessageMenu && !displayedMessageMenu.compact}
            use:compactMessageMenu={!!$currentMessageMenu && !!displayedMessageMenu.compact}
          >
            {#if displayedMessageMenu.confirmation}
              <p class="companion-message-menu-label">{displayedMessageMenu.confirmation}</p>
            {/if}
            {#each displayedMessageMenu.actions as action}
              {#if displayedMessageMenu.compact}<KonstaButton clear small inline onClick={() => runMessageMenuAction(action)}>{action.text}</KonstaButton>
              {:else}<KonstaActionsButton onClick={() => runMessageMenuAction(action)}>{action.text}</KonstaActionsButton>{/if}
            {/each}
            {#if !displayedMessageMenu.compact}<KonstaActionsButton bold onClick={dismissMessageMenu}>{displayedMessageMenu.cancelLabel}</KonstaActionsButton>{/if}
          </div>
        </KonstaPopover>
      </div>
    {/key}
    {/if}
    {/snippet}
  </OverlayPresence>
  <OverlayPresence active={contextMeterOpen && !!contextCapacity} exitMs={650}>
    {#snippet children(opened)}
    {#if contextCapacity}
    <div class="konsta-chat companion-composer-overlay" class:companion-overlay-closing={!contextMeterOpen}
      inert={!contextMeterOpen} aria-hidden={!contextMeterOpen}>
      <KonstaPopover {opened} target={contextMeterButton} onBackdropClick={() => closeContextMeter()}>
        <div id="companion-context-popover" class="companion-context-popover" role="dialog" aria-labelledby="companion-context-popover-title" tabindex={-1} use:contextMenuFocus={contextMeterOpen}>
          <p id="companion-context-popover-title" class="companion-context-summary" aria-label={t("context.label")}>
            {formatTokenCount(contextCapacity.usedTokens)} / {formatTokenCount(contextCapacity.contextWindow)} ({contextCapacity.percentage}%)
          </p>
        </div>
      </KonstaPopover>
    </div>
    {/if}
    {/snippet}
  </OverlayPresence>
  <OverlayPresence active={attachmentOpen} exitMs={450}>
    {#snippet children(opened)}
    <div class="konsta-chat companion-composer-overlay" class:companion-overlay-closing={!attachmentOpen}
      inert={!attachmentOpen} aria-hidden={!attachmentOpen}>
      <KonstaActions {opened} onBackdropClick={closeComposerMenu}>
        <div role="dialog" aria-modal="true" aria-label={t("attachment.open")} data-testid="attachment-menu" use:composerMenuFocus={attachmentOpen}>
          <KonstaActionsGroup>
            <KonstaActionsButton disabled={!imageLimits} onClick={() => chooseAttachment("camera")}>{t("attachment.camera")}</KonstaActionsButton>
            <KonstaActionsButton disabled={!imageLimits} onClick={() => chooseAttachment("photos")}>{t("attachment.photos")}</KonstaActionsButton>
            <KonstaActionsButton disabled={!fileLimits} onClick={() => chooseAttachment("files")}>{t("attachment.files")}</KonstaActionsButton>
          </KonstaActionsGroup>
          <KonstaActionsGroup>
            <KonstaActionsButton bold onClick={closeComposerMenu}>{t("actions.cancel")}</KonstaActionsButton>
          </KonstaActionsGroup>
        </div>
      </KonstaActions>
    </div>
    {/snippet}
  </OverlayPresence>
  <OverlayPresence active={stickerOpen && !!stickerClient && !!actions.sendSticker} exitMs={450}>
    {#snippet children(opened)}
    {#if stickerClient && actions.sendSticker}
    <div class="konsta-chat companion-composer-overlay" class:companion-overlay-closing={!stickerOpen}
      inert={!stickerOpen} aria-hidden={!stickerOpen}>
      <KonstaSheet class="companion-sticker-sheet" {opened} onBackdropClick={closeComposerMenu}>
        <div role="dialog" aria-modal="true" aria-label={t("stickers.open")} use:composerMenuFocus={stickerOpen}>
          <div class="companion-sticker-sheet-header">
            <strong>{t("stickers.open")}</strong>
            <KonstaButton type="button" clear onClick={closeComposerMenu} aria-label={t("actions.cancel")}><X size={20} aria-hidden="true" /></KonstaButton>
          </div>
          {#key stickerPanelVersion}
            <StickerPanel client={stickerClient} {t} send={actions.sendSticker} favoritesRevision={stickerFavoritesRevision} canSend={projection.canSubmit !== false} />
          {/key}
        </div>
      </KonstaSheet>
    </div>
    {/if}
    {/snippet}
  </OverlayPresence>
</Page>

<KonstaGlass component="section" highlight={false} id="companion-preferences-panel" class="konsta-chat settings-screen" hidden={!preferencesOpen} aria-label={t("preferences.open")}>
  <div class="settings-container">
    <button bind:this={preferencesBack} type="button" class="settings-back" aria-label={t("settings.back")} on:click={closePreferences}>
      <ArrowLeft size={22} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <h1>{preferencesTab === "home" ? t("preferences.open") : preferencesTab === "appearance" ? t("preferences.theme") : preferencesTab === "models" ? t("models.title") : t("settings.outputTitle")}</h1>
    <div hidden={preferencesTab !== "home"}>
      <List strong inset>
      <ListItem link linkComponent="button" contentClass="w-full text-left" linkProps={{ type: "button" }} title={t("preferences.theme")} onClick={() => openPreferencesTab("appearance")}>
        {#snippet media()}<Palette size={22} aria-hidden="true" />{/snippet}
      </ListItem>
      {#if modelSettingsSupported}
        <ListItem link linkComponent="button" contentClass="w-full text-left" linkProps={{ type: "button" }} title={t("models.title")} onClick={() => openPreferencesTab("models")}>
          {#snippet media()}<Cpu size={22} aria-hidden="true" />{/snippet}
        </ListItem>
      {/if}
      {#if voiceOutputSettingsSupported}
        <ListItem link linkComponent="button" contentClass="w-full text-left" linkProps={{ type: "button" }} title={t("settings.outputTitle")} onClick={() => openPreferencesTab("voice-output")}>
          {#snippet media()}<Volume2 size={22} aria-hidden="true" />{/snippet}
        </ListItem>
      {/if}
      </List>
    </div>
    <div class="settings-detail" hidden={preferencesTab !== "appearance"}>
      <List strong inset>
        <ListItem groupTitle title={t("preferences.uiStyle")} />
        {#each [["ios", "preferences.iosStyle"], ["material", "preferences.materialStyle"]] as option}
          <li><Radio class="w-full gap-3 px-4 py-3" name="companion-ui-theme" value={option[0]} checked={konstaTheme === option[0]}
            onChange={() => setUiTheme(option[0] as UiTheme)}>{t(option[1] as CompanionLocaleKey)}</Radio></li>
        {/each}
        <ListItem groupTitle title={t("settings.theme")} />
        {#each [["light", "preferences.light"], ["dark", "preferences.dark"], ["system", "preferences.system"]] as option}
          <li><Radio class="w-full gap-3 px-4 py-3" name="companion-appearance" value={option[0]} checked={appearance === option[0]}
            onChange={() => onAppearanceChange(option[0] as CompanionAppearance)}>{t(option[1] as CompanionLocaleKey)}</Radio></li>
        {/each}
        <ListItem groupTitle title={t("preferences.language")} />
        {#each [["zh", "中文"], ["en", "English"]] as option}
          <li><Radio class="w-full gap-3 px-4 py-3" name="companion-language" value={option[0]} checked={locale === option[0]}
            onChange={() => onLanguageChange(option[0] as CompanionLanguage)}>{option[1]}</Radio></li>
        {/each}
      </List>
      <BackgroundSettings {t} open={preferencesOpen} {refreshBackgrounds} />
    </div>
    <div class="settings-detail" hidden={preferencesTab !== "models"}>
      <List strong inset>
        {#if sessionId}
          {#key sessionId}
            <ModelSettings {t} {sessionId} open={preferencesOpen} busy={projection.running || continuity.lifecycle?.status === "running"}
              onSupportChange={(supported) => setPreferencesSupport("models", supported)} />
          {/key}
        {/if}
      </List>
    </div>
    <div class="settings-detail" hidden={preferencesTab !== "voice-output"}>
      <VoiceOutputSettings {t} open={preferencesOpen} active={preferencesTab === "voice-output"}
        onSupportChange={(supported) => setPreferencesSupport("voice-output", supported)} />
    </div>
  </div>
</KonstaGlass>
</KonstaProvider>

<div class="companion-sr-only" aria-live="assertive">
  {typeof liveAnnouncement === "string"
    ? liveAnnouncement
    : t(liveAnnouncement.key, liveAnnouncement.params)}
</div>
