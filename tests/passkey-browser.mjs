import { chromium, expect } from "@playwright/test";
import { staticAssets } from "./static-assets.mjs";
import { resolve } from "node:path";

let state = "setup";
let verified = 0;
let protectedRequests = 0;
let lastOAuthQuery;
let consentDecision;
let pairingExpired = false;
let consentErrorStatus = 0;
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
    if (path === "/api/auth/pairing") {
      const { code } = await req.json();
      if (code !== "fixture-code")
        return Response.json(
          { error: { code: "invalid_pairing" } },
          { status: 401 },
        );
      return Response.json(
        { ok: true },
        {
          headers: {
            "set-cookie": "pairing=fixture; HttpOnly; SameSite=Strict; Path=/",
          },
        },
      );
    }
    if (path === "/api/auth/consent-details") {
      const { oauth_query } = await req.json();
      if (oauth_query !== "sig=fixture&ba_param=state&state=fixture")
        return Response.json(
          { error: { code: "invalid_oauth_request" } },
          { status: 400 },
        );
      return Response.json({
        client: { id: "etos", name: "ETOS" },
        scopes: ["cfl"],
      });
    }
    if (path === "/api/auth/oauth2/consent") {
      const input = await req.json();
      if (consentErrorStatus)
        return Response.json(
          { error: "invalid_request" },
          { status: consentErrorStatus },
        );
      lastOAuthQuery = input.oauth_query;
      consentDecision = input.accept;
      return Response.json({ ok: true });
    }
    if (path === "/api/auth/passkey/generate-register-options") {
      if (!req.headers.get("cookie")?.includes("pairing=fixture"))
        return new Response(null, { status: 401 });
      return Response.json({
        challenge,
        rp: { name: "Lamplit", id: "localhost" },
        user: { id: challenge, name: "owner", displayName: "Owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });
    }
    if (path === "/api/auth/passkey/generate-authenticate-options")
      return Response.json({
        challenge,
        rpId: "localhost",
        userVerification: "required",
      });
    if (
      path === "/api/auth/passkey/verify-registration" ||
      path === "/api/auth/passkey/verify-authentication"
    ) {
      const input = await req.json();
      if (path.endsWith("verify-registration") && pairingExpired)
        return Response.json(
          {
            code: "INVALID_PAIRING",
            message: "Pairing code is invalid or expired.",
          },
          { status: 401 },
        );
      if (
        !input.response?.id ||
        (path.endsWith("verify-registration") && input.createSession !== true)
      )
        return new Response(null, { status: 400 });
      verified++;
      lastOAuthQuery = input.oauth_query;
      state = "signed_in";
      return Response.json({
        id: "fixture",
        session: { id: "session" },
        user: { id: "owner" },
      });
    }
    if (path.startsWith("/api/chat/") || path.startsWith("/api/voice/"))
      protectedRequests++;
    return staticAssets(
      resolve("apps/web/build"),
      path === "/consent" ? "/" : path,
    );
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
    await page.goto(
      `http://localhost:${server.port}/?sig=fixture&ba_param=state&state=fixture`,
    );
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
    expect(lastOAuthQuery).toContain("state=fixture");
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
    expect(lastOAuthQuery).toContain("state=fixture");
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
    await page.getByLabel("One-time pairing code").fill("fixture-code");
    pairingExpired = true;
    await page.getByRole("button", { name: "Create passkey" }).click();
    await expect(page.getByRole("alert")).toContainText("invalid or expired");
    pairingExpired = false;
    const beforeRecovery = verified;
    await page.getByRole("button", { name: "Create passkey" }).click();
    await expect.poll(() => verified).toBeGreaterThan(beforeRecovery);
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
  state = "signed_in";
  const consent = await browser.newPage();
  await consent.goto(
    `http://localhost:${server.port}/consent?sig=fixture&ba_param=state&state=fixture`,
  );
  await expect(
    consent.getByRole("heading", { name: "Confirm access" }),
  ).toBeVisible();
  await expect(consent.getByText("ETOS")).toBeVisible();
  await expect(
    consent.getByText("Access and operate your CFL data"),
  ).toBeVisible();
  if (process.env.APP_AUTH_EVIDENCE)
    await consent.screenshot({
      path: `${process.env.APP_AUTH_EVIDENCE}/consent.png`,
    });
  await consent.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => consentDecision).toBe(true);
  expect(lastOAuthQuery).toContain("state=fixture");
  await consent.close();
  consentDecision = undefined;
  const deniedConsent = await browser.newPage();
  await deniedConsent.goto(
    `http://localhost:${server.port}/consent?sig=fixture&ba_param=state&state=fixture`,
  );
  await deniedConsent.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => consentDecision).toBe(false);
  await deniedConsent.close();
  const expiredConsent = await browser.newPage();
  await expiredConsent.goto(
    `http://localhost:${server.port}/consent?sig=fixture&ba_param=state&state=fixture`,
  );
  await expect(
    expiredConsent.getByRole("button", { name: "Allow access" }),
  ).toBeVisible();
  consentErrorStatus = 400;
  await expiredConsent.getByRole("button", { name: "Allow access" }).click();
  await expect(expiredConsent.getByRole("alert")).toContainText(
    "invalid or expired",
  );
  await expect(
    expiredConsent.getByRole("button", { name: "Allow access" }),
  ).toHaveCount(0);
  consentErrorStatus = 0;
  await expiredConsent.close();
  const retryConsent = await browser.newPage();
  await retryConsent.goto(
    `http://localhost:${server.port}/consent?sig=fixture&ba_param=state&state=fixture`,
  );
  const allowRetry = retryConsent.getByRole("button", { name: "Allow access" });
  await expect(allowRetry).toBeVisible();
  consentErrorStatus = 503;
  await allowRetry.click();
  await expect(retryConsent.getByRole("alert")).toContainText(
    "Check your connection",
  );
  await expect(allowRetry).toBeEnabled();
  consentErrorStatus = 0;
  consentDecision = undefined;
  await allowRetry.click();
  await expect.poll(() => consentDecision).toBe(true);
  await retryConsent.close();
  const mobileConsent = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  const mobileConsentPage = await mobileConsent.newPage();
  await mobileConsentPage.goto(
    `http://localhost:${server.port}/consent?sig=fixture&ba_param=state&state=fixture`,
  );
  await expect(
    mobileConsentPage.getByRole("heading", { name: "确认访问权限" }),
  ).toBeVisible();
  await expect(mobileConsentPage.locator("html")).toHaveAttribute(
    "lang",
    "zh-Hans",
  );
  await mobileConsentPage.keyboard.press("Tab");
  await expect(
    mobileConsentPage.getByRole("button", { name: "允许访问" }),
  ).toBeFocused();
  if (process.env.APP_AUTH_EVIDENCE)
    await mobileConsentPage.screenshot({
      path: `${process.env.APP_AUTH_EVIDENCE}/consent-mobile.png`,
    });
  await mobileConsent.close();
  const invalidConsent = await browser.newPage();
  await invalidConsent.goto(
    `http://localhost:${server.port}/consent?sig=tampered`,
  );
  await expect(invalidConsent.getByRole("alert")).toContainText(
    "invalid or expired",
  );
  await expect(
    invalidConsent.getByRole("button", { name: "Allow access" }),
  ).toHaveCount(0);
  await invalidConsent.close();
  console.log("validated consent display, approval and invalid request passed");
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
