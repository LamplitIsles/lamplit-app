import type {
  TimelineMessageUnit,
  CompanionProjection,
} from "../projection.js";
import type { CompanionTranslate } from "./locale.js";
import { formatMessageTime, messageTimeDateTime } from "../message-time.js";

const GROUP_INTERVAL_MS = 15 * 60 * 1000;

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

/** Separators follow adjacent loaded messages; gaps and unknown times break a group. */
export function chatTimeHeadings(
  units: readonly TimelineMessageUnit[],
  gaps: CompanionProjection["historyGaps"],
  now: number,
  locale: string,
  t: CompanionTranslate,
): Record<string, { label: string; datetime: string }> {
  const headings: Record<string, { label: string; datetime: string }> =
    Object.create(null);
  const gapStarts = new Set((gaps ?? []).map((gap) => gap.beforeId));
  let previous: number | undefined;
  const today = chatDay(now);
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
    const time = unit.time!;
    if (
      previous === undefined ||
      Math.abs(time - previous) >= GROUP_INTERVAL_MS
    ) {
      const date =
        today && day.getTime() === today.getTime()
          ? ""
          : chatDayLabel(day, now, locale, t);
      headings[unit.id] = {
        label: [date, formatMessageTime(time)].filter(Boolean).join(" "),
        datetime: messageTimeDateTime(time),
      };
    }
    previous = time;
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
