// Run against the adjacent CFL source and this checkout's built App. All state
// and credentials are synthetic; no native application callback is opened.
import { chromium, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const cfl = resolve(process.env.CFL_SOURCE ?? "../codex-for-love");
const { AuthStore } = await import(
  pathToFileURL(join(cfl, "apps/partner/runtime/auth.ts"))
);
const { createWebServer } = await import(
  pathToFileURL(join(cfl, "apps/partner/runtime/server.ts"))
);
const root = await mkdtemp(join(tmpdir(), "lamplit-cfl-auth-"));
const partner = { close: async () => {}, voiceCredential: () => null };
const options = {};
const app = createWebServer(partner, resolve("apps/web/build"), options);
let browser;
try {
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = app.server.address().port;
  const origin = `http://localhost:${port}`;
  options.auth = new AuthStore(root, origin);
  await options.auth.initialize();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.APP_ACCEPTANCE_BROWSER,
  });
  const context = await browser.newContext();
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
  const callbacks = [];
  await page.route("**/api/auth/oauth2/consent", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (
      body.redirect &&
      body.url?.startsWith("etosllmstudio://auth/callback")
    ) {
      callbacks.push(body.url);
      // Keep navigation in the fixture rather than invoking a native app.
      body.url = `${origin}/`;
    }
    await route.fulfill({ response, json: body });
  });
  const startAuthorization = async (state) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: "etos",
      redirect_uri: "etosllmstudio://auth/callback",
      response_type: "code",
      scope: "cfl offline_access",
      resource: origin,
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    if (state !== "first") query.set("prompt", "consent");
    await page.goto(`${origin}/api/auth/oauth2/authorize?${query}`);
    return verifier;
  };
  const verifier = await startAuthorization("first");
  await expect(
    page.getByRole("heading", { name: "Set up a passkey" }),
  ).toBeVisible();
  await page
    .getByLabel("One-time pairing code")
    .fill(options.auth.issuePairing());
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm access" }),
  ).toBeVisible();
  await expect(page.getByText("ETOS")).toBeVisible();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => callbacks.length).toBe(1);
  const approved = new URL(callbacks[0]);
  expect(approved.searchParams.get("state")).toBe("first");
  const token = await fetch(`${origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "etos",
      redirect_uri: "etosllmstudio://auth/callback",
      code: approved.searchParams.get("code"),
      code_verifier: verifier,
      resource: origin,
    }),
  });
  expect(token.status).toBe(200);
  expect((await token.json()).access_token).toBeTruthy();
  await page.waitForURL(`${origin}/`);
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  await startAuthorization("second");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm access" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const query = new URLSearchParams(location.search);
    query.set("sig", "invalid");
    history.replaceState(null, "", `${location.pathname}?${query}`);
  });
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid or expired");
  await expect(page.getByRole("button", { name: "Allow access" })).toHaveCount(
    0,
  );
  await startAuthorization("third");
  await expect(
    page.getByRole("heading", { name: "Confirm access" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => callbacks.length).toBe(2);
  const denied = new URL(callbacks[1]);
  expect(denied.searchParams.get("state")).toBe("third");
  expect(denied.searchParams.get("error")).toBeTruthy();

  const oldCookie = (await context.cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const recovery = await browser.newContext();
  const recoveryPage = await recovery.newPage();
  const recoveryCdp = await recovery.newCDPSession(recoveryPage);
  await recoveryCdp.send("WebAuthn.enable");
  await recoveryCdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await recoveryPage.goto(origin);
  await recoveryPage
    .getByRole("button", { name: "Recover with a pairing code" })
    .click();
  await recoveryPage
    .getByLabel("One-time pairing code")
    .fill(options.auth.issuePairing());
  const { DatabaseSync } = await import("node:sqlite");
  const expirePair = async (route) => {
    const db = new DatabaseSync(join(root, "auth.db"));
    try {
      db.prepare('UPDATE "authPairing" SET "expiresAt"=?').run(
        new Date(0).toISOString(),
      );
    } finally {
      db.close();
    }
    await route.continue();
  };
  await recoveryPage.route(
    "**/api/auth/passkey/generate-register-options",
    expirePair,
  );
  await recoveryPage.getByRole("button", { name: "Create passkey" }).click();
  await expect(recoveryPage.getByRole("alert")).toContainText(
    "invalid or expired",
  );
  await recoveryPage.unroute(
    "**/api/auth/passkey/generate-register-options",
    expirePair,
  );
  await recoveryPage
    .getByLabel("One-time pairing code")
    .fill(options.auth.issuePairing());
  await recoveryPage.getByRole("button", { name: "Create passkey" }).click();
  await expect
    .poll(
      async () =>
        (
          await recoveryPage.request
            .get(`${origin}/api/auth/status`)
            .then((r) => r.json())
        ).state,
    )
    .toBe("signed_in");
  const oldStatus = await fetch(`${origin}/api/auth/status`, {
    headers: { cookie: oldCookie },
  });
  expect((await oldStatus.json()).state).toBe("signed_out");
  await recovery.close();
  await context.close();
  console.log(
    "CFL + App: OAuth registration/login, allow, exchange, invalid consent, denial and recovery passed",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
