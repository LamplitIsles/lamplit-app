import { chromium, expect } from "@playwright/test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { resolve } from "node:path";

const fixture = fixtureBackend();
let sessionId = "notifications",
  messages = [],
  before = "older",
  active = "turn";
const message = (id, role = "agent", text = "private reply") => ({
  id,
  role,
  text,
  createdAt: Date.now(),
  operationId: null,
  turnId: "turn",
});
const host = await createChatHost({
  ...fixture.backend,
  async read() {
    return {
      ...(await fixture.backend.read()),
      sessionId,
      messages,
      before,
      activeTurnId: active,
    };
  },
  async history() {
    return {
      messages: [message("old-history", "agent", "old archived reply")],
      before: null,
    };
  },
});
const channels = new Map();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/appearance")
      return Response.json({
        companionName: "Displayed Mica",
        userName: "Human",
      });
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    return staticAssets(
      resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build"),
      path,
    );
  },
  websocket: {
    open(ws) {
      channels.set(
        ws,
        host.connect(ws, async () => true),
      );
    },
    message(ws, raw) {
      void channels.get(ws).receive(String(raw));
    },
    close(ws) {
      channels.get(ws)?.close();
      channels.delete(ws);
    },
  },
});
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  // Every context owns its fake permission and attention state; never ask the OS.
  for (const mode of [
    "default",
    "reject",
    "throw",
    "granted",
    "denied",
    "unavailable",
    "insecure",
  ]) {
    messages = [message("baseline")];
    sessionId = "notifications";
    before = "older";
    await host.refresh();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript((mode) => {
      window.notificationFake = {
        requests: 0,
        notices: [],
        focused: true,
        hidden: false,
        focusCalls: 0,
        fail: false,
      };
      const state = window.notificationFake;
      Object.defineProperty(document, "hasFocus", {
        value: () => state.focused,
      });
      Object.defineProperty(document, "visibilityState", {
        get: () => (state.hidden ? "hidden" : "visible"),
      });
      window.focus = () => {
        state.focusCalls++;
      };
      if (mode === "insecure")
        Object.defineProperty(window, "isSecureContext", { value: false });
      if (mode === "unavailable") {
        delete window.Notification;
        return;
      }
      window.Notification = class {
        static permission = ["granted", "denied"].includes(mode)
          ? mode
          : "default";
        static requestPermission() {
          state.requests++;
          state.trusted = navigator.userActivation.isActive;
          if (mode === "throw") throw new Error("permission throw");
          return mode === "reject"
            ? Promise.reject(new Error("permission rejected"))
            : Promise.resolve("default");
        }
        constructor(title, options) {
          if (state.fail) throw new Error("delivery failed");
          this.title = title;
          this.body = options.body;
          this.closed = false;
          state.notices.push(this);
        }
        close() {
          this.closed = true;
          this.onclose?.();
        }
      };
    }, mode);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await expect(
      page.getByText("private reply", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".companion-name")).toHaveText("Displayed Mica");
    const state = () =>
      page.evaluate(() => ({
        requests: notificationFake.requests,
        notices: notificationFake.notices.map((n) => ({
          title: n.title,
          body: n.body,
          closed: n.closed,
        })),
      }));
    expect(await state()).toEqual({ requests: 0, notices: [] });
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect((await state()).requests).toBe(0);
    await page.locator("#companion-textarea").click();
    const shouldRequest = ["default", "reject", "throw"].includes(mode);
    expect((await state()).requests).toBe(shouldRequest ? 1 : 0);
    if (shouldRequest)
      expect(await page.evaluate(() => notificationFake.trusted)).toBe(true);
    await page.locator("#companion-textarea").click();
    expect((await state()).requests).toBe(shouldRequest ? 1 : 0);
    const refresh = async (next) => {
      messages = next;
      await host.refresh();
      // A new marker in each live snapshot acknowledges observation without sleeps.
      const marker = message(
        `marker-${crypto.randomUUID()}`,
        "notice",
        `ack-${crypto.randomUUID()}`,
      );
      messages = [...messages, marker];
      await host.refresh();
      await expect(page.getByText(marker.text, { exact: true })).toHaveCount(1);
    };
    if (mode !== "default") {
      await page.evaluate(() => {
        notificationFake.focused = false;
      });
      await refresh([...messages, message(`new-${mode}`)]);
      expect((await state()).notices).toHaveLength(mode === "granted" ? 1 : 0);
      expect(errors).toEqual([]);
      await context.close();
      continue;
    }

    // Unauthorized and foreground messages are consumed, never replayed on blur/grant.
    await page.evaluate(() => {
      notificationFake.focused = false;
    });
    await refresh([...messages, message("unauthorized")]);
    await page.evaluate(() => {
      Notification.permission = "granted";
      notificationFake.focused = true;
    });
    await refresh([...messages, message("foreground")]);
    await page.evaluate(() => {
      notificationFake.focused = false;
    });
    await refresh(messages);
    expect((await state()).notices).toHaveLength(0);
    // Visible-unfocused delivery: two complete messages in one still-active turn.
    await refresh([
      ...messages,
      message("one"),
      message("two"),
      message("user", "user"),
      message("notice", "notice"),
      {
        ...message("reminder", "user"),
        source: { kind: "reminder", reminderId: "fixture" },
      },
    ]);
    expect((await state()).notices).toEqual([
      { title: "Displayed Mica", body: "有一条新消息", closed: false },
      { title: "Displayed Mica", body: "有一条新消息", closed: false },
    ]);
    active = null;
    await refresh([
      ...messages,
      message("failed", "notice", "turn failed/stopped"),
    ]);
    expect((await state()).notices).toHaveLength(2);
    // Eviction and repeated/reconnected snapshots must retain deduplication.
    const retained = messages;
    await refresh([]);
    await refresh(retained);
    for (const ws of channels.keys()) ws.close();
    await expect(page.locator("#companion-textarea")).toBeEnabled();
    await expect.poll(() => channels.size).toBe(1);
    await refresh(messages);
    expect((await state()).notices).toHaveLength(2);
    await page.getByRole("button", { name: "查看更早的消息" }).click();
    await expect(
      page.getByText("old archived reply", { exact: true }),
    ).toHaveCount(1);
    expect((await state()).notices).toHaveLength(2);
    // Changed session starts a silent baseline; hidden counts even if focused.
    sessionId = "replacement";
    await refresh([message("session-baseline")]);
    expect((await state()).notices).toHaveLength(2);
    await page.evaluate(() => {
      notificationFake.focused = true;
      notificationFake.hidden = true;
    });
    await refresh([...messages, message("hidden")]);
    expect((await state()).notices).toHaveLength(3);
    await page.evaluate(() => notificationFake.notices[0].onclick());
    expect(await page.evaluate(() => notificationFake.focusCalls)).toBe(1);
    expect((await state()).notices[0].closed).toBe(true);
    await page.evaluate(() => {
      notificationFake.fail = true;
    });
    await refresh([...messages, message("construction-error")]);
    await page.evaluate(() => {
      notificationFake.fail = false;
    });
    await refresh(messages);
    expect((await state()).notices).toHaveLength(3);
    // Reload allows another first-click attempt and creates a new silent baseline.
    await page.evaluate(() =>
      localStorage.setItem("her.companion.language", "en"),
    );
    await page.reload();
    await expect(page.locator("#companion-textarea")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await state()).toEqual({ requests: 0, notices: [] });
    await page.locator("#companion-textarea").click();
    expect((await state()).requests).toBe(1);
    await page.evaluate(() => {
      Notification.permission = "granted";
      notificationFake.hidden = true;
    });
    await refresh([...messages, message("english")]);
    expect((await state()).notices).toEqual([
      {
        title: "Displayed Mica",
        body: "You have a new message",
        closed: false,
      },
    ]);
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Native notification fake acceptance passed: trusted permission, live baselines, per-message delivery, attention, identity/localization, history, reconnect, eviction, session change and errors. OS display unverified.",
  );
} finally {
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.stop(true);
}
