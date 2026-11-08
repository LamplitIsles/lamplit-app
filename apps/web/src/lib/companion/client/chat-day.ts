import type {
  TimelineMessageUnit,
  CompanionProjection,
} from "../projection.js";
import type { CompanionTranslate } from "./locale.js";

/** The local calendar date on which this chat day began. */
export function chatDay(value: number): Date | undefined {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return undefined;
  return new Date(
    instant.getFullYear(),
    instant.getMonth(),
    instant.getDate() - (instant.getHours() < 4 ? 1 : 0),
    12,
  );
}

export function chatDayLabel(
  day: Date,
  now: number,
  locale: string,
  t: CompanionTranslate,
): string {
  const today = chatDay(now);
  if (!today) return "";
  const serial = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = (serial(today) - serial(day)) / 86_400_000;
  if (difference === 0) return t("chatDay.today");
  if (difference === 1) return t("chatDay.yesterday");
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
    day: "numeric",
    month: "long",
    ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  }).format(day);
}

/** Headings are a view of loaded messages, never a change to message identity. */
export function chatDayHeadings(
  units: readonly TimelineMessageUnit[],
  gaps: CompanionProjection["historyGaps"],
  now: number,
  locale: string,
  t: CompanionTranslate,
): Record<string, string> {
  const headings: Record<string, string> = Object.create(null);
  const gapStarts = new Set((gaps ?? []).map((gap) => gap.beforeId));
  let previous: number | undefined;
  for (const unit of units) {
    if (unit.sourceId && gapStarts.has(unit.sourceId)) previous = undefined;
    if (
      unit.items[0]?.kind === "notice" ||
      unit.items[0]?.kind === "continuity"
    )
      continue;
    const day = unit.time === undefined ? undefined : chatDay(unit.time);
    if (!day) {
      previous = undefined;
      continue;
    }
    const key = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
    if (key !== previous) headings[unit.id] = chatDayLabel(day, now, locale, t);
    previous = key;
  }
  return headings;
}

/** Use calendar arithmetic so the next boundary remains 04:00 across DST. */
export function nextChatDayBoundary(now: number): number {
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}
