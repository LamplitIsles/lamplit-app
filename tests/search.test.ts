import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import {
  validateSearchInput,
  validateSearchResult,
  validateSearchReadResult,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
import { searchFixture } from "./search-fixture.ts";
import { textParts } from "../apps/web/src/lib/companion/client/conversation-search-highlight.ts";

test("archive schemas bound queries, cards and context without capping selected text", async () => {
  const fixture = searchFixture();
  expect(validateSearchInput({ query: " 灯塔 " })).toEqual({ query: "灯塔" });
  for (const query of ["", "   ", "a".repeat(501)])
    expect(() => validateSearchInput({ query })).toThrow();
  const result = await fixture.backend.search({ query: "灯塔" });
  expect(result.hits).toHaveLength(20);
  for (const extra of [{ cwd: "/private" }, { path: "/history/file" }])
    expect(() =>
      validateSearchResult({
        ...result,
        hits: [{ ...result.hits[0], ...extra }],
      }),
    ).toThrow();
  expect(() =>
    validateSearchResult({ ...result, hits: [...result.hits, result.hits[0]] }),
  ).toThrow();
  const read = await fixture.backend.searchRead({ id: "archive-0" });
  expect(
    validateSearchReadResult(
      { ...read, record: { ...read.record, content: "灯".repeat(150000) } },
      "archive-0",
    ).record.content.length,
  ).toBe(150000);
  expect(() => validateSearchReadResult(read, "archive-1")).toThrow();
  expect(() =>
    validateSearchReadResult(
      {
        ...read,
        context: {
          ...read.context,
          items: [{ sourceRecordIndex: 1, kind: "tool", content: "hidden" }],
        },
      },
      "archive-0",
    ),
  ).toThrow();
  expect(() =>
    validateSearchReadResult(
      {
        ...read,
        context: {
          ...read.context,
          items: [
            {
              sourceRecordIndex: 1,
              kind: "message",
              content: "a".repeat(12001),
            },
          ],
        },
      },
      "archive-0",
    ),
  ).toThrow();
  expect(
    textParts("lighthouse LIGHTHOUSE", "lighthouse").filter((p) => p.matched),
  ).toHaveLength(2);
});

test("structured snippet schema preserves text and rejects old or malformed segments", async () => {
  const result = await searchFixture().backend.search({ query: "灯塔" });
  const validateSnippet = (snippet: unknown) =>
    validateSearchResult({
      ...result,
      hits: [{ ...result.hits[0], snippet }],
    });
  const snippet = {
    segments: [
      {
        text: "<mark>literal</mark> `<img src=x>` 中文😀𠮷",
        highlighted: false,
      },
      { text: "灯塔😀", highlighted: true },
      { text: "", highlighted: false },
      { text: "邻接", highlighted: true },
    ],
  };
  expect(validateSnippet(snippet).hits[0]?.snippet).toBe(snippet);
  expect(validateSnippet({ segments: [] }).hits[0]?.snippet.segments).toEqual(
    [],
  );
  for (const invalid of [
    "<mark>灯塔</mark>",
    null,
    {},
    { segments: "text" },
    { segments: ["text"] },
    { segments: [{ text: "text" }] },
    { segments: [{ highlighted: true }] },
    { segments: [{ text: 1, highlighted: true }] },
    { segments: [{ text: "text", highlighted: "true" }] },
    { segments: [{ text: "text", highlighted: true, html: "text" }] },
    { segments: [], text: "duplicate" },
  ])
    expect(() => validateSnippet(invalid)).toThrow();
});

test("context budget counts Unicode code points across items at the exact native boundary", async () => {
  const read = await searchFixture().backend.searchRead({ id: "archive-0" });
  read.context.items = [
    { sourceRecordIndex: 10, kind: "message", content: "😀".repeat(12000) },
  ];
  expect(validateSearchReadResult(read, "archive-0")).toBe(read);
  read.context.items[0]!.content += "😀";
  expect(() => validateSearchReadResult(read, "archive-0")).toThrow();
  read.context.items = [
    { sourceRecordIndex: 3, kind: "message", content: "😀".repeat(6000) },
    { sourceRecordIndex: 10, kind: "message", content: "灯".repeat(6000) },
  ];
  expect(validateSearchReadResult(read, "archive-0")).toBe(read);
  read.context.items[1]!.content += "😀";
  expect(() => validateSearchReadResult(read, "archive-0")).toThrow();
});

test("shared search/read validate both boundaries; oversized UTF-8 result and failures leave chat usable", async () => {
  const fixture = fixtureBackend(),
    search = searchFixture();
  let oversized = false,
    longRead = false,
    invalidRequest = false,
    invalidBackend = false,
    invalidWire = false,
    legacyBackend = false,
    legacyWire = false,
    offline = false;
  const host = await createChatHost(
    {
      ...fixture.backend,
      ...search.backend,
      async searchRead(input) {
        const read = await search.backend.searchRead(input);
        if (longRead) read.record.content = "灯".repeat(150000);
        if (oversized) read.record.content = "灯".repeat(710000);
        return read;
      },
      async search(input) {
        const result = await search.backend.search(input);
        if (invalidBackend) Object.assign(result.hits[0]!, { cwd: "/private" });
        if (legacyBackend)
          Object.assign(result.hits[0]!, { snippet: "<mark>灯塔</mark>" });
        return result;
      },
    },
    () => {},
  );
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
          host.connect(
            {
              send(raw) {
                const frame = JSON.parse(raw);
                if (invalidWire && frame.result?.hits)
                  frame.result.hits[0].cwd = "/private";
                if (legacyWire && frame.result?.hits)
                  frame.result.hits[0].snippet = "<mark>灯塔</mark>";
                ws.send(JSON.stringify(frame));
              },
              close: (code, reason) => ws.close(code, reason),
            },
            async () => true,
          ),
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
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const send = socket.send.bind(socket);
  socket.send = (raw) => {
    const frame = JSON.parse(String(raw));
    if (invalidRequest && frame.call?.member === "search")
      frame.call.args = [{ query: " " }];
    send(JSON.stringify(frame));
  };
  const client = await openChat(
    socket,
    () => {},
    () => {
      offline = true;
    },
  );
  try {
    const cards = await client.search({ query: " 灯塔 " });
    expect(cards.estimatedTotalHits).toBeNull();
    expect(cards.limited).toBe(true);
    expect(cards.hits.map((h) => h.id).slice(0, 3)).toEqual([
      "archive-0",
      "archive-1",
      "archive-2",
    ]);
    expect(
      (await client.search({ query: "archiveSummary3142" })).hits[0]?.kind,
    ).toBe("compaction");
    expect(
      (await client.search({ query: "archiveImported3142" })).hits[0]
        ?.sessionId,
    ).toBe("import-session");
    const first = await client.searchRead({ id: "archive-0" }),
      second = await client.searchRead({ id: "archive-1" });
    expect(first.record.content).toBe(second.record.content);
    expect(first.context.items[0]?.content).toBe("before original branch");
    expect(second.context.items[0]?.content).toBe("before imported branch");
    longRead = true;
    expect(
      (await client.searchRead({ id: "archive-0" })).record.content.length,
    ).toBe(150000);
    longRead = false;
    const beforeInvalid = search.calls.length;
    invalidRequest = true;
    await expect(client.search({ query: "灯塔" })).rejects.toThrow();
    invalidRequest = false;
    expect(search.calls.length).toBe(beforeInvalid);
    oversized = true;
    await expect(client.searchRead({ id: "archive-0" })).rejects.toThrow();
    oversized = false;
    invalidBackend = true;
    await expect(client.search({ query: "灯塔" })).rejects.toThrow();
    invalidBackend = false;
    invalidWire = true;
    await expect(client.search({ query: "灯塔" })).rejects.toThrow();
    invalidWire = false;
    legacyBackend = true;
    await expect(client.search({ query: "灯塔" })).rejects.toThrow();
    legacyBackend = false;
    legacyWire = true;
    await expect(client.search({ query: "灯塔" })).rejects.toThrow();
    legacyWire = false;
    expect(
      (await client.search({ query: "灯塔" })).hits[0]?.snippet.segments[0],
    ).toEqual({ text: "灯塔", highlighted: true });
    const calls = search.calls.length;
    await expect(client.search({ query: " " })).rejects.toThrow();
    expect(search.calls.length).toBe(calls);
    await expect(
      client.searchRead({ id: "unknown-owner-record" }),
    ).rejects.toThrow();
    expect((await client.searchRead({ id: "archive-0" })).record.id).toBe(
      "archive-0",
    );
    expect(
      (
        await client.submit({
          operationId: crypto.randomUUID(),
          text: "chat after failed archive read",
        })
      ).state,
    ).toBe("submitted");
    expect(offline).toBe(false);
  } finally {
    client.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});
