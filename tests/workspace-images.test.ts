import { expect, test } from "bun:test";
import {
  parseWorkspaceImagePath,
  workspaceImageUrl,
  WORKSPACE_IMAGE_PATH,
  validate,
  ViewSchema,
  capabilities,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

test("workspace destinations decode once and round-trip as literal query paths", () => {
  for (const [source, path] of [
    ["plots/a.png", "plots/a.png"],
    ["/workspace/a.JPG", "/workspace/a.JPG"],
    ["./图%20片.webp", "./图 片.webp"],
    ["plots/%E7%81%AF.gif", "plots/灯.gif"],
    ["plots/%2520.png", "plots/%20.png"],
    ["plots/%23%3F%26.png", "plots/#?&.png"],
  ]) {
    expect(parseWorkspaceImagePath(source!)).toBe(path);
    const url = new URL(workspaceImageUrl(source!)!, "https://fixture");
    expect(url.pathname).toBe(WORKSPACE_IMAGE_PATH);
    expect(url.searchParams.get("path")).toBe(path);
  }
});
test("invalid/local-URI/shared-media destinations never become workspace requests", () => {
  for (const source of [
    "",
    "a.svg",
    "a.png?x=1",
    "a%QQ.png",
    "%FF.png",
    "//host/a.png",
    "%2F%2Fhost/a.png",
    "file:/tmp/a.png",
    "https://host/a.png",
    "data:image/png,a.png",
    "C:/a.png",
    "a\\b.png",
    "a%00.png",
    "a%0A.png",
    "a%7F.png",
    "/api/chat/media/id/original.png",
    "%2Fapi/a.png",
    "\ud800.png",
  ]) {
    expect(parseWorkspaceImagePath(source)).toBeNull();
    expect(workspaceImageUrl(source)).toBeNull();
  }
});
test("workspace support is optional literal true, independent of uploads", async () => {
  const view = await fixtureBackend().backend.read();
  expect(
    validate(ViewSchema, view).capabilities.workspaceImages,
  ).toBeUndefined();
  expect(
    validate(ViewSchema, {
      ...view,
      capabilities: { ...capabilities, workspaceImages: true },
    }).capabilities.workspaceImages,
  ).toBe(true);
  expect(() =>
    validate(ViewSchema, {
      ...view,
      capabilities: { ...capabilities, workspaceImages: false },
    }),
  ).toThrow();
});
