import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A DOM implementation only: no Chromium, WebKit, network or real user state.
// Run after a web build. This test uses a DOM implementation, never a browser.
await (async () => {
  const win = new Window({
    url: "https://example.test/a2ui.html",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  win.SyntaxError = SyntaxError;
  const keys = [
    "window",
    "document",
    "navigator",
    "location",
    "customElements",
    "MutationObserver",
    "ResizeObserver",
    "HTMLElement",
    "HTMLMediaElement",
    "HTMLVideoElement",
    "HTMLAudioElement",
    "HTMLImageElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Text",
    "Comment",
    "DocumentFragment",
    "Document",
    "Event",
    "CustomEvent",
    "DOMParser",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
  ];
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const oldFetch = globalThis.fetch;
  try {
    for (const key of keys)
      if (key in win)
        Object.defineProperty(globalThis, key, {
          value:
            typeof win[key] === "function" &&
            [
              "getComputedStyle",
              "requestAnimationFrame",
              "cancelAnimationFrame",
              "matchMedia",
            ].includes(key)
              ? win[key].bind(win)
              : win[key],
          configurable: true,
          writable: true,
        });
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw new Error("Unexpected network request");
    };
    const heights = [];
    win.webkit = {
      messageHandlers: {
        a2uiHeight: { postMessage: (height) => heights.push(height) },
        a2uiReady: { postMessage: () => {} },
      },
    };
    document.body.innerHTML = '<div id="app"></div>';
    const html = await readFile("apps/web/build/a2ui.html", "utf8");
    const entry = html.match(
      /<script type="module" crossorigin src="([^"]+)/,
    )?.[1];
    assert.ok(entry);
    const stylesheet = html.match(
      /<link rel="stylesheet" crossorigin href="([^"]+)/,
    )?.[1];
    assert.ok(stylesheet);
    const style = document.createElement("style");
    style.textContent = await readFile(
      resolve("apps/web/build", "." + stylesheet),
      "utf8",
    );
    document.head.append(style);
    await import(pathToFileURL(resolve("apps/web/build", "." + entry)).href);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    assert.equal(typeof win.a2uiHost?.show, "function");
    const fixture = JSON.parse(
      await readFile("packages/contracts/fixtures/a2ui-v1.json", "utf8"),
    );
    fixture.createSurface.components.find((item) => item.id === "image").url =
      "/api/chat/media/example/preview";
    fixture.createSurface.components.find(
      (item) => item.id === "title",
    ).accessibility = {
      label: { "@path": "/label" },
      description: "Title description",
      live: "polite",
    };
    fixture.createSurface.components.find(
      (item) => item.id === "divider",
    ).accessibility = {
      label: "Divider label",
      description: "Divider description",
      live: "off",
    };
    fixture.createSurface.components.find(
      (item) => item.id === "modal",
    ).accessibility = {
      label: "Modal label",
      description: "Modal description",
      live: "polite",
    };
    fixture.createSurface.dataModel.label = "Title label";
    fixture.createSurface.dataModel.title =
      "**Bound title** [unsafe link](https://example.test/)";
    fixture.createSurface.components
      .find((item) => item.id === "tabs")
      .tabs.push({ title: "Second", child: "tab-second" });
    fixture.createSurface.components.push(
      {
        id: "tab-second",
        component: "Column",
        children: ["tab-second-text", "tab-second-image"],
      },
      {
        id: "tab-second-text",
        component: "Text",
        text: "Second content",
      },
      {
        id: "tab-second-image",
        component: "Image",
        url: "https://example.invalid/tab.png",
      },
    );
    win.a2uiHost.show(fixture, { locale: "en" });
    await settle();
    assert.ok(document.body.textContent.includes("Bound title"));
    assert.equal(document.querySelector(".a2ui-text-content a"), null);
    const title = document.querySelector(".a2ui-text-content");
    assert.equal(title?.getAttribute("aria-label"), "Title label");
    assert.equal(title?.getAttribute("aria-description"), "Title description");
    assert.equal(title?.getAttribute("aria-live"), "polite");
    const divider = document.querySelector(".a2ui-divider");
    assert.equal(divider?.getAttribute("aria-label"), "Divider label");
    assert.equal(
      divider?.getAttribute("aria-description"),
      "Divider description",
    );
    assert.equal(divider?.getAttribute("aria-live"), "off");
    assert.equal(
      document.querySelector(".a2ui-surface")?.hasAttribute("aria-live"),
      false,
    );
    assert.equal(
      document.querySelector("img")?.getAttribute("crossorigin"),
      "anonymous",
    );
    assert.equal(
      document.querySelector("img")?.getAttribute("src"),
      "cfl-media://load/%2Fapi%2Fchat%2Fmedia%2Fexample%2Fpreview",
    );
    assert.equal(document.querySelector("img")?.style.objectFit, "fill");
    assert.equal(
      document.querySelector("video")?.getAttribute("crossorigin"),
      "anonymous",
    );
    assert.equal(
      document.querySelector("audio")?.getAttribute("crossorigin"),
      "anonymous",
    );
    const absolute = structuredClone(fixture);
    absolute.createSurface.components.find((item) => item.id === "image").url =
      "https://example.test/api/chat/media/example/preview";
    win.a2uiHost.show(absolute, { locale: "en" });
    await settle();
    assert.equal(
      document.querySelector("img")?.getAttribute("src"),
      "cfl-media://load/%2Fapi%2Fchat%2Fmedia%2Fexample%2Fpreview",
    );
    const external = structuredClone(fixture);
    external.createSurface.components.find((item) => item.id === "image").url =
      "https://other.example/api/chat/media/example/preview";
    win.a2uiHost.show(external, { locale: "en" });
    await settle();
    assert.equal(
      document.querySelector("img")?.getAttribute("src"),
      "https://other.example/api/chat/media/example/preview",
    );
    const workspace = structuredClone(fixture);
    workspace.createSurface.components.find((item) => item.id === "image").url =
      "workspace:images%2F%2520.png";
    const video = workspace.createSurface.components.find(
      (item) => item.id === "video",
    );
    video.url = "workspace:clips%2Fdemo.mp4";
    video.posterUrl = "workspace:images%2Fposter.png";
    workspace.createSurface.components.find((item) => item.id === "audio").url =
      "workspace:music%2Fdemo.wav";
    win.a2uiHost.show(workspace, { locale: "en" });
    await settle();
    const bridged = (path) => `cfl-media://load/${encodeURIComponent(path)}`;
    assert.equal(
      document.querySelector("img")?.getAttribute("src"),
      bridged("/api/chat/workspace-image?path=images%2F%2520.png"),
    );
    assert.equal(
      document.querySelector("video")?.getAttribute("src"),
      bridged("/api/chat/workspace-media?kind=video&path=clips%2Fdemo.mp4"),
    );
    assert.equal(
      document.querySelector("video")?.getAttribute("poster"),
      bridged("/api/chat/workspace-image?path=images%2Fposter.png"),
    );
    assert.equal(
      document.querySelector("audio")?.getAttribute("src"),
      bridged("/api/chat/workspace-media?kind=audio&path=music%2Fdemo.wav"),
    );
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.length, 2);
    const firstPanel = document.querySelector('[role="tabpanel"]');
    assert.ok(firstPanel?.textContent.includes("Tab"));
    assert.equal(getComputedStyle(firstPanel).display, "flex");
    assert.equal(getComputedStyle(firstPanel).position, "static");
    assert.equal(getComputedStyle(firstPanel).width, "auto");
    assert.equal(getComputedStyle(firstPanel).height, "auto");
    tabs[1].click();
    await settle();
    assert.ok(
      document
        .querySelector('[role="tabpanel"]')
        ?.textContent.includes("Second content"),
    );
    const secondPanel = document.querySelector('[role="tabpanel"]');
    assert.equal(getComputedStyle(secondPanel).display, "flex");
    assert.ok(secondPanel.querySelector("img"));
    tabs[0].click();
    await settle();
    assert.ok(firstPanel.textContent.includes("Tab"));
    assert.equal(firstPanel.querySelector("img"), null);
    tabs[1].click();
    await settle();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Open",
    );
    assert.ok(open);
    open.click();
    await settle();
    assert.equal(Boolean(document.querySelector(".popup.modal-in")), true);
    assert.equal(
      document.querySelector(".popup.modal-in")?.getAttribute("aria-label"),
      "Modal label",
    );
    assert.equal(
      document
        .querySelector(".popup.modal-in")
        ?.getAttribute("aria-description"),
      "Modal description",
    );
    assert.equal(
      document.querySelector(".popup.modal-in")?.getAttribute("aria-live"),
      "polite",
    );
    assert.ok(heights.includes(480));
    const mediaBeforeOptions = document.querySelector("video");
    const sameContent = structuredClone(workspace);
    // The native bridge creates a fresh object; key order need not be stable.
    win.a2uiHost.show(
      {
        createSurface: sameContent.createSurface,
        version: sameContent.version,
      },
      { locale: "en", viewportHeight: 350, dark: true, fontScale: 1.2 },
    );
    await settle();
    assert.equal(Boolean(document.querySelector(".popup.modal-in")), true);
    assert.equal(document.querySelector("video"), mediaBeforeOptions);
    assert.ok(
      document
        .querySelector('[role="tabpanel"]')
        ?.textContent.includes("Second content"),
    );
    assert.ok(heights.includes(350));
    win.a2uiHost.show(external, { locale: "en", viewportHeight: 350 });
    await settle();
    assert.ok(heights.includes(350));
    assert.equal(fetches, 0);
    win.a2uiHost.show({ version: "invalid" }, { locale: "en" });
    await settle();
    assert.ok(
      document.body.textContent.includes("Unable to display this interface"),
    );
    assert.equal(Boolean(document.querySelector(".popup.modal-in")), false);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of originals)
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : delete globalThis[key];
    await win.happyDOM.abort();
  }
})();
console.log("A2UI embedded DOM checks passed");
