/** The Companion owns overlay avoidance while mounted, otherwise native resize. */
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  boundingRect: Pick<DOMRect, "x" | "y" | "width" | "height">;
}

export function visibleViewport(
  node: HTMLElement,
  host: Window = window,
  onComposerModeChange: () => void = () => {},
): { destroy(): void } {
  const viewport = host.visualViewport;
  const keyboard = (
    host.navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }
  )?.virtualKeyboard;
  const previousOverlay = keyboard?.overlaysContent;
  let frame = 0;
  let restingHeight = host.innerHeight;
  let restingWidth = host.innerWidth;
  const keys = [
    "--companion-visible-height",
    "--companion-visible-top",
    "--companion-keyboard-space",
    "--companion-bottom-safe-area",
  ];
  const clear = () => keys.forEach((key) => node.style.removeProperty(key));
  const editing = () => {
    const active = host.document?.activeElement;
    return Boolean(
      active &&
      node.contains(active) &&
      active.matches(
        "textarea, input:not([type=file]), [contenteditable=true]",
      ),
    );
  };
  const setComposerMode = (keyboardOpen: boolean) => {
    const input = node.querySelector("#companion-textarea");
    const focused = input !== null && host.document?.activeElement === input;
    const coarsePointer = host.matchMedia?.("(pointer: coarse)").matches ?? false;
    const expanded = focused && (keyboardOpen || !coarsePointer);
    const keyboardVisible = focused && keyboardOpen;
    const changed =
      node.hasAttribute("data-composer-expanded") !== expanded ||
      node.hasAttribute("data-composer-keyboard-open") !== keyboardVisible;
    node.toggleAttribute("data-composer-expanded", expanded);
    node.toggleAttribute("data-composer-keyboard-open", keyboardVisible);
    if (changed) onComposerModeChange();
  };
  if (keyboard) keyboard.overlaysContent = true;
  const update = () => {
    frame = 0;
    clear();
    node.removeAttribute("data-keyboard-overlay");
    // Preserve browser zoom/panning; zoom is never evidence of a keyboard.
    if (viewport && viewport.scale !== 1) return;
    const focused = editing();
    if (!focused || host.innerWidth !== restingWidth) {
      restingHeight = host.innerHeight;
      restingWidth = host.innerWidth;
    }
    // Use the resting window shape so a keyboard-only height change cannot
    // select the other composition. A rotation changes width as well.
    node.setAttribute(
      "data-chat-orientation",
      restingWidth > restingHeight ? "landscape" : "portrait",
    );
    const height = viewport?.height ?? host.innerHeight;
    const covered = focused
      ? Math.max(0, restingHeight - height - (viewport?.offsetTop ?? 0))
      : 0;
    const coarsePointer = host.matchMedia?.("(pointer: coarse)").matches ?? false;
    // Some hosts expose VirtualKeyboard but still resize the visual viewport
    // without reporting keyboard bounds. Use that geometry when it happens.
    if (keyboard && (keyboard.boundingRect.height > 0 || covered < 80)) {
      node.setAttribute("data-keyboard-overlay", "");
      const rect = keyboard.boundingRect;
      const bounds = (
        node.querySelector(".companion-main") ?? node
      ).getBoundingClientRect();
      const headerBottom =
        node.querySelector(".companion-header")?.getBoundingClientRect()
          .bottom ?? 0;
      const bottom = rect.y + rect.height;
      const intersects =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x < bounds.right &&
        rect.x + rect.width > bounds.left &&
        rect.y < host.innerHeight &&
        bottom > headerBottom;
      const docked =
        intersects && bottom === host.innerHeight && rect.y >= headerBottom;
      setComposerMode(intersects || (coarsePointer && covered >= 80));
      // CSS env owns the docked case. A floating rectangle needs the space
      // below its top, not rect.height; a rectangle outside chat needs none.
      if (!docked && rect.height > 0) {
        const space = intersects
          ? Math.max(0, host.innerHeight - Math.max(headerBottom, rect.y))
          : 0;
        node.style.setProperty("--companion-keyboard-space", `${space}px`);
      }
      return;
    }
    // Native resizes-content already shrinks innerHeight; visualViewport is
    // an absolute available height, never an additional height subtraction.
    setComposerMode(coarsePointer && covered >= 80);
    node.style.setProperty(
      "--companion-bottom-safe-area",
      `max(0px, calc(var(--companion-system-safe-area) - ${covered}px))`,
    );
    if (viewport) {
      node.style.setProperty("--companion-visible-height", `${height}px`);
      node.style.setProperty(
        "--companion-visible-top",
        `${viewport.offsetTop}px`,
      );
    }
  };
  const schedule = () => {
    if (!frame) frame = host.requestAnimationFrame(update);
  };
  update();
  host.addEventListener("resize", schedule);
  host.document?.addEventListener("focusin", schedule);
  host.document?.addEventListener("focusout", schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  keyboard?.addEventListener("geometrychange", schedule);
  return {
    destroy() {
      host.removeEventListener("resize", schedule);
      host.document?.removeEventListener("focusin", schedule);
      host.document?.removeEventListener("focusout", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      keyboard?.removeEventListener("geometrychange", schedule);
      if (frame) host.cancelAnimationFrame(frame);
      if (keyboard) keyboard.overlaysContent = previousOverlay!;
      node.removeAttribute("data-keyboard-overlay");
      node.removeAttribute("data-composer-expanded");
      node.removeAttribute("data-composer-keyboard-open");
      node.removeAttribute("data-chat-orientation");
      clear();
    },
  };
}

/** Observe both content growth and the viewport shrinking around the composer. */
export function followTimelineResize(
  content: HTMLElement,
  timeline: HTMLElement,
  following: () => boolean,
  Observer: typeof ResizeObserver = ResizeObserver,
): { destroy(): void } {
  const observer = new Observer(() => {
    if (following()) timeline.scrollTop = timeline.scrollHeight;
    // When reading, leave scrollTop/browser anchoring alone. No layout change
    // is interpreted as an instruction to return to the latest message.
  });
  observer.observe(content);
  observer.observe(timeline);
  return { destroy: () => observer.disconnect() };
}
