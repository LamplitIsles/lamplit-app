import { describe, expect, test } from "bun:test";
import {
  chatDay,
  chatDayHeadings,
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

  test("recomputes boundaries after history prepend and across a gap", () => {
    const now = at(2026, 11, 8, 10);
    const old = unit("old", at(2026, 11, 7, 22));
    const late = unit("late", at(2026, 11, 8, 3, 59));
    const fresh = unit("fresh", at(2026, 11, 8, 4));
    expect(chatDayHeadings([late, fresh], [], now, "en", t)).toEqual({
      late: "Yesterday",
      fresh: "Today",
    });
    expect(chatDayHeadings([old, late, fresh], [], now, "en", t)).toEqual({
      old: "Yesterday",
      fresh: "Today",
    });
    expect(
      chatDayHeadings(
        [old, late, fresh],
        [{ id: 1, afterId: "old", beforeId: "late", status: "pending" }],
        now,
        "en",
        t,
      ),
    ).toEqual({ old: "Yesterday", late: "Yesterday", fresh: "Today" });
    expect(
      chatDayHeadings([old, unit("unknown"), late], [], now, "en", t),
    ).toEqual({ old: "Yesterday", late: "Yesterday" });
  });
});
