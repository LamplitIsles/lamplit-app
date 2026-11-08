import { writable } from "svelte/store";
import { captureReadingFocus } from "./reading-focus.ts";

interface MenuAction {
  text: string;
  run(): void | Promise<void>;
}
interface MenuState {
  id: number;
  target: HTMLElement;
  actions: MenuAction[];
  cancelLabel: string;
  confirmation?: string;
  compact?: boolean;
  preserveSelection?: boolean;
  selectedText?: string;
  autoFocus?: boolean;
}

export const currentMessageMenu = writable<MenuState | undefined>();
let current: MenuState | undefined;
let returnFocus: HTMLElement | undefined;
let nextId = 0;

export function messageMenuOpen(): boolean {
  return !!current;
}

export function dismissMessageMenu(): void {
  if (!current) return;
  const dismissed = current;
  current = undefined;
  currentMessageMenu.set(undefined);
  if (dismissed.preserveSelection) {
    const selection = document.getSelection();
    if (
      selection?.anchorNode &&
      dismissed.target.contains(selection.anchorNode)
    )
      selection.removeAllRanges();
  }
  const target = returnFocus;
  returnFocus = undefined;
  queueMicrotask(() => {
    if (
      !current &&
      (!dismissed.compact || dismissed.autoFocus) &&
      target?.isConnected
    )
      target.focus({ preventScroll: true });
  });
}

export function messageMenu(
  target: HTMLElement,
  actions: MenuAction[],
  cancelLabel: string,
  confirmation?: string,
  options: {
    compact?: boolean;
    preserveSelection?: boolean;
    selectedText?: string;
    autoFocus?: boolean;
  } = {},
): void {
  if (!current) returnFocus = captureReadingFocus(document);
  if (!options.preserveSelection) document.getSelection()?.removeAllRanges();
  current = {
    id: ++nextId,
    target,
    actions,
    cancelLabel,
    confirmation,
    ...options,
  };
  currentMessageMenu.set(current);
}

export function runMessageMenuAction(action: MenuAction): void {
  const opened = current;
  if (!opened) return;
  try {
    const result = action.run();
    if (current === opened) dismissMessageMenu();
    void result;
  } catch (error) {
    if (current === opened) dismissMessageMenu();
    throw error;
  }
}
