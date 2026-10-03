import { expect, test } from "bun:test";
import { CompanionNotifications } from "../apps/web/src/lib/companion/client/notifications.ts";
import {
  capabilities,
  type ChatView,
} from "../packages/contracts/src/index.ts";

test("page teardown detaches permission and notice callbacks and rejects stale live views", () => {
  const clicks = new Set<(event: MouseEvent) => void>();
  let requests = 0,
    focusCalls = 0;
  const notices: FakeNotice[] = [];
  class FakeNotice {
    static permission = "granted";
    static requestPermission() {
      requests++;
      return Promise.resolve("default");
    }
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() {
      notices.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  const window = {
    isSecureContext: true,
    Notification: FakeNotice,
    focus: () => {
      focusCalls++;
    },
  } as unknown as Window & typeof globalThis;
  const document = {
    addEventListener: (_: string, click: (event: MouseEvent) => void) =>
      clicks.add(click),
    removeEventListener: (_: string, click: (event: MouseEvent) => void) =>
      clicks.delete(click),
    visibilityState: "hidden",
    hasFocus: () => false,
  } as unknown as Document;
  const label = () => ({ title: "Companion", body: "New message" });
  const view = (id: string): ChatView => ({
    version: 1,
    sessionId: "test-owned",
    name: "Companion",
    activeTurnId: null,
    contextUsage: { tokens: null, capacity: null },
    compaction: null,
    before: null,
    capabilities,
    recovery: [],
    messages: [
      {
        id,
        role: "agent",
        text: "private",
        createdAt: 1,
        operationId: null,
        turnId: null,
      },
    ],
  });
  const old = new CompanionNotifications(window, document, label);
  const staleClick = [...clicks][0]!;
  old.observe(view("baseline"));
  old.observe(view("new"));
  expect(notices).toHaveLength(1);
  const staleNoticeClick = notices[0]!.onclick!;
  old.close();
  expect(clicks.size).toBe(0);
  expect(notices[0]!.closed).toBe(true);
  expect(notices[0]!.onclick).toBeNull();
  const replacement = new CompanionNotifications(window, document, label);
  FakeNotice.permission = "default";
  staleClick({ isTrusted: true } as MouseEvent);
  staleNoticeClick();
  old.observe(view("stale"));
  expect(requests).toBe(0);
  expect(focusCalls).toBe(0);
  expect(notices).toHaveLength(1);
  [...clicks][0]!({ isTrusted: true } as MouseEvent);
  expect(requests).toBe(1);
  FakeNotice.permission = "granted";
  replacement.observe(view("replacement-baseline"));
  replacement.observe(view("replacement-new"));
  expect(notices).toHaveLength(2);
  replacement.close();
  expect(clicks.size).toBe(0);
});
