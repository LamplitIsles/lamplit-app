import { createRouter } from "sv-router";
import AppShell from "./AppShell.svelte";
import RouteMarker from "./RouteMarker.svelte";

// Preserve existing bookmarks and provide an in-app back path for settings
// opened directly. This runs once before sv-router claims the history entries.
if (location.pathname !== "/consent") {
  const oldSettings: Record<string, string> = {
    "#settings": "/settings",
    "#settings/appearance": "/settings/appearance",
    "#settings/models": "/settings/models",
    "#settings/voice": "/settings",
    "#settings/voice-output": "/settings/voice-output",
  };
  const path =
    oldSettings[location.hash] ??
    (location.hash.startsWith("#/") ? location.hash.slice(1) : "");
  const state = history.state?._userState ?? history.state;
  const isSettings = path === "/settings" || path.startsWith("/settings/");
  if (isSettings && !state?.companionSettings) {
    const base = location.pathname + location.search;
    history.replaceState(
      { ...state, companionSettings: false },
      "",
      `${base}#/chat`,
    );
    history.pushState(
      { ...state, companionSettings: true },
      "",
      `${base}#/settings`,
    );
    if (path !== "/settings")
      history.pushState(
        { ...state, companionSettings: true },
        "",
        `${base}#${path}`,
      );
  } else if (oldSettings[location.hash]) {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}#${path}`,
    );
  }
  // A legacy bookmark can also be opened as a same-document hash navigation.
  // Normalize before sv-router handles popstate, so its shared shell survives.
  const normalizeLegacy = () => {
    let target = oldSettings[location.hash];
    if (!target && location.hash.startsWith("#/diary/")) {
      try {
        decodeURIComponent(location.hash.slice("#/diary/".length));
      } catch {
        target = "/diary";
      }
    }
    if (!target) return false;
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}#${target}`,
    );
    return true;
  };
  normalizeLegacy();
  window.addEventListener("popstate", normalizeLegacy, { capture: true });
  const normalizeHashChange = () => {
    if (normalizeLegacy())
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: history.state }),
      );
  };
  window.addEventListener("hashchange", normalizeHashChange);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("popstate", normalizeLegacy, { capture: true });
    window.removeEventListener("hashchange", normalizeHashChange);
  });
}

export const { navigate, route } = createRouter(
  {
    layout: AppShell,
    "/": RouteMarker,
    "/chat": RouteMarker,
    "/memories": RouteMarker,
    "/diary": RouteMarker,
    "/diary/:entry": RouteMarker,
    "/album": RouteMarker,
    "/wake": RouteMarker,
    "/settings": RouteMarker,
    "/settings/appearance": RouteMarker,
    "/settings/models": RouteMarker,
    "/settings/voice-output": RouteMarker,
    "*": RouteMarker,
  },
  { base: location.pathname === "/consent" ? undefined : "#" },
);
