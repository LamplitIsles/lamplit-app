import type {
  SearchBackend,
  SearchReadResult,
} from "../packages/contracts/src/index.ts";
/** Deterministic archive facts; native hosts seed equivalent records, not this matcher. */
export function searchFixture() {
  const records = Array.from({ length: 23 }, (_, i) => ({
    id: `archive-${i}`,
    kind: i === 2 ? ("compaction" as const) : ("message" as const),
    sessionId: i === 22 ? "import-session" : "archive-session",
    sessionName: i === 22 ? "Imported branch" : "Archive",
    role:
      i === 2 ? undefined : i % 2 ? ("assistant" as const) : ("user" as const),
    createdAt: "2026-10-02T12:00:00Z",
    content:
      i === 2
        ? "灯塔 lighthouse archiveSummary3142"
        : i < 2
          ? "灯塔 lighthouse repeated"
          : `灯塔 lighthouse record ${i}${i === 22 ? " archiveImported3142" : ""}`,
  }));
  for (const record of records)
    record.content += " <img src=x onerror=alert(1)>";
  const failures = new Set<string>();
  const delays = new Map<string, Promise<void>>();
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let heldKey = "";
  const backend: SearchBackend = {
    async search({ query }) {
      calls.push(`search:${query}`);
      await delays.get(query);
      if (failures.has("search")) throw new Error("Fixture search failure");
      const hits = records
        .filter((r) => r.content.toLowerCase().includes(query.toLowerCase()))
        .map(({ content, ...r }) => ({
          ...r,
          snippet: content.replace(/灯塔/g, "<mark>灯塔</mark>"),
        }));
      return {
        hits: hits.slice(0, 20),
        estimatedTotalHits: null,
        limited: hits.length > 20,
      };
    },
    async searchRead({ id }): Promise<SearchReadResult> {
      calls.push(`read:${id}`);
      await delays.get(id);
      if (failures.has("searchRead")) throw new Error("Fixture read failure");
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Unknown record");
      return {
        record: { ...record },
        context: {
          targetSourceRecordIndex: 10,
          truncated: true,
          items: [
            {
              sourceRecordIndex: 3,
              kind: "message",
              role: "user",
              content:
                id === "archive-0"
                  ? "before original branch"
                  : "before imported branch",
            },
            {
              sourceRecordIndex: 10,
              kind: record.kind,
              role: record.role,
              content: record.content,
            },
            {
              sourceRecordIndex: 17,
              kind: "compaction",
              content: "nearby summary",
            },
          ],
        },
      };
    },
  };
  return {
    backend,
    records,
    failures,
    delays,
    calls,
    control(input: Record<string, unknown>) {
      switch (input.action) {
        case "reset":
          release?.();
          delays.clear();
          failures.clear();
          calls.length = 0;
          break;
        case "failure":
          if (input.enabled) failures.add(String(input.method));
          else failures.delete(String(input.method));
          break;
        case "hold":
          heldKey = String(input.key);
          delays.set(
            heldKey,
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          );
          break;
        case "release":
          delays.delete(heldKey);
          release?.();
          release = undefined;
          break;
        case "state":
          break;
        default:
          throw new Error("Unknown search control");
      }
      return { calls: [...calls] };
    },
  };
}
