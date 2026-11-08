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
  current = undefined;
  currentMessageMenu.set(undefined);
  const target = returnFocus;
  returnFocus = undefined;
  queueMicrotask(() => {
    if (!current && target?.isConnected) target.focus({ preventScroll: true });
  });
}

export function messageMenu(
  target: HTMLElement,
  actions: MenuAction[],
  cancelLabel: string,
  confirmation?: string,
): void {
  if (!current) returnFocus = captureReadingFocus(document);
  document.getSelection()?.removeAllRanges();
  current = { id: ++nextId, target, actions, cancelLabel, confirmation };
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
