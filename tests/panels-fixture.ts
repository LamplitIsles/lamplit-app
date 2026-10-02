import type {
  PanelBackend,
  RelationshipHistory,
  Reminder,
} from "../packages/contracts/src/index.ts";
export function panelsFixture() {
  const failures = new Set<keyof PanelBackend>();
  const empty = new Set<keyof PanelBackend>();
  const calls: string[] = [];
  const delays = new Map<keyof PanelBackend, Promise<void>>();
  const cursors = new Map<
    string,
    { sessionId: string; method: string; offset: number }
  >();
  const state = {
    mood: "bright" as const,
    note: "一起看灯火",
    affinity: 65,
    signature: "今晚也有光",
  };
  const records: RelationshipHistory["records"] = Array.from(
    { length: 25 },
    (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 2, 12, 0) - i * 60000).toISOString(),
      state: { ...state, affinity: 65 - i },
      changes: {
        affinity: {
          delta: 1,
          value: 65 - i,
          reason: `一起走过第 ${25 - i} 段路`,
        },
      },
    }),
  );
  const dates = Array.from(
    { length: 35 },
    (_, i) =>
      new Date(Date.UTC(2026, 9, 2) - i * 86400000).toISOString().slice(0, 10) +
      ".md",
  );
  const images = Array.from({ length: 35 }, (_, i) => ({
    id: `image-${String(35 - i).padStart(2, "0")}`,
    filename: `灯火-${35 - i}.png`,
    createdAt: Date.UTC(2026, 9, 2) - i * 3600000,
    origin: (["human", "agent", "historical", "unknown"] as const)[i % 4]!,
    available: i !== 1,
    previewUrl: i === 1 ? null : `/api/fixture-images/${35 - i}/preview.png`,
    originalUrl: i === 1 ? null : `/api/fixture-images/${35 - i}/original.png`,
  }));
  const reminders: Reminder[] = [
    {
      id: "once",
      title: "晚间散步",
      message: "带上围巾",
      nextAt: Date.UTC(2026, 9, 3),
      schedule: { kind: "once", at: Date.UTC(2026, 9, 3) },
    },
    {
      id: "interval",
      message: "休息一下",
      nextAt: Date.UTC(2026, 9, 3),
      schedule: {
        kind: "interval",
        everySeconds: 90,
        anchor: Date.UTC(2026, 9, 2),
      },
    },
    {
      id: "daily",
      message: "喝水",
      nextAt: Date.UTC(2026, 9, 3),
      schedule: {
        kind: "daily",
        hour: 9,
        minute: 30,
        timeZone: "Asia/Shanghai",
      },
    },
    {
      id: "weekly",
      message: "周日看灯",
      nextAt: Date.UTC(2026, 9, 4),
      schedule: {
        kind: "weekly",
        hour: 20,
        minute: 0,
        timeZone: "Asia/Shanghai",
        weekday: 0,
      },
    },
  ];
  async function before(method: keyof PanelBackend) {
    calls.push(method);
    await delays.get(method);
    if (failures.has(method)) throw new Error("Fixture failure");
  }
  function page(
    method: string,
    sessionId: string,
    cursor: string | null,
    count: number,
    limit: number,
  ) {
    const previous = cursor ? cursors.get(cursor) : undefined;
    if (
      cursor &&
      (!previous ||
        previous.sessionId !== sessionId ||
        previous.method !== method)
    )
      throw new Error("Invalid cursor");
    const offset = previous?.offset ?? 0;
    let nextCursor: string | null = null;
    if (offset + limit < count) {
      nextCursor = crypto.randomUUID();
      cursors.set(nextCursor, { sessionId, method, offset: offset + limit });
    }
    return { offset, nextCursor };
  }
  const backend: PanelBackend = {
    async relationship() {
      await before("relationship");
      return { scope: "fixture-relationship", current: state };
    },
    async relationshipHistory(input) {
      await before("relationshipHistory");
      const data = empty.has("relationshipHistory") ? [] : records;
      const { offset, nextCursor } = page(
        "relationshipHistory",
        input.sessionId,
        input.cursor,
        data.length,
        20,
      );
      return {
        scope: "fixture-relationship",
        records: data.slice(offset, offset + 20),
        nextCursor,
        predecessor: data[offset + 20] ?? null,
      };
    },
    async diaryList(input) {
      await before("diaryList");
      const data = empty.has("diaryList") ? [] : dates;
      const { offset, nextCursor } = page(
        "diaryList",
        input.sessionId,
        input.cursor,
        data.length,
        30,
      );
      return { entries: data.slice(offset, offset + 30), nextCursor };
    },
    async diaryRead(input) {
      await before("diaryRead");
      if (input.name === dates[1])
        return { status: "missing", name: input.name };
      if (input.name === dates[2])
        return { status: "too-large", name: input.name };
      return {
        status: "found",
        name: input.name,
        text: `# 灯火日记\n\n今天一起走过小岛。\n\n[看看海](https://example.com/diary)`,
      };
    },
    async album(input) {
      await before("album");
      const data = empty.has("album") ? [] : images;
      const { offset, nextCursor } = page(
        "album",
        input.sessionId,
        input.cursor,
        data.length,
        30,
      );
      return { images: data.slice(offset, offset + 30), nextCursor };
    },
    async reminders() {
      await before("reminders");
      return { reminders: empty.has("reminders") ? [] : reminders };
    },
  };
  return {
    backend,
    failures,
    empty,
    delays,
    calls,
    dates,
    images,
    records,
    reminders,
  };
}
export const fixtureImage = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAIAAABAJy5dAAABM0lEQVR4nM3OzUrDUBCG4bkO94K4EZEipZQS0zTGNI1Jmv5YrVarorfkBXkB3oxLF4EjNPHMlzIOB57lzMdLJ17mFDq9yJ1CZ37hFOoMp06h86B0CnVHM3Hfn2914C/1wrmsxpoK8k79y4UgS02FXaBBtBTEBrEL5F3dCGKD2AXy45UgNohdoGB8K4gNYhcoTO4EsUHsAkWTtSA2iF2gOL2XZalB3im5fhDXWAP+UpptnEJZ/viXg+OjiuVGHBXF0w7TYdRv/g+V022l3mGYGwVk6TDm5bMaKGg5e7H4+pjsp3ENCjrs+qxWKZYdLKg3AvEp3AIW1I9aaU7BfrGgwXgPvyltvrAgL1WDBfm5GiwoKNVgQeFCDRYUrdRgQfFaDRaUbNRgQelWDRaUvarBgop3NT+e7i4f/0qiDgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
