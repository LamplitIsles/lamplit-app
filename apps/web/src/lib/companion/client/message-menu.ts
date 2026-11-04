import { captureReadingFocus } from "./reading-focus.ts";
import { f7 } from "framework7-svelte";
let closeCurrent: (() => void) | undefined;

export function messageMenuOpen() {
  return !!closeCurrent;
}
export function dismissMessageMenu() {
  closeCurrent?.();
}

export function messageMenu(
  target: HTMLElement,
  actions: { text: string; run(): void | Promise<void>; disabled?: boolean }[],
  cancelLabel: string,
  confirmation?: string,
  preferSheet = false,
) {
  closeCurrent?.();
  document.getSelection()?.removeAllRanges();
  const returnFocus = captureReadingFocus(document);
  const modal = f7.actions.create({
    cssClass: "companion-action-menu",
    convertToPopover: true,
    forceToPopover: !preferSheet,
    targetEl: target,
    closeOnEscape: true,
    buttons: [
      ...(confirmation ? [{ text: confirmation, label: true }] : []),
      ...actions.map((action) => ({
        text: action.text,
        disabled: action.disabled,
        onClick: () => {
          void action.run();
        },
      })),
      { text: cancelLabel, strong: true },
    ],
    on: {
      opened() {
        const root = modal.$el[0] as HTMLElement;
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute(
          "aria-label",
          confirmation ?? actions.map((action) => action.text).join(", "),
        );
        const buttons = [
          ...root.querySelectorAll<HTMLElement>(
            ".list-button:not(.disabled), .item-link:not(.disabled), .actions-button:not(.disabled)",
          ),
        ];
        for (const disabled of root.querySelectorAll<HTMLElement>(
          ".list-button.disabled, .item-link.disabled, .actions-button.disabled",
        )) {
          disabled.setAttribute("role", "button");
          disabled.setAttribute("aria-disabled", "true");
        }
        for (const button of buttons) {
          button.setAttribute("role", "button");
          button.tabIndex = 0;
          button.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              button.click();
            }
            if (event.key === "Tab") {
              event.preventDefault();
              const index = buttons.indexOf(button);
              buttons[
                (index + (event.shiftKey ? buttons.length - 1 : 1)) %
                  buttons.length
              ].focus();
            }
          });
        }
        buttons[0]?.focus({ preventScroll: true });
      },
      closed() {
        if (closeCurrent === close) closeCurrent = undefined;
        if (returnFocus?.isConnected)
          returnFocus.focus({ preventScroll: true });
        queueMicrotask(() => modal.destroy());
      },
    },
  });
  const close = () => modal.close(false);
  closeCurrent = close;
  modal.open();
}
