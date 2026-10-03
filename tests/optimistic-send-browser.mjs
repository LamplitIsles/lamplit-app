import { chromium, expect } from "@playwright/test";
import { createChatHost, imageHttp } from "../packages/contracts/src/server.ts";
import { imagesFixture } from "./images-fixture.ts";
import { staticAssets } from "./static-assets.mjs";
import { denyNativeNotifications } from "./notification-permission.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Synthetic-only admission gates: no live conversations, providers or OS permissions.
const gate = () => {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
};
const fixture = imagesFixture();
let uploadGate,
  submitGate,
  submitCalls = 0,
  lookupCalls = 0,
  mode = "normal",
  hidden = new Set(),
  hiddenRecovery = new Set();
const backend = {
  ...fixture.backend,
  async read() {
    const view = await fixture.backend.read();
    return {
      ...view,
      messages: view.messages.filter((m) => !hidden.has(m.operationId)),
      recovery: view.recovery.filter((r) => !hiddenRecovery.has(r.operationId)),
    };
  },
  async submit(input) {
    submitCalls++;
    if (submitGate) await submitGate.promise;
    if (mode === "rejected")
      return {
        operationId: input.operationId,
        state: "rejected",
        messageId: null,
        turnId: null,
        error: "not admitted",
      };
    if (mode === "missing") throw new Error("lost reply before admission");
    if (mode === "lost-accepted") hidden.add(input.operationId);
    if (mode === "durable-rejected") {
      hidden.add(input.operationId);
      hiddenRecovery.add(input.operationId);
      await fixture.control({ action: "mode", state: "rejected" });
    }
    const result = await fixture.backend.submit(input);
    if (mode === "lost-accepted") throw new Error("lost accepted reply");
    return result;
  },
  async lookup(id) {
    lookupCalls++;
    return fixture.backend.lookup(id);
  },
};
const host = await createChatHost(backend, () => {});
const channels = new Map();
const assets = resolve(process.env.APP_ACCEPTANCE_ASSETS ?? "apps/web/build");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/api/chat/socket" && server.upgrade(req)) return;
    const response = await imageHttp(
      req,
      {
        ...fixture.imageBackend,
        async upload(input) {
          if (uploadGate) await uploadGate.promise;
          return fixture.imageBackend.upload(input);
        },
      },
      async () => ({ sessionId: "fixture-session", limits: fixture.limits }),
    );
    return response ?? staticAssets(assets, path);
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
const evidence = resolve(
  process.env.APP_ACCEPTANCE_EVIDENCE ?? ".scratch/optimistic-send/browser",
);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
const results = [];
try {
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      await fixture.control({ action: "reset" });
      hidden.clear();
      hiddenRecovery.clear();
      mode = "normal";
      uploadGate = submitGate = undefined;
      submitCalls = lookupCalls = 0;
      await fixture.backend.submit({
        operationId: crypto.randomUUID(),
        text: "Normal sent reference",
      });
      await fixture.control({ action: "complete" });
      await host.refresh();
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        colorScheme: theme,
        locale: "zh-CN",
      });
      await context.addInitScript(denyNativeNotifications);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const input = page.locator("#companion-textarea");
      const send = page.getByRole("button", { name: "发送消息", exact: true });
      const choose = page.locator("#companion-image-library");
      const drafts = page.locator(".companion-image-draft-preview img");
      await input.fill("ready");
      await expect(send).toBeEnabled();
      await input.fill("");
      const image = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 180;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#8ab6b1";
        ctx.fillRect(0, 0, 180, 180);
        ctx.fillStyle = "#294b46";
        ctx.fillRect(40, 40, 100, 100);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      const file = {
        name: "echo.png",
        mimeType: "image/png",
        buffer: Buffer.from(image, "base64"),
      };
      const bubbleStyle = (locator) =>
        locator.evaluate((node) => {
          const bubble = node.closest(".message-bubble");
          const ancestors = [];
          for (let el = bubble; el; el = el.parentElement)
            ancestors.push(Number(getComputedStyle(el).opacity));
          return {
            opacity: getComputedStyle(bubble).opacity,
            color: getComputedStyle(bubble).backgroundColor,
            ancestors,
          };
        });
      const reference = await bubbleStyle(
        page.getByText("Normal sent reference", { exact: true }),
      );
      const snapshot = async (name) =>
        page.screenshot({
          path: `${evidence}/${name}-${theme}-${width}.png`,
          fullPage: true,
        });
      const echo = page.getByText("Immediate image and text", { exact: true });
      uploadGate = gate();
      submitGate = gate();
      await choose.setInputFiles(file);
      await input.fill("Immediate image and text");
      await send.click();
      await expect(input).toHaveValue("");
      await expect(drafts).toHaveCount(0);
      await expect(echo).toBeVisible();
      const echoImage = page.locator(".message-sent img").last();
      await expect
        .poll(() => echoImage.evaluate((img) => img.naturalWidth))
        .toBe(180);
      const heldStyle = await bubbleStyle(echo);
      expect(heldStyle.opacity).toBe("1");
      expect(heldStyle.ancestors.every((value) => value === 1)).toBe(true);
      expect(heldStyle.color).toBe(reference.color);
      expect(submitCalls).toBe(0);
      await expect(
        page
          .locator(".companion-meta")
          .filter({ hasText: /发送中|已接收|未消费|待确认|等待接收/ }),
      ).toHaveCount(0);
      await snapshot("held-upload");
      const persisted = await page.evaluate(() =>
        localStorage.getItem("lamplit.pending:fixture-session"),
      );
      expect(persisted).not.toContain("blob:");
      expect(persisted).not.toContain(image);
      uploadGate.release();
      uploadGate = undefined;
      await expect.poll(() => submitCalls).toBe(1);
      await expect(echo).toHaveCount(1);
      await expect(echoImage).toBeVisible();
      const receiptStyle = await bubbleStyle(echo);
      expect(receiptStyle.opacity).toBe("1");
      expect(receiptStyle.color).toBe(reference.color);
      const imageStyle = await bubbleStyle(echoImage);
      expect(imageStyle.ancestors.every((value) => value === 1)).toBe(true);
      await expect(page.locator(".toast")).toHaveCount(0);
      await snapshot("held-receipt");
      submitGate.release();
      submitGate = undefined;
      await expect
        .poll(
          async () => (await fixture.control({ action: "state" })).executions,
        )
        .toBe(2);
      await expect(echo).toHaveCount(1);
      await fixture.control({ action: "complete" });
      await host.refresh();

      // Offline click leaves text + image drafts and issues no submission.
      await choose.setInputFiles({ ...file, name: "offline.png" });
      await input.fill("Offline draft");
      for (const ws of channels.keys()) ws.terminate();
      await expect(send).toBeDisabled();
      const beforeOffline = submitCalls;
      await send.dispatchEvent("click");
      await expect(input).toHaveValue("Offline draft");
      await expect(drafts).toHaveCount(1);
      expect(submitCalls).toBe(beforeOffline);
      await snapshot("offline-draft");
      await expect(send).toBeEnabled({ timeout: 10000 });
      await page.getByRole("button", { name: "移除图片", exact: true }).click();
      await input.fill("");

      // Definitive rejection merges both failed and newer drafts; originals remain decodable.
      mode = "rejected";
      submitGate = gate();
      await choose.setInputFiles(file);
      await input.fill("Failed text");
      await send.click();
      await expect(
        page.getByText("Failed text", { exact: true }),
      ).toBeVisible();
      await choose.setInputFiles({ ...file, name: "newer.png" });
      await input.fill("Newer edit");
      submitGate.release();
      submitGate = undefined;
      await expect(input).toHaveValue("Failed text\nNewer edit");
      await expect(drafts).toHaveCount(2);
      await expect(page.getByText("Failed text", { exact: true })).toHaveCount(
        0,
      );
      expect(
        await drafts.evaluateAll((images) =>
          images.every((img) => img.naturalWidth === 180),
        ),
      ).toBe(true);
      await snapshot("failure-restored");
      for (let i = 0; i < 2; i++)
        await page
          .getByRole("button", { name: "移除图片", exact: true })
          .first()
          .click();
      await input.fill("");

      mode = "missing";
      const beforeMissing = lookupCalls;
      await input.fill("Missing admission");
      await send.click();
      await expect(input).toHaveValue("Missing admission");
      await expect(
        page.getByText("Missing admission", { exact: true }),
      ).toHaveCount(0);
      expect(lookupCalls - beforeMissing).toBe(2);
      await input.fill("");

      // Lost acknowledgement resolves by the same operation, with one echo and no replay.
      mode = "lost-accepted";
      const beforeAccepted = submitCalls;
      await input.fill("Accepted despite lost reply");
      await send.click();
      await expect(
        page.getByText("Accepted despite lost reply", { exact: true }),
      ).toHaveCount(1);
      await expect
        .poll(
          async () =>
            JSON.parse(
              await page.evaluate(() =>
                localStorage.getItem("lamplit.pending:fixture-session"),
              ),
            )[0]?.state,
        )
        .toBe("consumed");
      await expect(input).toHaveValue("");
      expect(submitCalls).toBe(beforeAccepted + 1);
      hidden.clear();
      await host.refresh();
      await expect(
        page.getByText("Accepted despite lost reply", { exact: true }),
      ).toHaveCount(1);
      await page.reload();
      await expect(
        page.getByText("Accepted despite lost reply", { exact: true }),
      ).toHaveCount(1);
      expect(submitCalls).toBe(beforeAccepted + 1);
      // Reload loses Files; settled missing references use the existing authorized restore path.
      const storedImages = (
        await fixture.control({ action: "state" })
      ).submissions.find(
        (value) => value.text === "Immediate image and text",
      ).images;
      const beforeRestore = submitCalls;
      await page.evaluate(
        ({ operationId, images }) =>
          localStorage.setItem(
            "lamplit.pending:fixture-session",
            JSON.stringify([
              {
                operationId,
                text: "Reloaded missing image",
                images,
                createdAt: Date.now(),
                state: "uncertain",
              },
            ]),
          ),
        { operationId: crypto.randomUUID(), images: storedImages },
      );
      await page.reload();
      await expect(page.getByTestId("input-recovery")).toBeVisible();
      await expect(
        page
          .locator(".message-sent")
          .filter({ hasText: "Reloaded missing image" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "恢复编辑", exact: true }).click();
      await expect(input).toHaveValue("Reloaded missing image");
      await expect(drafts).toHaveCount(1);
      await expect
        .poll(() => drafts.first().evaluate((img) => img.naturalWidth))
        .toBe(180);
      expect(submitCalls).toBe(beforeRestore);
      await page.getByRole("button", { name: "移除图片", exact: true }).click();
      await input.fill("");
      await page.getByRole("button", { name: "忽略", exact: true }).click();

      // A reloaded local replacement owns its record independently of native source S.
      const native = await fixture.control({ action: "nativeRecovery" });
      const source = native.recovery.at(-1).sourceId;
      const oldPending = crypto.randomUUID();
      await page.evaluate(
        ({ operationId, source }) =>
          localStorage.setItem(
            "lamplit.pending:fixture-session",
            JSON.stringify([
              {
                operationId,
                text: "Reloaded replacement",
                replacementSourceIds: [source],
                createdAt: Date.now(),
                state: "uncertain",
              },
            ]),
          ),
        { operationId: oldPending, source },
      );
      await page.reload();
      await expect(page.getByTestId("input-recovery")).toContainText(
        "原生恢复输入",
      );
      await page.getByRole("button", { name: "忽略", exact: true }).click();
      await expect(page.getByTestId("input-recovery")).toContainText(
        "Reloaded replacement",
      );
      await page.getByRole("button", { name: "恢复编辑", exact: true }).click();
      await input.fill("Edited replacement");
      mode = "rejected"; // Definite nonadmission restores the edited draft and S.
      const beforeReplacement = submitCalls;
      await send.click();
      await expect.poll(() => submitCalls).toBe(beforeReplacement + 1);
      await expect(input).toHaveValue("Edited replacement");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem("lamplit.pending:fixture-session"),
              ).length,
          ),
        )
        .toBe(0);

      // First durable rejection stays sent, despite replacing S, and is explicitly recoverable.
      mode = "durable-rejected";
      await send.click();
      await expect(input).toHaveValue("");
      const durableEcho = page
        .locator(".message-sent")
        .filter({ hasText: "Edited replacement" });
      await expect(durableEcho).toHaveCount(1);
      await expect(page.getByTestId("input-recovery")).toContainText(
        "Edited replacement",
      );
      const durableState = await fixture.control({ action: "state" });
      const durableInput = durableState.submissions.find(
        (value) => value.text === "Edited replacement",
      );
      expect(durableInput.replacementSourceIds).toEqual([source]);
      expect(durableState.recovery.map((r) => r.sourceId)).not.toContain(
        source,
      );
      expect(
        (await bubbleStyle(durableEcho.locator(".message-bubble"))).color,
      ).toBe(reference.color);
      expect(
        (await bubbleStyle(durableEcho.locator(".message-bubble"))).opacity,
      ).toBe("1");
      await snapshot("durable-rejected");
      await page.reload();
      await expect(durableEcho).toHaveCount(1);
      await expect(input).toHaveValue("");
      await expect(page.getByTestId("input-recovery")).toContainText(
        "Edited replacement",
      );
      expect(submitCalls).toBe(beforeReplacement + 2); // No execution replay on reload.
      await page.getByRole("button", { name: "恢复编辑", exact: true }).click();
      await expect(input).toHaveValue("Edited replacement");
      hiddenRecovery.clear(); // Native facts arrive before the explicit replacement is sent.
      await host.refresh();
      mode = "normal";
      await fixture.control({ action: "mode", state: "consumed" });
      await input.fill("Recovered durable input");
      await send.click();
      await expect(input).toHaveValue("");
      await expect
        .poll(async () =>
          (await fixture.control({ action: "state" })).submissions.some(
            (value) => value.text === "Recovered durable input",
          ),
        )
        .toBe(true);
      const finalState = await fixture.control({ action: "state" });
      expect(
        finalState.submissions.find(
          (value) => value.text === "Recovered durable input",
        ).replacementSourceIds,
      ).toEqual([durableInput.operationId]);
      expect(finalState.executions).toBe(durableState.executions + 1);
      await page.reload();
      await expect(page.getByTestId("input-recovery")).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("lamplit.pending:fixture-session"),
        ),
      ).not.toContain(oldPending);
      expect(submitCalls).toBe(beforeReplacement + 3);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      results.push({
        width,
        theme,
        reference,
        heldStyle,
        receiptStyle,
        imageStyle,
        submitCalls,
        lookupCalls,
        replacementRecovery: {
          source,
          oldPending,
          admittedOperation: durableInput.operationId,
          finalSources: finalState.submissions.find(
            (value) => value.text === "Recovered durable input",
          ).replacementSourceIds,
        },
        errors,
      });
      await context.close();
    }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    "Optimistic-send browser acceptance passed: immediate normal text/image echo before upload/receipt; offline drafts; rejection merge; settled missing rollback; lost accepted reply without replay; local replacement retirement and durable execution-failure own-source recovery/reload; light/dark 390/1280.",
  );
} finally {
  uploadGate?.release();
  submitGate?.release();
  await browser.close();
  host.close();
  for (const ws of channels.keys()) ws.terminate();
  server.unref();
  void server.stop(true);
}
