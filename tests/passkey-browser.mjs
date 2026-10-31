import { chromium, expect } from "@playwright/test";
import { staticAssets } from "./static-assets.mjs";
import { resolve } from "node:path";

let state = "setup";
let verified = 0;
let protectedRequests = 0;
const challenge = Buffer.alloc(32, 7).toString("base64url");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/auth/status")
      return state === "unavailable"
        ? new Response(null, { status: 503 })
        : state === "host"
          ? new Response(null, { status: 404 })
          : Response.json({ mode: "passkey", state });
    if (path === "/api/auth/register/options") {
      const { code } = await req.json();
      if (code !== "fixture-code")
        return Response.json(
          { error: { code: "invalid_pairing" } },
          { status: 401 },
        );
      return Response.json({
        ceremony: "fixture",
        options: {
          challenge,
          rp: { name: "Lamplit", id: "localhost" },
          user: { id: challenge, name: "owner", displayName: "Owner" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
        },
      });
    }
    if (path === "/api/auth/login/options")
      return Response.json({
        ceremony: "fixture",
        options: { challenge, rpId: "localhost", userVerification: "required" },
      });
    if (path.endsWith("/verify")) {
      const input = await req.json();
      if (!input.response?.id || input.ceremony !== "fixture")
        return new Response(null, { status: 400 });
      verified++;
      state = "signed_in";
      return Response.json({ ok: true });
    }
    if (path.startsWith("/api/chat/") || path.startsWith("/api/voice/"))
      protectedRequests++;
    return staticAssets(resolve("apps/web/build"), path);
  },
});
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  for (const width of [390, 1280]) {
    state = "setup";
    protectedRequests = 0;
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "en-US",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await page.goto(`http://localhost:${server.port}/`);
    await expect(
      page.getByRole("heading", { name: "Set up a passkey" }),
    ).toBeVisible();
    expect(protectedRequests).toBe(0);
    if (process.env.APP_AUTH_EVIDENCE)
      await page.screenshot({
        path: `${process.env.APP_AUTH_EVIDENCE}/setup-${width}.png`,
      });
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("One-time pairing code")).toBeFocused();
    await page.keyboard.type("wrong");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("invalid or expired");
    await page.getByLabel("One-time pairing code").fill("fixture-code");
    const beforeRegistration = verified;
    await page.getByRole("button", { name: "Create passkey" }).click();
    await expect.poll(() => verified).toBeGreaterThan(beforeRegistration);
    state = "signed_out";
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    if (process.env.APP_AUTH_EVIDENCE)
      await page.screenshot({
        path: `${process.env.APP_AUTH_EVIDENCE}/login-${width}.png`,
      });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect.poll(() => state).toBe("signed_in");
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toHaveCount(0);
    state = "signed_out";
    await page.evaluate(() =>
      localStorage.setItem("her.companion.language", "zh"),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    await page.evaluate(() =>
      localStorage.setItem("her.companion.language", "en"),
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Recover with a pairing code" })
      .click();
    await expect(page.getByLabel("One-time pairing code")).toBeVisible();
    await page.getByRole("button", { name: "Back to sign in" }).click();
    state = "signed_in";
    await page.reload();
    await expect(page.locator(".auth-page")).toHaveCount(0);
    state = "unavailable";
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText("Can't connect");
    state = "signed_in";
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".auth-page")).toHaveCount(0);
    state = "host";
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText("Can't connect");
    await context.close();
    console.log(
      `viewport ${width}: keyboard setup, invalid code, registration, sign-in, language change, expiration, recovery entry, transient failure and retry passed`,
    );
  }
  state = "host";
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.port}/`);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(
    0,
  );
  await expect.poll(() => page.locator(".auth-page").count()).toBe(0);
  await page.close();
  state = "signed_out";
  const cancelled = await browser.newPage();
  await cancelled.addInitScript(() => {
    navigator.credentials.get = async () => {
      throw new DOMException("Cancelled", "NotAllowedError");
    };
  });
  await cancelled.goto(`http://localhost:${server.port}/`);
  await cancelled
    .getByRole("button", { name: "Sign in with a passkey" })
    .click();
  await expect(cancelled.getByRole("alert")).toContainText("wasn't completed");
  await expect(
    cancelled.getByRole("button", { name: "Sign in with a passkey" }),
  ).toBeEnabled();
  await cancelled.close();
  state = "unavailable";
  const unavailable = await browser.newPage();
  await unavailable.goto(`http://localhost:${server.port}/`);
  await expect(unavailable.getByRole("alert")).toContainText("Can't connect");
  await expect(
    unavailable.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  await unavailable.close();
  console.log(
    "other-host entry, cancelled sign-in and unavailable service passed",
  );
  state = "signed_out";
  const unsupported = await browser.newPage();
  await unsupported.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
  });
  await unsupported.goto(`http://localhost:${server.port}/`);
  await unsupported
    .getByRole("button", { name: "Sign in with a passkey" })
    .click();
  await expect(unsupported.getByRole("alert")).toContainText(
    "Passkeys aren't available",
  );
  await unsupported.close();
  const insecure = await browser.newPage();
  await insecure.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { value: false });
  });
  await insecure.goto(`http://localhost:${server.port}/`);
  await insecure
    .getByRole("button", { name: "Sign in with a passkey" })
    .click();
  await expect(insecure.getByRole("alert")).toContainText(
    "Passkeys aren't available",
  );
  await insecure.close();
  state = "setup";
  const chinese = await browser.newContext({ locale: "zh-CN" });
  const chinesePage = await chinese.newPage();
  await chinesePage.goto(`http://localhost:${server.port}/`);
  await expect(
    chinesePage.getByRole("heading", { name: "设置 Passkey" }),
  ).toBeVisible();
  await expect(chinesePage.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await chinese.close();
  console.log(
    "unsupported browser, insecure context and initial Chinese language passed",
  );
  console.log(
    "Passkey UI pairing, sign-in, expiry, recovery and host entry passed.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
