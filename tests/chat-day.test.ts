import { describe, expect, test } from "bun:test";
import {
  chatDay,
  chatTimeHeadings,
  chatDayLabel,
  nextChatDayBoundary,
} from "../apps/web/src/lib/companion/client/chat-day.ts";
import type { TimelineMessageUnit } from "../apps/web/src/lib/companion/projection.ts";

const t = (key: string) =>
  ({ "chatDay.today": "Today", "chatDay.yesterday": "Yesterday" })[key] ?? key;
const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
) => new Date(year, month - 1, day, hour, minute).getTime();
const unit = (id: string, time?: number): TimelineMessageUnit => ({
  id,
  sourceId: id,
  side: "incoming",
  time,
  items: [{ kind: "text", id, messageKey: id, side: "incoming", text: id }],
});

describe("chat day headings", () => {
  test("uses local 04:00 and formats relative and older dates", () => {
    const now = at(2026, 11, 8, 3, 59);
    expect(chatDayLabel(chatDay(at(2026, 11, 8, 3, 59))!, now, "en", t)).toBe(
      "Today",
    );
    expect(chatDayLabel(chatDay(at(2026, 11, 7, 3, 59))!, now, "en", t)).toBe(
      "Yesterday",
    );
    expect(chatDayLabel(chatDay(at(2026, 10, 30, 10))!, now, "en", t)).toBe(
      "30 October",
    );
    expect(chatDayLabel(chatDay(at(2025, 10, 30, 10))!, now, "en", t)).toBe(
      "30 October 2025",
    );
    expect(chatDayLabel(chatDay(at(2026, 10, 30, 10))!, now, "zh", t)).toBe(
      "10月30日",
    );
    expect(
      chatDayLabel(chatDay(at(2026, 11, 8, 4))!, at(2026, 11, 8, 4), "en", t),
    ).toBe("Today");
    expect(
      chatDayLabel(
        chatDay(at(2026, 11, 8, 3, 59))!,
        at(2026, 11, 8, 4),
        "en",
        t,
      ),
    ).toBe("Yesterday");
    expect(nextChatDayBoundary(now)).toBe(at(2026, 11, 8, 4));
    expect(nextChatDayBoundary(at(2026, 11, 8, 4))).toBe(at(2026, 11, 9, 4));
    // These local dates also cross the spring and autumn DST transitions where applicable.
    expect(nextChatDayBoundary(at(2026, 3, 8, 0))).toBe(at(2026, 3, 8, 4));
    expect(nextChatDayBoundary(at(2026, 11, 1, 0))).toBe(at(2026, 11, 1, 4));
    expect(chatDay(NaN)).toBeUndefined();
  });

  test("groups adjacent messages at the 15 minute boundary", () => {
    const now = at(2026, 11, 8, 10);
    const first = unit("first", at(2026, 11, 8, 8));
    const next = unit("next", at(2026, 11, 8, 8, 14));
    const later = unit("later", at(2026, 11, 8, 8, 29));
    const headings = chatTimeHeadings([first, next, later], [], now, "en", t);
    expect(Object.keys(headings)).toEqual(["first", "later"]);
    expect(headings.first).toEqual({
      label: "08:00",
      datetime: new Date(first.time!).toISOString(),
    });
    expect(headings.later.label).toBe("08:29");
    // An out-of-order timestamp is still an interval, never silently merged.
    expect(
      Object.keys(chatTimeHeadings([later, first], [], now, "en", t)),
    ).toEqual(["later", "first"]);
  });

  test("formats yesterday and older dates under the existing 04:00 chat-day rule", () => {
    const now = at(2026, 11, 8, 10);
    const previous = unit("previous", at(2026, 11, 7, 22));
    const earlier = unit("earlier", at(2026, 10, 30, 10, 15));
    const nextYear = unit("nextYear", at(2025, 10, 30, 10));
    expect(
      chatTimeHeadings([previous], [], now, "zh", (key) =>
        key === "chatDay.yesterday" ? "昨天" : key,
      ).previous.label,
    ).toBe("昨天 22:00");
    expect(chatTimeHeadings([earlier], [], now, "en", t).earlier.label).toBe(
      "30 October 10:15",
    );
    expect(chatTimeHeadings([nextYear], [], now, "en", t).nextYear.label).toBe(
      "30 October 2025 10:00",
    );
    const late = unit("late", at(2026, 11, 8, 3, 59));
    const fresh = unit("fresh", at(2026, 11, 8, 4));
    expect(
      Object.keys(chatTimeHeadings([late, fresh], [], now, "en", t)),
    ).toEqual(["late"]);
    expect(chatTimeHeadings([late], [], now, "en", t).late.label).toBe(
      "Yesterday 03:59",
    );
  });

  test("recomputes after history prepend and separates gaps or unknown times", () => {
    const now = at(2026, 11, 8, 10);
    const old = unit("old", at(2026, 11, 8, 8));
    const late = unit("late", at(2026, 11, 8, 8, 5));
    const fresh = unit("fresh", at(2026, 11, 8, 8, 25));
    expect(
      Object.keys(chatTimeHeadings([late, fresh], [], now, "en", t)),
    ).toEqual(["late", "fresh"]);
    expect(
      Object.keys(chatTimeHeadings([old, late, fresh], [], now, "en", t)),
    ).toEqual(["old", "fresh"]);
    expect(
      Object.keys(
        chatTimeHeadings(
          [old, late, fresh],
          [{ id: 1, afterId: "old", beforeId: "late", status: "pending" }],
          now,
          "en",
          t,
        ),
      ),
    ).toEqual(["old", "late", "fresh"]);
    expect(
      Object.keys(
        chatTimeHeadings([old, unit("unknown"), late], [], now, "en", t),
      ),
    ).toEqual(["old", "late"]);
  });
});
