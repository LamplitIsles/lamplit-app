import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";

// A real intercepted request stays in flight while interception removal begins.
const server = createServer((request, response) =>
  response.end(request.url === "/" ? "<title>waiting</title>" : "restored"),
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  executablePath: process.env.APP_ACCEPTANCE_BROWSER,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let settled = false;
  await page.route("**/original", async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
    settled = true;
  });
  await page.evaluate(() => {
    void fetch("/original")
      .then((r) => r.text())
      .then((text) => {
        document.title = text;
      });
  });
  await entered;
  const removed = page.unrouteAll({ behavior: "wait" });
  // Browser round trip leaves the handler deliberately held; no timing sleep.
  await page.evaluate(() => document.title);
  expect(settled).toBe(false);
  release();
  await removed;
  await expect(page).toHaveTitle("restored");
  expect(settled).toBe(true);
  console.log(
    "Route lifecycle regression passed: fulfillment settles before interception removal.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
