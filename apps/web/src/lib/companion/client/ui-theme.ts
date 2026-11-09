import { writable } from "svelte/store";
import { readPreference, writePreference } from "./preferences.js";

export type UiTheme = "ios" | "material";
export const UI_THEME_STORAGE_KEY = "her.companion.ui-theme";

function parseTheme(value: unknown): UiTheme {
  return value === "material" ? "material" : "ios";
}

export const uiTheme = writable<UiTheme>(
  parseTheme(readPreference(UI_THEME_STORAGE_KEY)),
);

export function setUiTheme(theme: UiTheme): void {
  uiTheme.set(theme);
  writePreference(UI_THEME_STORAGE_KEY, theme);
}

export function watchUiTheme(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_THEME_STORAGE_KEY || event.key === null)
      uiTheme.set(parseTheme(readPreference(UI_THEME_STORAGE_KEY)));
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function applyUiTheme(theme: UiTheme): void {
  document.documentElement.classList.toggle("ios", theme === "ios");
  document.documentElement.classList.toggle("md", theme === "material");
}
