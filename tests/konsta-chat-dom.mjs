import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createUiTestHost } from "./ui-test-host.ts";
import { fixtureBackend } from "./fixture.ts";
const fixture = fixtureBackend();
await fixture.backend.submit({
  sessionId: "fixture-session",
  operationId: "fixture-op",
  text: "测试气泡",
});
await fixture.complete("收到啦");
const backend = {
  ...fixture.backend,
  async read() {
    const v = await fixture.backend.read();
    return {
      ...v,
      capabilities: {
        ...v.capabilities,
        files: {
          maxFilesPerMessage: 6,
          maxFileBytes: 8000000,
          maxMessageFileBytes: 24000000,
        },
      },
    };
  },
};
const errors = [];
const host = await createUiTestHost(backend, (error) => errors.push(error));
const win = new Window({
  url: "http://localhost/",
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
});
win.SyntaxError = SyntaxError;
win.addEventListener("error", (event) =>
  errors.push(event.error ?? event.message),
);
process.on("unhandledRejection", (error) => errors.push(error));
const nativeStyle = win.getComputedStyle.bind(win);
win.getComputedStyle = (el) =>
  new Proxy(nativeStyle(el), {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return value === undefined && typeof key === "string"
        ? target.getPropertyValue(key)
        : typeof value === "function"
          ? value.bind(target)
          : value;
    },
  });
for (const name of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "customElements",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "HTMLElement",
  "HTMLMediaElement",
  "HTMLVideoElement",
  "HTMLAudioElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Text",
  "Comment",
  "DocumentFragment",
  "Document",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "CompositionEvent",
  "DOMParser",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]) {
  if (name in win)
    Object.defineProperty(globalThis, name, {
      value:
        typeof win[name] === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "matchMedia",
        ].includes(name)
          ? win[name].bind(win)
          : win[name],
      configurable: true,
      writable: true,
    });
}
class FakeSocket extends win.EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.connection = host.connect(
      {
        send: (raw) =>
          queueMicrotask(() =>
            this.dispatchEvent(new win.MessageEvent("message", { data: raw })),
          ),
        close: () => this.close(),
      },
      async () => true,
    );
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new win.Event("open"));
    });
  }
  send(raw) {
    void this.connection.receive(raw);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.connection.close();
    this.dispatchEvent(new win.CloseEvent("close", { code: 1000 }));
  }
}
Object.defineProperty(globalThis, "WebSocket", {
  value: FakeSocket,
  configurable: true,
});
globalThis.fetch = async (url) => {
  const path = new URL(String(url), "http://localhost").pathname;
  if (path === "/api/chat/appearance")
    return Response.json({
      companionName: "Mica",
      userName: "You",
      companionAvatar: "/api/test/companion.png",
      userAvatar: "/api/test/user.png",
    });
  if (path === "/api/auth/status") return new Response(null, { status: 404 });
  return new Response(null, { status: 404 });
};
document.head.innerHTML =
  "<style>:root { --companion-color-accent: #ed7186; }</style>";
document.body.innerHTML = '<div id="app"></div>';
const html = await readFile("apps/web/build/index.html", "utf8");
const entry = html.match(/<script type="module" crossorigin src="([^"]+)/)?.[1];
assert.ok(entry, "Build the web app before running this test");
await import(pathToFileURL(resolve("apps/web/build", "." + entry)).href);
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 50));
  if (document.querySelector("#companion-textarea")) break;
}
assert.ok(document.querySelector("#companion-textarea"));
assert.equal(
  document.querySelectorAll(".companion-header-leading button").length,
  0,
);
assert.equal(
  document.querySelectorAll(".companion-header-actions button").length,
  3,
);
assert.equal(
  document.querySelectorAll(
    ".companion-header .companion-avatar, .companion-header .companion-name",
  ).length,
  0,
);
assert.equal(document.querySelectorAll(".companion-bottom-nav button").length, 5);
assert.equal(document.querySelector(".companion-microphone")?.disabled, true);
assert.ok(
  document.querySelector(".companion-microphone")?.getAttribute("aria-label"),
);
assert.equal(
  document.querySelector('[data-testid="companion-voice-unavailable-status"]'),
  null,
);
assert.doesNotMatch(
  document.body.textContent,
  /Microphone recording is unavailable in this environment/,
);
assert.equal(document.querySelectorAll(".k-message").length, 2);
assert.equal(document.querySelectorAll(".k-message.incoming").length, 1);
assert.equal(document.querySelectorAll(".k-message.outgoing").length, 1);
assert.equal(
  document.querySelectorAll(".k-message.outgoing .companion-chat-avatar").length,
  0,
);
assert.equal(
  document.querySelectorAll(".k-message.incoming .companion-chat-avatar").length,
  0,
);
for (let i = 0; i < 100; i++) {
  if (document.querySelector(".companion-identity-chip img"))
    break;
  await new Promise((r) => setTimeout(r, 20));
}
assert.equal(
  document
    .querySelector(".companion-identity-chip img")
    ?.getAttribute("src"),
  "/api/test/companion.png",
);
assert.equal(
  document.querySelectorAll(".k-message.outgoing .companion-chat-avatar").length,
  0,
);
assert.equal(
  document.querySelectorAll(
    ".k-message.message-sent, .k-message.message-received",
  ).length,
  0,
);
assert.equal(
  document.querySelectorAll(
    ".k-message .message-bubble, .k-message .message-text, .k-message .message-avatar",
  ).length,
  0,
);
assert.match(document.body.textContent, /测试气泡/);
assert.match(document.body.textContent, /收到啦/);
const textarea = document.querySelector("#companion-textarea");
textarea.value = "测试输入";
textarea.dispatchEvent(new win.Event("input", { bubbles: true }));
textarea.dispatchEvent(
  new win.CompositionEvent("compositionstart", { bubbles: true }),
);
textarea.dispatchEvent(
  new win.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  }),
);
await new Promise((r) => setTimeout(r, 100));
assert.equal(fixture.executions, 1, "Enter during composition must not submit");
assert.equal(textarea.value, "测试输入");
textarea.dispatchEvent(
  new win.CompositionEvent("compositionend", { bubbles: true }),
);
textarea.dispatchEvent(
  new win.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  }),
);
await new Promise((r) => setTimeout(r, 300));
assert.equal(fixture.executions, 2);
assert.equal(textarea.value, "");
assert.match(document.body.textContent, /测试输入/);
assert.ok(
  document.querySelector(
    '.companion-header-actions [data-testid="companion-stop"]',
  ),
);
assert.equal(document.querySelectorAll(".companion-header-actions button:not([disabled])").length, 3);
document.querySelector(".companion-attach")?.click();
await new Promise((r) => setTimeout(r, 100));
[...document.querySelectorAll('[data-testid="attachment-menu"] button')]
  .find((b) => b.textContent.trim() === "Upload file")
  ?.click();
await new Promise((r) => setTimeout(r, 100));
const fileInput = [...document.querySelectorAll("input[type=file]")].find(
  (x) => !x.accept && !x.hasAttribute("capture"),
);
assert.ok(fileInput);
Object.defineProperty(fileInput, "files", {
  configurable: true,
  value: [new win.File(["hello"], "file.txt", { type: "text/plain" })],
});
fileInput.dispatchEvent(new win.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
assert.match(document.body.textContent, /file\.txt/);
assert.equal(document.querySelectorAll("[data-testid=file-draft]").length, 1);
textarea.value = "保留的草稿";
textarea.dispatchEvent(new win.Event("input", { bubbles: true }));
document.querySelector("#companion-diary-tab").click();
await new Promise((r) => setTimeout(r, 100));
assert.equal(document.querySelector(".companion-compose-content").hidden, true);
assert.ok(document.querySelector("#companion-drawer-panel"));
document.querySelector(".companion-bottom-nav button").click();
await new Promise((r) => setTimeout(r, 100));
assert.equal(document.querySelector(".companion-compose-content").hidden, false);
assert.equal(textarea.value, "保留的草稿");
assert.equal(document.querySelectorAll("[data-testid=file-draft]").length, 1);
assert.equal(fixture.executions, 2);
document.querySelector("[data-testid=file-draft] button").click();
await new Promise((r) => setTimeout(r, 50));
assert.equal(document.querySelectorAll("[data-testid=file-draft]").length, 0);
assert.deepEqual(errors, []);
console.log("Konsta chat DOM: messages, IME, send and attachment draft passed");
host.close();
win.happyDOM.abort();
process.exit(0);
