import * as messages from "../../paraglide/messages.js";
import type { CompanionLanguage } from "./preferences.js";

// Sticker messages are generated from the source catalogs alongside all other
// messages by the normal application build.
export type CompanionLocaleKey = keyof typeof messages | `stickers.${"open" | "search" | "favorites" | "empty" | "more" | "error" | "sendFailed" | "favorite" | "unfavorite" | "favoriteFailed" | "favoriteImage" | "favoriteSaved" | "preview"}`;
export type CompanionTranslate = (
  key: CompanionLocaleKey,
  params?: Record<string, string | number>,
) => string;
export interface CompanionMessage {
  key: CompanionLocaleKey;
  params?: Record<string, string | number>;
}

/** Thin generated-message boundary for injected and dynamic Companion text. */
export function companionTranslate(
  locale: CompanionLanguage,
): CompanionTranslate {
  return (key, params) => {
    const message = (messages as Record<string, unknown>)[key] as
      | ((
          inputs?: Record<string, string | number>,
          options?: { locale: CompanionLanguage },
        ) => string)
      | undefined;
    return message?.(params, { locale }) ?? key;
  };
}

export const english = companionTranslate("en");
