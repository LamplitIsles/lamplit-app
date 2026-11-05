import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileHttp, fileStreamHttp } from "../packages/contracts/dist/server.js";
import {
  validateFileManifest,
  validateFileUploadResult,
} from "../packages/contracts/dist/index.js";

const limits = {
  maxFilesPerMessage: 6,
  maxFileBytes: 100_000_000,
  maxMessageFileBytes: 200_000_000,
};
const operationId = "00000000-0000-0000-0000-000000000001";
const manifest = {
  sessionId: "node-session",
  operationId,
  files: [0, 1].map((i) => ({
    id: `f${i}`,
    name: `file${i}`,
    mediaType: "",
    size: 100_000_000,
  })),
};
const owner = { ownerId: "node-owner", sessionId: "node-session", limits };
const base = "/api/chat/file-operations";
const op = `${base}/${operationId}`;

test("Node streams two exact 100 MB files and completes ordered refs", async () => {
  validateFileManifest(manifest, limits);
  assert.throws(() =>
    validateFileManifest(
      {
        ...manifest,
        files: [
          ...manifest.files,
          { id: "extra", name: "extra", mediaType: "", size: 1 },
        ],
      },
      limits,
    ),
  );
  const hashes = new Map();
  let status;
  const backend = {
    async reserve(input, _owner, check) {
      await check();
      return (status = { manifest: input, uploaded: [] });
    },
    async status() {
      return status ?? null;
    },
    async receive(_manifest, id, bytes, _owner, check) {
      const hash = createHash("sha256");
      for await (const chunk of bytes) hash.update(chunk);
      const digest = hash.digest("hex");
      await check();
      if (hashes.has(id) && hashes.get(id) !== digest) throw Error("conflict");
      hashes.set(id, digest);
      if (!status.uploaded.includes(id)) status.uploaded.push(id);
    },
    async complete(input, _owner, check) {
      await check();
      return (status.result = {
        sessionId: input.sessionId,
        operationId: input.operationId,
        files: input.files.map((f, order) => ({
          id: f.id,
          order,
          ref: {
            attachmentId: `stored${order}`,
            name: f.name,
            mediaType: f.mediaType,
            size: f.size,
            availability: "available",
          },
        })),
      });
    },
  };
  const call = async (path, init) =>
    await fileStreamHttp(
      new Request(`http://fixture${path}`, init),
      backend,
      async () => owner,
    );
  assert.equal(
    (
      await call(base, {
        method: "POST",
        headers: {
          origin: "http://fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(manifest),
      })
    ).status,
    200,
  );
  const chunk = new Uint8Array(64_000);
  chunk.fill(0xa7);
  let total = 0;
  const before = process.memoryUsage().rss;
  let peak = before;
  for (const file of manifest.files) {
    let sent = 0,
      pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls % 50 === 0) peak = Math.max(peak, process.memoryUsage().rss);
        const n = Math.min(chunk.length, file.size - sent);
        if (!n) return controller.close();
        sent += n;
        controller.enqueue(chunk.subarray(0, n));
      },
    });
    const response = await call(`${op}/files/${file.id}`, {
      method: "PUT",
      headers: {
        origin: "http://fixture",
        "content-type": "application/octet-stream",
      },
      body,
      duplex: "half",
    });
    assert.equal(response.status, 204);
    assert.equal(sent, file.size);
    assert.ok(pulls > 1000);
    total += sent;
  }
  assert.equal(total, 200_000_000);
  assert.equal(hashes.size, 2);
  assert.equal(hashes.get("f0"), hashes.get("f1"));
  assert.equal(
    hashes.get("f0"),
    "fd90860b11170be7e0ce8bbb807fd6b88ad2997f8f36ad09ca2ffb433e551ab3",
  );
  const response = await call(`${op}/complete`, {
    method: "POST",
    headers: { origin: "http://fixture" },
  });
  const result = validateFileUploadResult(await response.json(), manifest);
  assert.deepEqual(
    result.files.map((f) => f.id),
    ["f0", "f1"],
  );
  assert.ok(peak - before < 100_000_000, `RSS grew ${peak - before} bytes`);
  console.log(
    `Node synthetic 200 MB peak RSS increase: ${peak - before} bytes`,
  );
});

test("Node streaming download is authenticated and old JSON endpoint is not mounted", async () => {
  const bytes = new Uint8Array([0, 255, 1]);
  const backend = {
    async fileStream(id, owner) {
      assert.equal(owner.ownerId, "node-owner");
      if (id !== "f0") return null;
      return {
        size: bytes.length,
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
  };
  const auth = async () => owner;
  assert.equal(
    await fileHttp(
      new Request("http://fixture/api/chat/files", { method: "POST" }),
      backend,
      auth,
    ),
    undefined,
  );
  assert.equal(
    (
      await fileHttp(
        new Request("http://fixture/api/chat/files/f0"),
        backend,
        async () => null,
      )
    ).status,
    401,
  );
  const response = await fileHttp(
    new Request("http://fixture/api/chat/files/f0"),
    backend,
    auth,
  );
  assert.equal(response.headers.get("content-disposition"), "attachment");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});
