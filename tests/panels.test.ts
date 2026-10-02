import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { fixtureBackend } from "./fixture.ts";
import {
  validate,
  PanelReadSchema,
  DiaryReadSchema,
  RelationshipHistorySchema,
  AlbumPageSchema,
  RemindersSchema,
  validatePanelResult,
} from "../packages/contracts/src/index.ts";
import { companionHistoryChanges } from "../apps/web/src/lib/companion/relationship-history.ts";

test("bounded panel payloads, UTF-8 diary bytes, safe image paths and native schedules", () => {
  const fixture = fixtureBackend().panels;
  expect(() =>
    validate(PanelReadSchema, { sessionId: "s", cursor: 12 }),
  ).toThrow();
  for (const name of [
    "../secret.md",
    "2026-13-01.md",
    "2026-10-02.txt",
    "memory/2026-10-02.md",
  ])
    expect(() => validate(DiaryReadSchema, { sessionId: "s", name })).toThrow();
  expect(() =>
    validate(RelationshipHistorySchema, {
      scope: "s",
      records: Array(21).fill(fixture.records[0]),
      nextCursor: null,
      predecessor: null,
    }),
  ).toThrow();
  expect(() =>
    validate(AlbumPageSchema, { images: fixture.images, nextCursor: null }),
  ).toThrow();
  expect(() =>
    validate(RemindersSchema, {
      reminders: Array(101).fill(fixture.reminders[0]),
    }),
  ).toThrow();
  const nativeInterval = {
    reminders: [
      {
        ...fixture.reminders[1],
        schedule: {
          kind: "interval" as const,
          everySeconds: 60,
          anchor: -315619200000,
        },
      },
    ],
  };
  expect(validatePanelResult("reminders", nativeInterval)).toEqual(
    nativeInterval,
  );
  for (const anchor of [-8640000000000001, 8640000000000001])
    expect(() =>
      validatePanelResult("reminders", {
        reminders: [
          {
            ...nativeInterval.reminders[0],
            schedule: {
              ...nativeInterval.reminders[0]!.schedule,
              anchor,
            },
          },
        ],
      }),
    ).toThrow();
  expect(() =>
    validatePanelResult("reminders", {
      reminders: [{ ...nativeInterval.reminders[0], nextAt: -1 }],
    }),
  ).toThrow();
  const entry = {
    status: "found" as const,
    name: "2026-10-02.md",
    text: "é".repeat(65536),
  };
  expect(validatePanelResult("diaryRead", entry)).toEqual(entry);
  expect(() =>
    validatePanelResult("diaryRead", { ...entry, text: entry.text + "a" }),
  ).toThrow();
  const image = fixture.images[0]!;
  for (const previewUrl of [
    "https://foreign.invalid/image.png",
    "//foreign.invalid/image.png",
    "/api/../secret",
    "/api/%2e%2e/secret",
    "/api/a\\evil",
    "/api/a#token",
  ])
    expect(() =>
      validatePanelResult("album", {
        images: [{ ...image, previewUrl }],
        nextCursor: null,
      }),
    ).toThrow();
  expect(() =>
    validatePanelResult("album", {
      images: [{ ...image, originalUrl: null }],
      nextCursor: null,
    }),
  ).toThrow();
  expect(() =>
    validatePanelResult("reminders", {
      reminders: [
        {
          ...fixture.reminders[2],
          schedule: {
            kind: "daily",
            hour: 9,
            minute: 0,
            timeZone: "invalid-zone",
          },
        },
      ],
    }),
  ).toThrow();
  expect(
    companionHistoryChanges(fixture.records[19]!, fixture.records[20]!)[0]
      ?.delta,
  ).toBe(1);
  expect(
    companionHistoryChanges(fixture.records[20]!, fixture.records[19]!)[0]
      ?.delta,
  ).toBe(-1);
});

test("public panel reads use authorized shared WebSocket, scoped cursors and recover without breaking chat", async () => {
  const fixture = fixtureBackend();
  const errors: unknown[] = [];
  const host = await createChatHost(fixture.backend, (error) =>
    errors.push(error),
  );
  let authorized = true;
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(ws, async () => authorized),
        );
      },
      message(ws, raw) {
        void channels.get(ws)!.receive(String(raw));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {},
  );
  const input = { sessionId: "fixture-session", cursor: null };
  try {
    expect(
      (await client.relationship({ sessionId: input.sessionId })).current
        .affinity,
    ).toBe(65);
    const history = await client.relationshipHistory(input);
    expect(history.records).toHaveLength(20);
    expect(history.predecessor).toEqual(fixture.panels.records[20]);
    const older = await client.relationshipHistory({
      ...input,
      cursor: history.nextCursor,
    });
    expect(older.records).toHaveLength(5);
    expect(older.nextCursor).toBeNull();
    const album = await client.album(input);
    const olderImages = await client.album({
      ...input,
      cursor: album.nextCursor,
    });
    expect(
      new Set([...album.images, ...olderImages.images].map((image) => image.id))
        .size,
    ).toBe(35);
    await expect(
      client.album({
        ...input,
        sessionId: "other-session",
        cursor: album.nextCursor,
      }),
    ).rejects.toThrow();
    await expect(
      client.diaryList({ ...input, cursor: album.nextCursor }),
    ).rejects.toThrow();
    const diary = await client.diaryList(input);
    expect(diary.entries).toHaveLength(30);
    expect(
      (await client.diaryList({ ...input, cursor: diary.nextCursor })).entries,
    ).toHaveLength(5);
    expect(
      (
        await client.diaryRead({
          sessionId: input.sessionId,
          name: fixture.panels.dates[1]!,
        })
      ).status,
    ).toBe("missing");
    expect(
      (
        await client.diaryRead({
          sessionId: input.sessionId,
          name: fixture.panels.dates[2]!,
        })
      ).status,
    ).toBe("too-large");
    expect(
      (await client.reminders({ sessionId: input.sessionId })).reminders.map(
        (reminder) => reminder.schedule.kind,
      ),
    ).toEqual(["once", "interval", "daily", "weekly"]);
    fixture.panels.failures.add("diaryList");
    await expect(client.diaryList(input)).rejects.toThrow();
    expect(
      (
        await client.submit({
          operationId: crypto.randomUUID(),
          text: "面板失败后仍能聊天",
        })
      ).state,
    ).toBe("consumed");
    fixture.panels.failures.clear();
    expect((await client.diaryList(input)).entries.length).toBe(30);
    fixture.panels.empty.add("album");
    expect((await client.album(input)).images).toEqual([]);
    authorized = false;
    await expect(
      client.reminders({ sessionId: input.sessionId }),
    ).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    client.close();
    host.close();
    for (const ws of channels.keys()) (ws as { terminate(): void }).terminate();
    server.stop(true);
  }
});
